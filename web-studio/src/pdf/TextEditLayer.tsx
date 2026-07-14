import { useEffect, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { EditedText } from "./model";
import { fontCss } from "../ui/fonts";

/** Minimal shape of a pdf.js text item (others are marked-content, skipped). */
interface RawItem { str?: string; width?: number; transform?: number[]; }

/**
 * Adobe-style "Edit text" surface: extracts the page's existing text with
 * pdf.js, groups items into lines, and shows one editable box per line at its
 * real position/size. Editing a line records an EditedText; on export the line
 * is covered and the new text redrawn (see pdf-save). Boxes have an opaque
 * background so the original (canvas) text is hidden while editing.
 */
export default function TextEditLayer({ doc, from, scale, edits, onChange, onBeginChange }: {
  doc: PDFDocumentProxy;
  from: number;
  scale: number;
  edits: EditedText[];
  onChange: (next: EditedText[]) => void;
  onBeginChange?: () => void;
}) {
  const [lines, setLines] = useState<EditedText[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(from + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      if (cancelled) return;
      type Raw = { x: number; baseline: number; w: number; fs: number; str: string };
      const raws: Raw[] = [];
      for (const it of tc.items as RawItem[]) {
        if (!it.str || !it.transform) continue;
        const tx = pdfjs.Util.transform(vp.transform, it.transform);
        const fs = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || 12;
        raws.push({ x: tx[4], baseline: tx[5], w: it.width || it.str.length * fs * 0.5, fs, str: it.str });
      }
      raws.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
      const out: EditedText[] = [];
      let group: Raw[] = [];
      const flush = () => {
        if (!group.length) return;
        group.sort((a, b) => a.x - b.x);
        const x = Math.min(...group.map((g) => g.x));
        const right = Math.max(...group.map((g) => g.x + g.w));
        const fs = Math.max(...group.map((g) => g.fs));
        const baseline = group[0].baseline;
        const text = group.map((g) => g.str).join("");
        if (text.trim()) out.push({ key: `L${out.length}`, x, y: baseline - fs, w: right - x, h: fs * 1.25, fontSize: fs, text, original: text });
        group = [];
      };
      for (const r of raws) {
        if (group.length && Math.abs(r.baseline - group[0].baseline) <= Math.max(3, group[0].fs * 0.6)) group.push(r);
        else { flush(); group = [r]; }
      }
      flush();
      if (!cancelled) setLines(out);
    })();
    return () => { cancelled = true; };
  }, [doc, from]);

  if (!lines) return null;

  // Overlay persisted edits (by key) onto the freshly extracted lines.
  const merged = lines.map((l) => {
    const e = edits.find((x) => x.key === l.key);
    return e ? { ...l, text: e.text, color: e.color, fontFamily: e.fontFamily, bold: e.bold, italic: e.italic } : l;
  });

  const update = (line: EditedText, text: string) => {
    const others = edits.filter((e) => e.key !== line.key);
    onChange(text !== line.original ? [...others, { ...line, text }] : others);
  };

  return (
    <div className="pdf-textedit-layer" style={{ position: "absolute", inset: 0 }}>
      {merged.map((l) => (
        <textarea
          key={l.key}
          className="pdf-textedit"
          spellCheck={false}
          style={{
            position: "absolute",
            left: l.x * scale,
            top: l.y * scale,
            width: Math.max(24, l.w * scale) + 10,
            height: Math.max(l.h, l.fontSize * 1.25) * scale,
            fontSize: l.fontSize * scale,
            lineHeight: 1.1,
            color: l.color ?? "#111",
            fontFamily: fontCss(l.fontFamily),
            fontWeight: l.bold ? 700 : 400,
            fontStyle: l.italic ? "italic" : "normal",
          }}
          value={l.text}
          onFocus={() => onBeginChange?.()}
          onChange={(e) => update(l, e.target.value)}
        />
      ))}
    </div>
  );
}
