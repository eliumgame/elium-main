import type { Rotation, Size } from "../core/coords";
import { psToView } from "../core/coords";
import type { ContentEdit } from "../model/types";
import { fontCss } from "../../ui/fonts";

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
 */

export interface ContentEditPreviewProps {
  edits: ContentEdit[];
  size: Size;
  rotation: Rotation;
  scale: number;
  /** Page background for the mask, so it matches the current reading theme. */
  maskColor: string;
}

export default function ContentEditPreview(p: ContentEditPreviewProps) {
  if (!p.edits.length) return null;

  return (
    <div className="pdfx-editpreview" aria-hidden>
      {p.edits.map((e) => {
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
}
