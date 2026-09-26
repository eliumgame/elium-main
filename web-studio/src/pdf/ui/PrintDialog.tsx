import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Printer } from "lucide-react";
import { Modal } from "../../ui/components";
import { PdfEngine } from "../core/engine";
import { renderToCanvas } from "../core/render";
import {
  DEFAULT_PRINT_OPTIONS,
  PRINT_PAPERS,
  describeSheets,
  imposeForPrint,
  resolvePageSpec,
  type BookletSides,
  type ContentMode,
  type NupOrder,
  type NupPreset,
  type PageSubset,
  type PrintLayout,
  type PrintOptions,
  type PrintOrientation,
  type PrintPaper,
  type SizeScaling,
} from "../ops/impose";

/**
 * Acrobat's print dialog: which pages, « Taille et gestion des pages »
 * (Taille / Multiple / Livret / Affiche), orientation, comments and forms,
 * « Imprimer comme image », with a live preview of the imposed sheets.
 *
 * The dialog only prepares the bytes: `buildSource` supplies the print-ready
 * document for a content mode, `onPrint` sends the imposed result to the
 * printer (the workspace's hidden-iframe printing, rasterised when asked).
 */

const PAPER_LABEL: Record<PrintPaper, string> = {
  page: "Taille de la page",
  A4: "A4",
  A3: "A3",
  A5: "A5",
  Letter: "Lettre US",
  Legal: "Légal US",
};

const CONTENT_LABEL: Record<ContentMode, string> = {
  document: "Document",
  markups: "Document et annotations",
  stamps: "Document et tampons",
  forms: "Champs de formulaire uniquement",
};

const LAYOUT_LABEL: Record<PrintLayout, string> = {
  size: "Taille",
  multiple: "Multiple",
  booklet: "Livret",
  poster: "Affiche",
};

const ORDER_LABEL: Record<NupOrder, string> = {
  horizontal: "Horizontal",
  horizontalReversed: "Horizontal inversé",
  vertical: "Vertical",
  verticalReversed: "Vertical inversé",
};

/** Last layout choices, remembered in this browser (the page choice is not). */
const STORE_KEY = "elium.pdf.print";

type Remembered = Omit<PrintOptions, "pages" | "range" | "currentPage" | "labels">;

function loadRemembered(): Partial<Remembered> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Remembered>) : {};
  } catch {
    return {};
  }
}

function saveRemembered(o: PrintOptions): void {
  try {
    const rest: Partial<PrintOptions> = { ...o };
    delete rest.pages;
    delete rest.range;
    delete rest.currentPage;
    delete rest.labels;
    localStorage.setItem(STORE_KEY, JSON.stringify(rest));
  } catch {
    /* storage unavailable: nothing remembered */
  }
}

function initialOptions(currentPage: number, labels?: readonly string[]): PrintOptions {
  const r = loadRemembered();
  const d = DEFAULT_PRINT_OPTIONS;
  return {
    ...d,
    ...r,
    size: { ...d.size, ...r.size },
    multiple: { ...d.multiple, ...r.multiple },
    booklet: { ...d.booklet, ...r.booklet, sheetFrom: 1, sheetTo: 0 },
    poster: { ...d.poster, ...r.poster },
    pages: "all",
    range: "",
    currentPage,
    labels,
  };
}

/** Preview size of a sheet, in CSS pixels. */
const PREVIEW_W = 220;
const PREVIEW_H = 250;

export function PrintDialog({
  pageCount,
  currentPage,
  labels,
  pageSizes,
  imageOnly,
  buildSource,
  onPrint,
  onClose,
}: {
  pageCount: number;
  /** 0-based. */
  currentPage: number;
  /** The document's page labels, if it has any (accepted in the range field). */
  labels?: readonly string[];
  /** Displayed page sizes in points, for the poster sheet count. */
  pageSizes?: readonly (readonly [number, number])[];
  /** Only low-resolution printing is allowed: the pages print as images anyway. */
  imageOnly?: boolean;
  buildSource: (mode: ContentMode) => Promise<Uint8Array>;
  onPrint: (bytes: Uint8Array, asImage: boolean) => void;
  onClose: () => void;
}) {
  const [opts, setOpts] = useState<PrintOptions>(() => initialOptions(currentPage, labels));
  const set = (patch: Partial<PrintOptions>) => setOpts((o) => ({ ...o, ...patch }));
  const setSize = (patch: Partial<PrintOptions["size"]>) => setOpts((o) => ({ ...o, size: { ...o.size, ...patch } }));
  const setMulti = (patch: Partial<PrintOptions["multiple"]>) =>
    setOpts((o) => ({ ...o, multiple: { ...o.multiple, ...patch } }));
  const setBooklet = (patch: Partial<PrintOptions["booklet"]>) =>
    setOpts((o) => ({ ...o, booklet: { ...o.booklet, ...patch } }));
  const setPoster = (patch: Partial<PrintOptions["poster"]>) =>
    setOpts((o) => ({ ...o, poster: { ...o.poster, ...patch } }));

  const summary = useMemo(() => describeSheets(opts, pageCount, pageSizes), [opts, pageCount, pageSizes]);
  const rangePages = useMemo(
    () => (opts.pages === "range" ? resolvePageSpec(opts.range, pageCount, labels) : []),
    [opts.pages, opts.range, pageCount, labels],
  );
  const rangeEmpty = opts.pages === "range" && !rangePages.length;
  // With page labels, the pages the range picked are spelled out (« 3-9 » mixes a label and a page number).
  const rangeHint =
    labels?.length && rangePages.length && opts.range.trim()
      ? `${rangePages.length} page(s) : ${rangePages
          .slice(0, 12)
          .map((i) => (labels[i] ? `${labels[i]} (${i + 1})` : String(i + 1)))
          .join(", ")}${rangePages.length > 12 ? "…" : ""}`
      : "";
  const problem = rangeEmpty
    ? "Aucune page ne correspond à cette plage."
    : !summary.pages
      ? "Aucune page à imprimer (vérifiez le sous-ensemble)."
      : "";
  // What the imposition depends on (« Imprimer comme image » is applied afterwards).
  const key = useMemo(() => JSON.stringify({ ...opts, asImage: false }), [opts]);

  // --- imposed result and preview ----------------------------------------
  const sources = useRef(new Map<ContentMode, Promise<Uint8Array>>());
  const [result, setResult] = useState<{ key: string; bytes: Uint8Array } | null>(null);
  const [engine, setEngine] = useState<PdfEngine | null>(null);
  const [sheet, setSheet] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [failure, setFailure] = useState("");
  const [printing, setPrinting] = useState(false);
  const canvasHost = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const engineRef = useRef<PdfEngine | null>(null);

  const source = (mode: ContentMode): Promise<Uint8Array> => {
    let p = sources.current.get(mode);
    if (!p) {
      p = buildSource(mode);
      sources.current.set(mode, p);
      p.catch(() => sources.current.delete(mode));
    }
    return p;
  };

  const impose = async (o: PrintOptions) => imposeForPrint(await source(o.content), o);

  useEffect(() => {
    if (problem) return;
    const gen = ++generation.current;
    const timer = setTimeout(() => {
      setPreparing(true);
      setFailure("");
      void impose(opts)
        .then(async (bytes) => {
          if (gen !== generation.current) return;
          setResult({ key, bytes });
          const next = await PdfEngine.open(bytes);
          if (gen !== generation.current) {
            next.destroy();
            return;
          }
          const old = engineRef.current;
          engineRef.current = next;
          setEngine(next);
          old?.destroy();
          setSheet((s) => Math.min(s, next.pageCount - 1));
        })
        .catch(() => gen === generation.current && setFailure("Aperçu impossible pour ces réglages."))
        .finally(() => gen === generation.current && setPreparing(false));
    }, 300);
    return () => clearTimeout(timer);
    // `impose` reads the latest `opts`; `key` stands for them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, problem]);

  // The preview engine goes with the dialog.
  useEffect(
    () => () => {
      generation.current++;
      engineRef.current?.destroy();
    },
    [],
  );

  useEffect(() => {
    const host = canvasHost.current;
    if (!engine || !host) return;
    let cancelled = false;
    const index = Math.max(0, Math.min(engine.pageCount - 1, sheet));
    void (async () => {
      try {
        const page = await engine.page(index);
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        const canvas = await renderToCanvas(page, {
          scale: 2 * ratio,
          maxWidth: (PREVIEW_W - 16) * ratio,
          maxHeight: (PREVIEW_H - 16) * ratio,
        });
        if (cancelled) return;
        canvas.style.width = `${canvas.width / ratio}px`;
        canvas.style.height = `${canvas.height / ratio}px`;
        host.replaceChildren(canvas);
      } catch {
        /* the engine was replaced while rendering */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, sheet]);

  const sheetCount = engine?.pageCount ?? 0;
  const stale = !result || result.key !== key;

  const print = async () => {
    if (problem || printing) return;
    setPrinting(true);
    try {
      const bytes = !stale && result ? result.bytes : await impose(opts);
      saveRemembered(opts);
      onPrint(bytes, imageOnly || opts.asImage);
    } catch {
      setFailure("Impossible de préparer l'impression avec ces réglages.");
    } finally {
      setPrinting(false);
    }
  };

  const currentLabel = labels?.[currentPage] || String(currentPage + 1);
  const layout = opts.layout;
  const sheetsText =
    layout === "booklet"
      ? `${summary.sheets} face${summary.sheets > 1 ? "s" : ""} sur ${summary.paperSheets} feuille${summary.paperSheets > 1 ? "s" : ""}`
      : `${summary.sheets} feuille${summary.sheets > 1 ? "s" : ""}`;

  return (
    <Modal
      title="Imprimer"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" disabled={!!problem || printing} onClick={() => void print()}>
            {printing ? <Loader2 size={14} className="pdfx-spin" /> : <Printer size={14} />} Imprimer
          </button>
        </>
      }
    >
      <div className="pdfx-print">
        <div className="pdfx-form">
          <fieldset className="pdfx-form__set">
            <legend>Pages à imprimer</legend>
            <div className="pdfx-print__choices">
              <label className="pdfx-check">
                <input type="radio" checked={opts.pages === "all"} onChange={() => set({ pages: "all" })} />
                Toutes ({pageCount})
              </label>
              <label className="pdfx-check">
                <input type="radio" checked={opts.pages === "current"} onChange={() => set({ pages: "current" })} />
                Page courante ({currentLabel})
              </label>
              <label className="pdfx-check pdfx-print__range">
                <input type="radio" checked={opts.pages === "range"} onChange={() => set({ pages: "range" })} />
                Pages
                <input
                  value={opts.range}
                  placeholder={labels?.length ? `${labels[0]}-${labels[labels.length - 1]}` : `1-${pageCount}`}
                  onFocus={() => set({ pages: "range" })}
                  onChange={(e) => set({ pages: "range", range: e.target.value })}
                  aria-label="Plage de pages"
                  title={
                    labels?.length
                      ? "Étiquettes de page ou numéros de page, par exemple « iii-2, 5 »"
                      : "Par exemple « 1-3, 5, 8- »"
                  }
                />
              </label>
              {rangeHint && <p className="pdfx-print__hint">{rangeHint}</p>}
            </div>
            <label className="pdfx-form__row">
              <span>Sous-ensemble</span>
              <select
                value={opts.subset}
                disabled={layout === "booklet"}
                onChange={(e) => set({ subset: e.target.value as PageSubset })}
              >
                <option value="all">Toutes les pages de la plage</option>
                <option value="odd">Pages impaires seulement</option>
                <option value="even">Pages paires seulement</option>
              </select>
            </label>
            <label className="pdfx-check">
              <input
                type="checkbox"
                checked={opts.reverse}
                disabled={layout === "booklet"}
                onChange={(e) => set({ reverse: e.target.checked })}
              />
              Inverser l'ordre des pages
            </label>
          </fieldset>

          <fieldset className="pdfx-form__set">
            <legend>Taille et gestion des pages</legend>
            <div className="pdfx-segment pdfx-segment--wide" role="tablist">
              {(Object.keys(LAYOUT_LABEL) as PrintLayout[]).map((l) => (
                <button
                  key={l}
                  role="tab"
                  aria-selected={layout === l}
                  className={layout === l ? "is-on" : ""}
                  onClick={() => set({ layout: l })}
                >
                  {LAYOUT_LABEL[l]}
                </button>
              ))}
            </div>

            <label className="pdfx-form__row">
              <span>Papier</span>
              <select value={opts.paper} onChange={(e) => set({ paper: e.target.value as PrintPaper })}>
                {PRINT_PAPERS.map((p) => (
                  <option key={p} value={p}>
                    {PAPER_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="pdfx-form__row">
              <span>Orientation</span>
              <select
                value={layout === "booklet" ? "landscape" : opts.orientation}
                disabled={layout === "booklet"}
                onChange={(e) => set({ orientation: e.target.value as PrintOrientation })}
              >
                <option value="auto">Portrait / paysage automatique</option>
                <option value="portrait">Portrait</option>
                <option value="landscape">Paysage</option>
              </select>
            </label>

            {layout === "size" && (
              <>
                <div className="pdfx-print__choices">
                  {(
                    [
                      ["fit", "Ajuster"],
                      ["shrink", "Réduire les pages trop grandes"],
                      ["actual", "Taille réelle"],
                    ] as [SizeScaling, string][]
                  ).map(([v, label]) => (
                    <label key={v} className="pdfx-check">
                      <input type="radio" checked={opts.size.scaling === v} onChange={() => setSize({ scaling: v })} />
                      {label}
                    </label>
                  ))}
                  <label className="pdfx-check pdfx-print__range">
                    <input
                      type="radio"
                      checked={opts.size.scaling === "custom"}
                      onChange={() => setSize({ scaling: "custom" })}
                    />
                    Échelle personnalisée
                    <span className="pdfx-form__suffixed">
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={opts.size.scale}
                        onFocus={() => setSize({ scaling: "custom" })}
                        onChange={(e) => setSize({ scaling: "custom", scale: Number(e.target.value) || 100 })}
                        aria-label="Échelle en pourcentage"
                      />
                      <em>%</em>
                    </span>
                  </label>
                </div>
                <label className="pdfx-check">
                  <input
                    type="checkbox"
                    checked={opts.size.center}
                    onChange={(e) => setSize({ center: e.target.checked })}
                  />
                  Centrer sur la feuille
                </label>
                <label
                  className="pdfx-check"
                  title={opts.orientation === "auto" ? "En orientation automatique, la feuille suit déjà la page." : ""}
                >
                  <input
                    type="checkbox"
                    checked={opts.size.autoRotate}
                    disabled={opts.orientation === "auto"}
                    onChange={(e) => setSize({ autoRotate: e.target.checked })}
                  />
                  Faire pivoter les pages pour remplir la feuille
                </label>
              </>
            )}

            {layout === "multiple" && (
              <>
                <label className="pdfx-form__row">
                  <span>Pages par feuille</span>
                  <select
                    value={String(opts.multiple.perSheet)}
                    onChange={(e) =>
                      setMulti({
                        perSheet: (e.target.value === "custom" ? "custom" : Number(e.target.value)) as NupPreset,
                      })
                    }
                  >
                    {[2, 4, 6, 9, 16].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                    <option value="custom">Personnalisé…</option>
                  </select>
                </label>
                {opts.multiple.perSheet === "custom" && (
                  <div className="pdfx-form__row">
                    <span>Grille</span>
                    <span className="pdfx-form__suffixed">
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={opts.multiple.cols}
                        onChange={(e) => setMulti({ cols: Number(e.target.value) || 1 })}
                        aria-label="Colonnes"
                      />
                      <em>colonnes ×</em>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={opts.multiple.rows}
                        onChange={(e) => setMulti({ rows: Number(e.target.value) || 1 })}
                        aria-label="Lignes"
                      />
                      <em>lignes</em>
                    </span>
                  </div>
                )}
                <label className="pdfx-form__row">
                  <span>Ordre des pages</span>
                  <select value={opts.multiple.order} onChange={(e) => setMulti({ order: e.target.value as NupOrder })}>
                    {(Object.keys(ORDER_LABEL) as NupOrder[]).map((o) => (
                      <option key={o} value={o}>
                        {ORDER_LABEL[o]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="pdfx-form__row">
                  <span>Marges</span>
                  <span className="pdfx-form__suffixed">
                    <input
                      type="number"
                      min={0}
                      max={50}
                      value={opts.multiple.marginMm}
                      onChange={(e) => setMulti({ marginMm: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <em>mm</em>
                  </span>
                </label>
                <label className="pdfx-check">
                  <input
                    type="checkbox"
                    checked={opts.multiple.border}
                    onChange={(e) => setMulti({ border: e.target.checked })}
                  />
                  Imprimer la bordure des pages
                </label>
                <label className="pdfx-check">
                  <input
                    type="checkbox"
                    checked={opts.multiple.autoRotate}
                    onChange={(e) => setMulti({ autoRotate: e.target.checked })}
                  />
                  Rotation automatique des pages
                </label>
              </>
            )}

            {layout === "booklet" && (
              <>
                <label className="pdfx-form__row">
                  <span>Sous-ensemble</span>
                  <select
                    value={opts.booklet.sides}
                    onChange={(e) => setBooklet({ sides: e.target.value as BookletSides })}
                  >
                    <option value="both">Recto verso</option>
                    <option value="front">Recto seulement</option>
                    <option value="back">Verso seulement</option>
                  </select>
                </label>
                <label className="pdfx-form__row">
                  <span>Reliure</span>
                  <select
                    value={opts.booklet.binding}
                    onChange={(e) => setBooklet({ binding: e.target.value as "left" | "right" })}
                  >
                    <option value="left">Gauche</option>
                    <option value="right">Droite</option>
                  </select>
                </label>
                <div className="pdfx-form__row">
                  <span>Feuilles</span>
                  <span className="pdfx-form__suffixed">
                    <em>de</em>
                    <input
                      type="number"
                      min={1}
                      value={opts.booklet.sheetFrom}
                      onChange={(e) => setBooklet({ sheetFrom: Math.max(1, Number(e.target.value) || 1) })}
                      aria-label="Première feuille"
                    />
                    <em>à</em>
                    <input
                      type="number"
                      min={0}
                      value={opts.booklet.sheetTo || ""}
                      placeholder="fin"
                      onChange={(e) => setBooklet({ sheetTo: Math.max(0, Number(e.target.value) || 0) })}
                      aria-label="Dernière feuille"
                    />
                  </span>
                </div>
                <p className="pdfx-form__note">
                  Imprimez recto verso en retournant sur le bord court, puis pliez les feuilles au centre. Des pages
                  blanches complètent le livret à un multiple de quatre.
                </p>
              </>
            )}

            {layout === "poster" && (
              <>
                <label className="pdfx-form__row">
                  <span>Échelle</span>
                  <span className="pdfx-form__suffixed">
                    <input
                      type="number"
                      min={1}
                      max={2000}
                      value={opts.poster.scale}
                      onChange={(e) => setPoster({ scale: Math.max(1, Number(e.target.value) || 100) })}
                    />
                    <em>%</em>
                  </span>
                </label>
                <label className="pdfx-form__row">
                  <span>Chevauchement</span>
                  <span className="pdfx-form__suffixed">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={opts.poster.overlapMm}
                      onChange={(e) => setPoster({ overlapMm: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <em>mm</em>
                  </span>
                </label>
                <label className="pdfx-check">
                  <input
                    type="checkbox"
                    checked={opts.poster.cutMarks}
                    onChange={(e) => setPoster({ cutMarks: e.target.checked })}
                  />
                  Repères de coupe
                </label>
                <label className="pdfx-check">
                  <input
                    type="checkbox"
                    checked={opts.poster.labels}
                    onChange={(e) => setPoster({ labels: e.target.checked })}
                  />
                  Étiquettes (« A1 », ligne et colonne)
                </label>
                <label className="pdfx-check">
                  <input
                    type="checkbox"
                    checked={opts.poster.largeOnly}
                    onChange={(e) => setPoster({ largeOnly: e.target.checked })}
                  />
                  Ne diviser que les grandes pages
                </label>
              </>
            )}
          </fieldset>

          <fieldset className="pdfx-form__set">
            <legend>Commentaires et formulaires</legend>
            <label className="pdfx-form__row">
              <span>Contenu imprimé</span>
              <select value={opts.content} onChange={(e) => set({ content: e.target.value as ContentMode })}>
                {(Object.keys(CONTENT_LABEL) as ContentMode[]).map((m) => (
                  <option key={m} value={m}>
                    {CONTENT_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>

            <label className="pdfx-check">
              <input
                type="checkbox"
                checked={imageOnly || opts.asImage}
                disabled={imageOnly}
                onChange={(e) => set({ asImage: e.target.checked })}
              />
              Imprimer comme image
            </label>
            {imageOnly && (
              <p className="pdfx-form__note">
                Ce document n'autorise que l'impression en basse résolution : les pages sont imprimées comme images (150
                ppp).
              </p>
            )}
          </fieldset>
          {(problem || failure) && <p className="pdfx-form__error">{problem || failure}</p>}
        </div>

        <div className="pdfx-print__preview" aria-live="polite">
          <div className="pdfx-print__sheet" style={{ width: PREVIEW_W, height: PREVIEW_H }}>
            <div ref={canvasHost} className={`pdfx-print__canvas ${stale ? "is-stale" : ""}`} />
            {(preparing || (!engine && !problem && !failure)) && (
              <Loader2 size={22} className="pdfx-spin pdfx-print__busy" />
            )}
          </div>
          <div className="pdfx-print__nav">
            <button
              className="pdfx-mini"
              disabled={!engine || sheet <= 0}
              onClick={() => setSheet((s) => Math.max(0, s - 1))}
              aria-label="Feuille précédente"
            >
              <ChevronLeft size={14} />
            </button>
            <span>{sheetCount ? `Feuille ${Math.min(sheet, sheetCount - 1) + 1} sur ${sheetCount}` : "—"}</span>
            <button
              className="pdfx-mini"
              disabled={!engine || sheet >= sheetCount - 1}
              onClick={() => setSheet((s) => Math.min(sheetCount - 1, s + 1))}
              aria-label="Feuille suivante"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <p className="pdfx-print__summary">
            {summary.pages} page{summary.pages > 1 ? "s" : ""} · {sheetsText}
          </p>
        </div>
      </div>
    </Modal>
  );
}
