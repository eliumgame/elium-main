import { useEffect, useRef, useState } from "react";
import type { Rotation, Size } from "../core/coords";
import { psToView } from "../core/coords";
import type { ContentEdit, ImageEdit } from "../model/types";
import type { EditingInfo } from "./ContentEditLayer";
import { fontCss } from "../../ui/fonts";
import { openPdfDocument } from "../core/assets";
import { pdfjs } from "../core/pdfjs";

/**
 * Live preview of edits made to the PDF's own text.
 *
 * The page raster still shows the *original* words — the real rewrite only
 * happens in the content stream at export time. Without this layer an edit is
 * invisible until the file is exported, which makes the feature feel broken.
 * So each committed edit masks its original block and paints the new text in
 * its place, exactly where the exporter will put it.
 *
 * It renders in reading mode too, so leaving "Edit text" does not make the
 * change disappear.
 *
 * Once `source` is known the page is rebuilt with the edits by the save's own
 * code (`ops/editpreview.ts`) and THAT page is painted over the original:
 * same font, same line breaks as the file will have. The HTML text below is
 * only what shows while the rebuild runs.
 */

export interface ContentEditPreviewProps {
  edits: ContentEdit[];
  /** Moved, replaced, deleted or added pictures of the page (shown through the rebuild only). */
  imageEdits?: ImageEdit[];
  size: Size;
  rotation: Rotation;
  scale: number;
  /** Page background for the mask, so it matches the current reading theme. */
  maskColor: string;
  /** The document the page comes from, and its 0-based index there (null: a page added in Elium). */
  source?: { bytes: Uint8Array; password?: string | null } | null;
  from?: number | null;
  /** Characters of the edits no font can show (the file will miss them too). */
  onMissing?: (chars: string) => void;
  /** The paragraph being typed in: its original glyphs (and its earlier edit) are left out, the editor shows it. */
  editing?: EditingInfo | null;
}

/** The edits as the preview draws them: the paragraph being typed in is taken out of the page. */
function visibleEdits(edits: ContentEdit[], editing: EditingInfo | null | undefined): ContentEdit[] {
  if (!editing) return edits;
  const hit = edits.find((e) => e.blockKey === editing.blockKey);
  if (hit) return edits.map((e) => (e === hit ? { ...e, deleted: true } : e));
  return [
    ...edits,
    {
      id: "__editing",
      pageId: editing.pageId,
      blockKey: editing.blockKey,
      original: "",
      text: "",
      rect: editing.rect,
      fontSize: 12,
      leading: 14,
      align: "left",
      deleted: true,
    },
  ];
}

/**
 * The rewritten page as the file will have it, rendered at the view's size. `stale` is true while a
 * newer rebuild is running: the previous picture stays up (never a blank page) and the caller
 * draws its approximation of the edits over it until the new one arrives.
 */
function useRewrittenRaster(p: ContentEditPreviewProps, edits: ContentEdit[]): { url: string | null; stale: boolean } {
  const [done, setDone] = useState<{ url: string; key: string } | null>(null);
  const urlRef = useRef<string | null>(null);
  const key =
    JSON.stringify(
      edits.map((e) => [
        e.id,
        e.text,
        e.deleted,
        e.fontSize,
        e.align,
        e.color,
        e.rect,
        e.placement,
        e.fontFamily,
        e.bold,
        e.italic,
        e.restyled,
        e.spans,
        e.indent,
        e.leading,
      ]),
    ) +
    JSON.stringify((p.imageEdits ?? []).map((e) => [e.id, e.action, e.rect, e.crop, e.src?.length, e.src?.slice(-48)]));
  const any = edits.length > 0 || (p.imageEdits?.length ?? 0) > 0;
  const latest = useRef(0);
  useEffect(() => {
    if (!any || !p.source || p.from == null || typeof document === "undefined") {
      latest.current++;
      setDone(null);
      return;
    }
    const run = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const { rewrittenPage } = await import("../ops/editpreview");
        const res = await rewrittenPage(p.source!.bytes, p.source!.password, p.from!, edits, p.imageEdits ?? []);
        if (run !== latest.current) return;
        p.onMissing?.(res.missing);
        const task = openPdfDocument(res.bytes);
        const doc = await task.promise;
        const page = await doc.getPage(1);
        const ratio = Math.min(3, (window.devicePixelRatio || 1) * p.scale);
        const viewport = page.getViewport({ scale: ratio, rotation: p.rotation });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext("2d", { alpha: false })!;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // Annotations are drawn by Elium's own layers, as on the main canvas.
        await page.render({ canvas, canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE })
          .promise;
        await task.destroy();
        if (run !== latest.current) return;
        const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
        if (!blob || run !== latest.current) return;
        const next = URL.createObjectURL(blob);
        const old = urlRef.current;
        urlRef.current = next;
        setDone({ url: next, key });
        // The picture it replaces may still be on screen for a frame.
        if (old) setTimeout(() => URL.revokeObjectURL(old), 1500);
      } catch {
        // The HTML approximation stays: better than nothing.
      }
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, p.source?.bytes, p.from, p.scale, p.rotation]);
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );
  if (!any || !done) return { url: null, stale: false };
  return { url: done.url, stale: done.key !== key };
}

export default function ContentEditPreview(p: ContentEditPreviewProps) {
  const edits = visibleEdits(p.edits, p.editing);
  const { url, stale } = useRewrittenRaster(p, edits);
  if (!edits.length && !p.imageEdits?.length) return null;

  const approx = (
    <div className="pdfx-editpreview" aria-hidden>
      {edits.map((e) => {
        const a = psToView({ x: e.rect.x, y: e.rect.y }, p.size, p.rotation);
        const b = psToView({ x: e.rect.x + e.rect.w, y: e.rect.y + e.rect.h }, p.size, p.rotation);
        // A hair of bleed so antialiased edges of the original never peek out.
        const pad = 1.5 * p.scale;
        const left = Math.min(a.x, b.x) * p.scale - pad;
        const top = Math.min(a.y, b.y) * p.scale - pad;
        const width = Math.abs(b.x - a.x) * p.scale + pad * 2;
        const height = Math.abs(b.y - a.y) * p.scale + pad * 2;
        const size = e.fontSize * p.scale;
        const leading = (e.leading > 0 ? e.leading : e.fontSize * 1.2) * p.scale;

        return (
          <div
            key={e.id}
            className={`pdfx-editpreview__block ${e.deleted ? "is-deleted" : ""}`}
            style={{ left, top, width, height }}
          >
            <span className="pdfx-editpreview__mask" style={{ background: p.maskColor }} />
            {!e.deleted && (
              <span
                className="pdfx-editpreview__text"
                style={{
                  left: pad,
                  top: pad,
                  width: width - pad * 2,
                  fontSize: size,
                  lineHeight: `${leading}px`,
                  fontFamily: fontCss(e.fontFamily),
                  fontWeight: e.bold ? 700 : 400,
                  fontStyle: e.italic ? "italic" : "normal",
                  textAlign: e.align === "justify" ? "justify" : e.align,
                  color: e.color ?? "#111827",
                }}
              >
                {e.text}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );

  if (url) {
    return (
      <>
        <div className="pdfx-editpreview pdfx-editpreview--raster" aria-hidden>
          <img className="pdfx-editpreview__raster" src={url} alt="" draggable={false} />
        </div>
        {/* While a newer rebuild runs, the edits are also drawn approximately, so a change never blinks out. */}
        {stale && approx}
      </>
    );
  }
  return approx;
}
