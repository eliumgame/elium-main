import { useEffect, useMemo, useState } from "react";
import type { Rotation, Size } from "../core/coords";
import { psToView } from "../core/coords";
import type { PdfEngine } from "../core/engine";
import { buildRuns, groupBlocks, groupLines, type TextBlock } from "../core/text";
import type { ContentEdit } from "../model/types";
import { newId } from "../model/types";
import { fontCss } from "../../ui/fonts";

/**
 * "Edit text" mode for one page.
 *
 * The page's own paragraphs are detected from the text geometry and each gets
 * an editable box in place. Committing an edit records a `ContentEdit`; on
 * export the original operators for that paragraph are *removed* from the
 * content stream and the new text re-laid-out in the document's own font — no
 * white box, no duplicated hidden text underneath.
 */

export interface ContentEditLayerProps {
  engine: PdfEngine;
  from: number | null;
  pageId: string;
  size: Size;
  rotation: Rotation;
  scale: number;
  edits: ContentEdit[];
  onCommit: (edit: ContentEdit) => void;
  onBeginChange: () => void;
  onBlocks?: (pageId: string, blocks: TextBlock[]) => void;
}

export default function ContentEditLayer(p: ContentEditLayerProps) {
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (p.from == null) { setBlocks([]); return; }
    let cancelled = false;
    (async () => {
      const page = await p.engine.page(p.from!);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      const tc = await p.engine.text(p.from!);
      if (cancelled) return;
      const runs = buildRuns(tc, vp.transform as unknown as number[]);
      const lines = groupLines(runs, tc.items);
      const grouped = groupBlocks(lines);
      setBlocks(grouped);
      p.onBlocks?.(p.pageId, grouped);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.engine, p.from, p.pageId]);

  const byKey = useMemo(() => new Map(p.edits.map((e) => [e.blockKey, e])), [p.edits]);

  if (!blocks) return null;

  const place = (rect: { x: number; y: number; w: number; h: number }): React.CSSProperties => {
    const a = psToView({ x: rect.x, y: rect.y }, p.size, p.rotation);
    const b = psToView({ x: rect.x + rect.w, y: rect.y + rect.h }, p.size, p.rotation);
    return {
      position: "absolute",
      left: Math.min(a.x, b.x) * p.scale - 3,
      top: Math.min(a.y, b.y) * p.scale - 3,
      width: Math.abs(b.x - a.x) * p.scale + 6,
      height: Math.abs(b.y - a.y) * p.scale + 6,
    };
  };

  const commit = (block: TextBlock, text: string, deleted = false) => {
    const existing = byKey.get(block.key);
    p.onCommit({
      id: existing?.id ?? newId("ce"),
      pageId: p.pageId,
      blockKey: block.key,
      original: block.text,
      text,
      rect: block.rect,
      fontSize: block.fontSize,
      leading: block.leading,
      align: block.align,
      fontFamily: block.fontFamily,
      bold: block.bold,
      italic: block.italic,
      deleted,
    });
  };

  return (
    <div className="pdfx-editlayer">
      {blocks.map((block) => {
        const edit = byKey.get(block.key);
        const value = edit ? edit.text : block.text;
        const changed = !!edit && (edit.deleted || edit.text !== edit.original);
        const style = place(block.rect);
        const isActive = active === block.key;

        return (
          <div
            key={block.key}
            className={`pdfx-editblock ${changed ? "is-changed" : ""} ${isActive ? "is-active" : ""}`}
            style={style}
          >
            {isActive ? (
              <textarea
                autoFocus
                className="pdfx-editblock__input"
                style={{
                  fontSize: block.fontSize * p.scale,
                  lineHeight: (block.leading / block.fontSize) || 1.2,
                  fontFamily: fontCss(block.fontFamily),
                  fontWeight: block.bold ? 700 : 400,
                  fontStyle: block.italic ? "italic" : "normal",
                  textAlign: block.align === "justify" ? "justify" : block.align,
                }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => { commit(block, draft); setActive(null); }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") { setActive(null); }
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { commit(block, draft); setActive(null); }
                }}
              />
            ) : (
              <button
                type="button"
                className="pdfx-editblock__hit"
                title="Cliquer pour modifier ce paragraphe"
                onClick={() => { p.onBeginChange(); setDraft(value); setActive(block.key); }}
              />
            )}
            {changed && !isActive && (
              <span className="pdfx-editblock__badge" title="Paragraphe modifié">modifié</span>
            )}
            {isActive && (
              <div className="pdfx-editblock__tools">
                <button onMouseDown={(e) => { e.preventDefault(); commit(block, "", true); setActive(null); }}>Supprimer</button>
                <button onMouseDown={(e) => { e.preventDefault(); commit(block, block.text); setActive(null); }}>Rétablir</button>
              </div>
            )}
          </div>
        );
      })}
      {!blocks.length && (
        <div className="pdfx-editlayer__empty">Aucun texte modifiable détecté sur cette page (document scanné ?). Lancez l'OCR pour le rendre éditable.</div>
      )}
    </div>
  );
}
