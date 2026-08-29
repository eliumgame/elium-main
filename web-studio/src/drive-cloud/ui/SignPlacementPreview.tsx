/**
 * Aperçu de la page 1 d'un PDF distant, pour que le destinataire d'un lien de
 * signature (anonyme, sans compte — voir `SignLinkView.tsx`) choisisse où sa
 * signature doit apparaître. Clic = emplacement par défaut ; glisser = rectangle
 * choisi. Sans choix, l'appelant garde le comportement historique (signature
 * invisible).
 *
 * Rendu minimal : ce composant n'a besoin que d'UNE page rasterisée en image,
 * pas de la géométrie de tout le document ni des champs de formulaire que
 * `PdfEngine.open` (pdf/core/engine.ts) calcule pour l'espace de travail local —
 * l'ouvrir ici serait disproportionné pour un simple aperçu de placement. On
 * appelle donc pdfjs-dist directement (comme `PdfEngine.open` le fait), mais on
 * réutilise le primitif de rendu partagé `renderToCanvas` de `pdf/core/render.ts`
 * pour rasteriser la page — pas de logique de rendu réinventée. Tout est chargé
 * dynamiquement pour ne pas alourdir ce chunk public tant qu'aucun PDF n'est
 * réellement affiché (même logique que les imports différés de pades/self-cert
 * dans `SignLinkView.tsx`).
 */
import { useEffect, useId, useRef, useState } from "react";
import { Loader } from "lucide-react";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import type { Pt, Rect, Size } from "../../pdf/core/coords";
import { rectFromPoints } from "../../pdf/core/coords";

const PREVIEW_MAX_WIDTH = 480;
/** En-deça de ce déplacement (px écran), un geste est traité comme un clic. */
const DRAG_THRESHOLD_PX = 4;
/** Pas de déplacement au clavier, en points PDF (espace page) — Maj = pas large. */
const ARROW_STEP_PT = 4;
const ARROW_STEP_PT_FAST = 24;

/** Texte annoncé par le lecteur d'écran : reflète l'emplacement courant (ou son
 *  absence) pour l'alternative clavier, qui n'a pas de retour visuel de survol. */
function describePlacement(r: Rect | null, size: Size | null): string {
  if (!r || !size) {
    return (
      "Aucun emplacement choisi. Avec le focus sur la zone de la page, appuyez sur une flèche ou sur Entrée " +
      "pour placer votre signature au centre, puis déplacez-la avec les flèches (Maj+flèche pour un pas plus large)."
    );
  }
  const xPct = Math.round((r.x / size.w) * 100);
  const yPct = Math.round((r.y / size.h) * 100);
  return (
    `Signature placée à ${xPct} % du bord gauche et ${yPct} % du haut de la page. ` +
    "Flèches pour déplacer, Suppr pour effacer le placement."
  );
}

function clampRect(r: Rect, size: Size): Rect {
  const w = Math.min(Math.max(1, r.w), size.w);
  const h = Math.min(Math.max(1, r.h), size.h);
  return {
    x: Math.min(Math.max(r.x, 0), size.w - w),
    y: Math.min(Math.max(r.y, 0), size.h - h),
    w,
    h,
  };
}

function defaultRectAt(centre: Pt, size: Size, ratio: number): Rect {
  const w = Math.min(160, size.w * 0.4);
  const h = w / (ratio || 3);
  return clampRect({ x: centre.x - w / 2, y: centre.y - h / 2, w, h }, size);
}

export function SignPlacementPreview({
  bytes,
  markSrc,
  markRatio,
  value,
  onChange,
  disabled,
}: {
  /** Octets du PDF (page 1 uniquement est rendue). */
  bytes: Uint8Array;
  /** PNG (data URL) de la marque à prévisualiser à l'emplacement choisi. */
  markSrc: string;
  /** Largeur / hauteur naturelle de `markSrc`, pour un rectangle par défaut cohérent. */
  markRatio: number;
  /** Rectangle choisi, en espace page (points PDF, origine haut-gauche) — ou `null`. */
  value: Rect | null;
  onChange: (rect: Rect | null) => void;
  disabled?: boolean;
}) {
  const [pageImgSrc, setPageImgSrc] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<Size | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const liveId = useId();

  useEffect(() => {
    let cancelled = false;
    // `destroy()` (abort + free the worker) lives on the LOADING TASK, not on
    // the resolved PDFDocumentProxy — kept in the effect's closure so the
    // cleanup below can call it even if unmount races the load.
    let task: PDFDocumentLoadingTask | undefined;
    (async () => {
      try {
        const [pdfjs, { renderToCanvas }, workerUrlMod] = await Promise.all([
          import("pdfjs-dist"),
          import("../../pdf/core/render"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrlMod.default;
        task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true });
        const doc = await task.promise;
        if (cancelled) return;
        const page = await doc.getPage(1);
        if (cancelled) {
          page.cleanup();
          return;
        }
        const base = page.getViewport({ scale: 1, rotation: 0 });
        const scale = Math.min(1, PREVIEW_MAX_WIDTH / base.width);
        const canvas = await renderToCanvas(page, { scale, rotation: 0 });
        if (cancelled) return;
        setPageImgSrc(canvas.toDataURL("image/png"));
        setPageSize({ w: base.width, h: base.height });
        page.cleanup();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Aperçu de la page indisponible.");
      }
    })();
    return () => {
      cancelled = true;
      // Libère le worker/document pdf.js — pas de rendu ni de document en
      // attente une fois le composant démonté ou `bytes` changé.
      void task?.destroy();
    };
  }, [bytes]);

  const toPagePt = (clientX: number, clientY: number): Pt | null => {
    const img = imgRef.current;
    if (!img || !pageSize) return null;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = Math.min(Math.max(((clientX - r.left) / r.width) * pageSize.w, 0), pageSize.w);
    const y = Math.min(Math.max(((clientY - r.top) / r.height) * pageSize.h, 0), pageSize.h);
    return { x, y };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !pageSize) return;
    const wrap = wrapRef.current;
    const start = toPagePt(e.clientX, e.clientY);
    if (!wrap || !start) return;
    wrap.setPointerCapture(e.pointerId);
    const startClient = { x: e.clientX, y: e.clientY };
    let last = start;
    let moved = false;
    setDraft({ x: start.x, y: start.y, w: 0, h: 0 });

    const move = (ev: PointerEvent) => {
      const p = toPagePt(ev.clientX, ev.clientY);
      if (!p) return;
      last = p;
      if (
        !moved &&
        (Math.abs(ev.clientX - startClient.x) > DRAG_THRESHOLD_PX ||
          Math.abs(ev.clientY - startClient.y) > DRAG_THRESHOLD_PX)
      ) {
        moved = true;
      }
      setDraft(rectFromPoints(start, p));
    };
    const finish = () => {
      wrap.removeEventListener("pointermove", move);
      wrap.removeEventListener("pointerup", finish);
      wrap.removeEventListener("pointercancel", finish);
      setDraft(null);
      if (!pageSize) return;
      const rect = moved ? clampRect(rectFromPoints(start, last), pageSize) : defaultRectAt(start, pageSize, markRatio);
      onChange(rect.w < 8 || rect.h < 8 ? defaultRectAt(start, pageSize, markRatio) : rect);
    };
    wrap.addEventListener("pointermove", move);
    wrap.addEventListener("pointerup", finish);
    wrap.addEventListener("pointercancel", finish);
  };

  // Alternative clavier au glisser-déposer souris/tactile ci-dessus : mêmes
  // deux gestes ("clic = emplacement par défaut", "glisser = déplacement"),
  // rejoués au clavier. Première flèche/Entrée sans placement = pose le
  // rectangle par défaut au centre (équivalent du clic) ; flèches ensuite =
  // déplacement (équivalent du glisser) ; Suppr = "Effacer le placement".
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !pageSize) return;
    const centre = { x: pageSize.w / 2, y: pageSize.h / 2 };
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        if (!value) {
          onChange(defaultRectAt(centre, pageSize, markRatio));
          break;
        }
        const step = e.shiftKey ? ARROW_STEP_PT_FAST : ARROW_STEP_PT;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        onChange(clampRect({ ...value, x: value.x + dx, y: value.y + dy }, pageSize));
        break;
      }
      case "Enter":
      case " ":
        if (!value) {
          e.preventDefault();
          onChange(defaultRectAt(centre, pageSize, markRatio));
        }
        break;
      case "Delete":
      case "Backspace":
        if (value) {
          e.preventDefault();
          onChange(null);
        }
        break;
      default:
        break;
    }
  };

  const shown = draft ?? value;

  return (
    <div style={{ marginTop: 6 }}>
      {error && (
        <p className="dc-error" style={{ fontSize: 12 }}>
          {error}
        </p>
      )}
      {!error && !(pageImgSrc && pageSize) && (
        <p className="muted" style={{ fontSize: 12 }}>
          <Loader size={13} className="dc-spin" /> Chargement de l'aperçu de la page…
        </p>
      )}
      {pageImgSrc && pageSize && (
        <>
          <div
            ref={wrapRef}
            className="dc-sign-placement"
            role="group"
            aria-label="Emplacement de la signature sur la page 1"
            aria-describedby={liveId}
            tabIndex={disabled ? -1 : 0}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            style={{
              position: "relative",
              display: "inline-block",
              maxWidth: "100%",
              lineHeight: 0,
              border: "1px solid var(--border, rgba(127,127,127,0.3))",
              borderRadius: 8,
              overflow: "hidden",
              cursor: disabled ? "default" : "crosshair",
              touchAction: "none",
              opacity: disabled ? 0.55 : 1,
              pointerEvents: disabled ? "none" : "auto",
            }}
          >
            <img
              ref={imgRef}
              src={pageImgSrc}
              alt="Page 1 du document à signer"
              draggable={false}
              style={{ display: "block", width: "100%", height: "auto", userSelect: "none" }}
            />
            {shown && (
              <div
                style={{
                  position: "absolute",
                  left: `${(shown.x / pageSize.w) * 100}%`,
                  top: `${(shown.y / pageSize.h) * 100}%`,
                  width: `${(shown.w / pageSize.w) * 100}%`,
                  height: `${(shown.h / pageSize.h) * 100}%`,
                  border: draft ? "1.5px dashed #2563eb" : "1.5px solid #2563eb",
                  background: draft ? "rgba(37,99,235,0.10)" : "rgba(37,99,235,0.04)",
                  boxSizing: "border-box",
                  pointerEvents: "none",
                }}
              >
                {!draft && (
                  <img
                    src={markSrc}
                    alt="Aperçu de votre signature"
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Cliquez ou faites glisser sur la page pour placer votre signature — ou donnez-lui le focus (Tab) et
              utilisez les flèches du clavier.
            </p>
            {value && !disabled && (
              <button
                type="button"
                className="dc-auth__switch"
                style={{ fontSize: 12, padding: 0 }}
                onClick={() => onChange(null)}
              >
                Effacer le placement
              </button>
            )}
          </div>
          {/* Annonce vocale de l'emplacement courant — seule façon pour un lecteur
              d'écran de savoir où en est le placement clavier, qui n'a pas de
              retour visuel de survol contrairement à la souris. */}
          <p id={liveId} aria-live="polite" className="sr-only">
            {describePlacement(value, pageSize)}
          </p>
        </>
      )}
    </div>
  );
}
