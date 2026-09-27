/**
 * « Comparer des fichiers » — the results, as Acrobat shows them: a summary of
 * what changed, filters, the changes grouped by page, and the two versions of
 * the selected page side by side with every change highlighted (red: removed,
 * on the original; green: added, on the revision; blue: formatting; orange:
 * images and drawings). Navigation moves both sides together.
 *
 * The view runs the comparison itself on the two open documents it is given
 * (`left`: the current document as compared, `right`: the other file); the
 * caller owns both engines and destroys them when the view closes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileDown, FileText, Loader2, LocateFixed } from "lucide-react";
import { Modal } from "../../ui/components";
import type { PdfEngine } from "../core/engine";
import { normRotation, rectToView, type Rect, type Size } from "../core/coords";
import {
  DIFF_LABEL,
  describeItem,
  pageTitle,
  type DetailedPage,
  type DetailedReport,
  type DiffCategory,
  type DiffItem,
} from "../ops/compare";
import { canvasRasteriser, compareFiles, type PageRasteriser } from "../ops/compare-visual";
import type { PagePicture } from "../ops/compare-report";

export interface CompareViewProps {
  /** The current document as compared, and the other file — null until one is picked. */
  left: PdfEngine | null;
  right: PdfEngine | null;
  leftName: string;
  rightName: string;
  /** The other file is being opened. */
  busy?: boolean;
  onPick: () => void;
  /** « Aller à la page »: a 1-based page of `left` (the compared document). */
  onGoTo: (page: number) => void;
  /** The « Rapport PDF » is ready: save / download it. */
  onSaveReport: (bytes: Uint8Array, fileName: string) => void;
  onClose: () => void;
  /** Rasteriser of the visual comparison (default: pdf.js into a canvas). */
  rasterise?: PageRasteriser;
  /** Page pictures of the report (default: `canvasPictures(left, right)`). */
  pictures?: PagePicture;
}

const CATEGORIES: { key: DiffCategory; label: string }[] = [
  { key: "text", label: "Texte" },
  { key: "format", label: "Mise en forme" },
  { key: "image", label: "Images" },
  { key: "page", label: "Pages" },
];

type Tone = "removed" | "added" | "format" | "image" | "page";

function toneOf(it: DiffItem, side: "left" | "right"): Tone {
  if (it.category === "format") return "format";
  if (it.category === "image") return "image";
  if (it.category === "page") return it.kind === "added" ? "added" : it.kind === "removed" ? "removed" : "page";
  return side === "left" ? "removed" : "added";
}

export function CompareView(props: CompareViewProps) {
  const { left, right, leftName, rightName, busy, onPick, onGoTo, onSaveReport, onClose } = props;
  const [report, setReport] = useState<DetailedReport | null>(null);
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Set<DiffCategory>>(() => new Set(CATEGORIES.map((c) => c.key)));
  const [pairAt, setPairAt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const rasterise = props.rasterise ?? canvasRasteriser;
  const rasteriseRef = useRef(rasterise);
  rasteriseRef.current = rasterise;

  // Run the comparison whenever a new pair of documents comes in.
  useEffect(() => {
    setReport(null);
    setError(null);
    setPairAt(0);
    setSelected(null);
    if (!left || !right) return;
    const abort = new AbortController();
    setProgress({ phase: "texte", done: 0, total: left.pageCount + right.pageCount });
    compareFiles(left, right, {
      render: rasteriseRef.current,
      signal: abort.signal,
      onProgress: (phase, done, total) => {
        if (!abort.signal.aborted) setProgress({ phase, done, total });
      },
    })
      .then((r) => {
        if (!abort.signal.aborted) setReport(r);
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setError(e instanceof Error && e.message ? e.message : "Comparaison impossible.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setProgress(null);
      });
    return () => abort.abort();
  }, [left, right]);

  /** Pages with something visible under the current filters. */
  const pages = useMemo(() => {
    if (!report) return [];
    return report.pages
      .map((p) => ({ page: p, items: p.items.filter((it) => filters.has(it.category)) }))
      .filter((p) => p.items.length > 0);
  }, [report, filters]);

  const current = pages[Math.min(pairAt, Math.max(0, pages.length - 1))];

  const toggle = (k: DiffCategory) =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const counts = useMemo(() => {
    const c: Record<DiffCategory, number> = { text: 0, format: 0, image: 0, page: 0 };
    for (const p of report?.pages ?? []) for (const it of p.items) c[it.category]++;
    return c;
  }, [report]);

  const makeReport = async () => {
    if (!report || !left || !right) return;
    setReporting(true);
    try {
      const { buildCompareReport, canvasPictures } = await import("../ops/compare-report");
      const bytes = await buildCompareReport(report, {
        leftName,
        rightName,
        picture: props.pictures ?? canvasPictures(left, right),
      });
      const base = leftName.replace(/\.pdf$/i, "") || "document";
      onSaveReport(bytes, `${base}-comparaison.pdf`);
    } catch (e) {
      setError(e instanceof Error && e.message ? `Rapport impossible : ${e.message}` : "Rapport impossible.");
    } finally {
      setReporting(false);
    }
  };

  const title = "Comparer des fichiers";
  if (!left || !right) {
    return (
      <Modal title={title} onClose={onClose} wide>
        <div className="pdfx-form">
          <p className="pdfx-form__lead">Choisissez la version à comparer avec le document ouvert.</p>
          <button className="eb eb--primary eb--sm" onClick={onPick} disabled={busy}>
            {busy ? (
              <>
                <Loader2 size={14} className="pdfx-spin" /> Ouverture…
              </>
            ) : (
              <>
                <FileText size={14} /> Choisir un PDF…
              </>
            )}
          </button>
        </div>
      </Modal>
    );
  }

  if (!report) {
    return (
      <Modal title={title} onClose={onClose} wide>
        <div className="pdfx-cmp pdfx-cmp--busy">
          {error ? (
            <>
              <p className="pdfx-cmp__error">{error}</p>
              <button className="eb eb--outline eb--sm" onClick={onPick}>
                <FileText size={14} /> Choisir un autre PDF…
              </button>
            </>
          ) : (
            <p>
              <Loader2 size={16} className="pdfx-spin" />{" "}
              {progress?.phase === "images" ? "Comparaison des images et dessins…" : "Analyse du texte…"}{" "}
              {progress && progress.total > 0 && (
                <span>
                  {progress.done} / {progress.total}
                </span>
              )}
            </p>
          )}
        </div>
      </Modal>
    );
  }

  const stats: [string, number | string, Tone | null][] = [
    ["pages modifiées", report.pagesModified, null],
    ["pages ajoutées", report.pagesAdded, "added"],
    ["pages supprimées", report.pagesRemoved, "removed"],
    ["pages déplacées", report.pagesMoved, "page"],
    ["mots", `+${report.wordsAdded} / −${report.wordsRemoved}`, null],
    ["mise en forme", report.formatChanges, "format"],
    ["images", report.imageChanges, "image"],
  ];
  const textless = report.pages.filter((p) => p.textless).length;

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="pdfx-cmp">
        <div className="pdfx-cmp__files">
          <span className="is-left" title={leftName}>
            {leftName}
          </span>
          <span className="is-right" title={rightName}>
            {rightName}
          </span>
        </div>
        <div className="pdfx-compare__stats">
          {stats.map(([label, n, tone]) => (
            <div key={label} className={tone ? `pdfx-cmp__stat is-${tone}` : "pdfx-cmp__stat"}>
              <b>{n}</b>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <div className="pdfx-cmp__bar">
          <div className="pdfx-cmp__filters" role="group" aria-label="Filtres">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                className={`pdfx-cmp__chip is-${c.key}${filters.has(c.key) ? " is-on" : ""}`}
                aria-pressed={filters.has(c.key)}
                onClick={() => toggle(c.key)}
              >
                {c.label} <span>{counts[c.key]}</span>
              </button>
            ))}
          </div>
          <div className="pdfx-cmp__actions">
            <button
              className="eb eb--ghost eb--sm"
              disabled={!current?.page.leftPage}
              onClick={() => current?.page.leftPage && onGoTo(current.page.leftPage)}
            >
              <LocateFixed size={14} /> Aller à la page
            </button>
            <button className="eb eb--outline eb--sm" disabled={reporting} onClick={() => void makeReport()}>
              {reporting ? <Loader2 size={14} className="pdfx-spin" /> : <FileDown size={14} />} Rapport PDF
            </button>
          </div>
        </div>
        {error && <p className="pdfx-cmp__error">{error}</p>}
        {textless > 0 && (
          <p className="pdfx-form__note">
            {textless} page(s) sans texte (images ou numérisations) ont été comparées visuellement.
          </p>
        )}

        {!pages.length ? (
          <p className="pdfx-empty">
            {report.pages.some((p) => p.items.length)
              ? "Aucune différence pour les filtres choisis."
              : "Les deux documents sont identiques."}
          </p>
        ) : (
          <div className="pdfx-cmp__main">
            <div className="pdfx-cmp__list">
              {pages.map((p, k) => (
                <section key={k} className={`pdfx-cmp__group${k === pairAt ? " is-current" : ""}`}>
                  <button
                    className="pdfx-cmp__grouphead"
                    onClick={() => {
                      setPairAt(k);
                      setSelected(null);
                    }}
                  >
                    {pageTitle(p.page)}
                    <span>{p.items.length}</span>
                  </button>
                  <ul>
                    {p.items.map((it) => (
                      <li key={it.id}>
                        <button
                          className={`pdfx-cmp__item is-${toneOf(it, it.kind === "delete" ? "left" : "right")}${
                            it.id === selected ? " is-selected" : ""
                          }`}
                          onClick={() => {
                            setPairAt(k);
                            setSelected(it.id);
                          }}
                        >
                          <b>{DIFF_LABEL[it.kind]}</b>
                          <span>{describeItem(it)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            {current && (
              <div className="pdfx-cmp__viewer">
                <div className="pdfx-cmp__nav">
                  <button
                    className="eb eb--ghost eb--sm"
                    disabled={pairAt <= 0}
                    onClick={() => {
                      setPairAt((i) => Math.max(0, i - 1));
                      setSelected(null);
                    }}
                  >
                    <ChevronLeft size={14} /> Précédente
                  </button>
                  <span>
                    {pageTitle(current.page)} — {Math.min(pairAt, pages.length - 1) + 1} / {pages.length}
                  </span>
                  <button
                    className="eb eb--ghost eb--sm"
                    disabled={pairAt >= pages.length - 1}
                    onClick={() => {
                      setPairAt((i) => Math.min(pages.length - 1, i + 1));
                      setSelected(null);
                    }}
                  >
                    Suivante <ChevronRight size={14} />
                  </button>
                </div>
                <SideBySide
                  left={left}
                  right={right}
                  page={current.page}
                  items={current.items}
                  selected={selected}
                  onSelect={setSelected}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The two versions of a page pair, scrolled together. */
function SideBySide({
  left,
  right,
  page,
  items,
  selected,
  onSelect,
}: {
  left: PdfEngine;
  right: PdfEngine;
  page: DetailedPage;
  items: DiffItem[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const panes = useRef<(HTMLDivElement | null)[]>([null, null]);
  const syncing = useRef(false);
  const onScroll = (from: 0 | 1) => {
    if (syncing.current) {
      syncing.current = false;
      return;
    }
    const a = panes.current[from];
    const b = panes.current[1 - from];
    if (!a || !b) return;
    const ratio = a.scrollTop / Math.max(1, a.scrollHeight - a.clientHeight);
    syncing.current = true;
    b.scrollTop = ratio * Math.max(0, b.scrollHeight - b.clientHeight);
  };
  return (
    <div className="pdfx-cmp__sides">
      {(["left", "right"] as const).map((side, k) => (
        <div key={side} className="pdfx-cmp__side">
          <div className="pdfx-cmp__sidehead">
            {side === "left" ? "Original" : "Révisé"}
            {(side === "left" ? page.leftPage : page.rightPage) !== null &&
              ` — page ${side === "left" ? page.leftPage : page.rightPage}`}
          </div>
          <div
            className="pdfx-cmp__pane"
            ref={(el) => {
              panes.current[k] = el;
            }}
            onScroll={() => onScroll(k as 0 | 1)}
          >
            <PagePane
              engine={side === "left" ? left : right}
              index={side === "left" ? page.leftPage : page.rightPage}
              side={side}
              whole={
                (page.status === "added" && side === "right") || (page.status === "removed" && side === "left")
                  ? page.status
                  : null
              }
              items={items}
              selected={selected}
              onSelect={onSelect}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** One page drawn into a canvas, the changes over it. */
function PagePane({
  engine,
  index,
  side,
  whole,
  items,
  selected,
  onSelect,
}: {
  engine: PdfEngine;
  /** 1-based, null = no page on this side. */
  index: number | null;
  side: "left" | "right";
  whole: "added" | "removed" | null;
  items: DiffItem[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [geom, setGeom] = useState<{ size: Size; rotation: 0 | 90 | 180 | 270; scale: number } | null>(null);

  // Fit the page to the pane's width.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(120, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setGeom(null);
    const target = canvasHost.current;
    target?.replaceChildren();
    if (index === null || !width || !target) return;
    let cancelled = false;
    const i = index - 1;
    (async () => {
      const { renderToCanvas } = await import("../core/render");
      const proxy = await engine.page(i);
      const rotation = normRotation(proxy.rotate);
      const base = proxy.getViewport({ scale: 1, rotation: 0 });
      const size = { w: base.width, h: base.height };
      const viewW = rotation % 180 === 0 ? size.w : size.h;
      const scale = width / viewW;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const canvas = await renderToCanvas(proxy, { scale: scale * dpr, rotation, background: "#ffffff" });
      if (cancelled) {
        canvas.width = canvas.height = 0;
        return;
      }
      canvas.style.width = `${canvas.width / dpr}px`;
      canvas.style.height = `${canvas.height / dpr}px`;
      target.replaceChildren(canvas);
      setGeom({ size, rotation, scale });
      engine.releasePageResources(i);
    })().catch(() => {
      if (!cancelled) target.replaceChildren();
    });
    return () => {
      cancelled = true;
    };
  }, [engine, index, width]);

  // Bring the selected change into view.
  useEffect(() => {
    if (!selected || !geom) return;
    host.current
      ?.querySelector<HTMLElement>(`[data-item="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected, geom]);

  if (index === null)
    return (
      <div ref={host} className="pdfx-cmp__page is-missing">
        Pas de page correspondante
      </div>
    );

  const toView = (r: Rect): React.CSSProperties => {
    if (!geom) return { display: "none" };
    const v = rectToView(r, geom.size, geom.rotation);
    return {
      left: v.x * geom.scale - 1,
      top: v.y * geom.scale - 1,
      width: Math.max(3, v.w * geom.scale + 2),
      height: Math.max(3, v.h * geom.scale + 2),
    };
  };

  return (
    <div ref={host} className={`pdfx-cmp__page${whole ? ` is-${whole}` : ""}`}>
      <div ref={canvasHost} />
      {!geom && (
        <div className="pdfx-cmp__loading">
          <Loader2 size={16} className="pdfx-spin" />
        </div>
      )}
      {items.flatMap((it) =>
        (side === "left" ? it.leftRects : it.rightRects).map((r, k) => (
          <button
            key={`${it.id}-${k}`}
            data-item={k === 0 ? it.id : undefined}
            className={`pdfx-cmp__mark is-${toneOf(it, side)}${it.id === selected ? " is-selected" : ""}`}
            style={toView(r)}
            title={`${DIFF_LABEL[it.kind]} — ${describeItem(it)}`}
            aria-label={DIFF_LABEL[it.kind]}
            onClick={() => onSelect(it.id)}
          />
        )),
      )}
    </div>
  );
}
