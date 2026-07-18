import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { FormValue } from "./model";
import { readFields, type FieldBox, type RawWidget } from "./forms";

/**
 * Fillable AcroForm surface drawn over one rendered PDF page. Reads the page's
 * widget annotations with pdf.js, positions one control per field (input /
 * checkbox / radio / select) in the page's top-left scale-1 space (× scale), and
 * reports edits up. Values live in the editor's undoable state and are baked into
 * the exported PDF by `fillForm` (see forms.ts / pdf-save.ts).
 */
export default function FormLayer({ doc, from, scale, values, onChange, onBeginChange }: {
  doc: PDFDocumentProxy;
  from: number;
  scale: number;
  values: Record<string, FormValue>;
  onChange: (name: string, value: FormValue) => void;
  onBeginChange?: () => void;
}) {
  const [boxes, setBoxes] = useState<FieldBox[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(from + 1);
      const anns = (await page.getAnnotations()) as RawWidget[];
      if (cancelled) return;
      const h = page.getViewport({ scale: 1 }).height;
      setBoxes(readFields(anns, h));
    })();
    return () => { cancelled = true; };
  }, [doc, from]);

  if (!boxes || !boxes.length) return null;

  const valOf = (b: FieldBox): FormValue => (b.name in values ? values[b.name] : b.value);

  return (
    <div className="pdf-form-layer" style={{ position: "absolute", inset: 0 }}>
      {boxes.map((b, i) => {
        const cur = valOf(b);
        const style: React.CSSProperties = {
          position: "absolute", left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale,
        };
        const begin = () => onBeginChange?.();

        if (b.kind === "checkbox") {
          return (
            <input
              key={`${b.name}:${i}`} type="checkbox" className="pdf-form-check" style={style}
              checked={cur === true} disabled={b.readOnly}
              onFocus={begin}
              onChange={(e) => onChange(b.name, e.target.checked)}
              title={b.name}
            />
          );
        }
        if (b.kind === "radio") {
          return (
            <input
              key={`${b.name}:${i}`} type="radio" className="pdf-form-check" style={style}
              name={`radio:${b.name}`} checked={cur === b.exportValue} disabled={b.readOnly}
              onFocus={begin}
              onChange={() => onChange(b.name, b.exportValue ?? "")}
              title={b.name}
            />
          );
        }
        if (b.kind === "dropdown" || b.kind === "listbox") {
          return (
            <select
              key={`${b.name}:${i}`} className="pdf-form-input" style={style}
              value={typeof cur === "string" ? cur : ""} disabled={b.readOnly}
              onFocus={begin}
              onChange={(e) => onChange(b.name, e.target.value)}
              title={b.name}
            >
              <option value="" />
              {b.options.map((o, k) => <option key={k} value={o.value}>{o.label}</option>)}
            </select>
          );
        }
        // text
        const text = typeof cur === "string" ? cur : "";
        return b.multiLine ? (
          <textarea
            key={`${b.name}:${i}`} className="pdf-form-input" style={{ ...style, resize: "none" }}
            value={text} readOnly={b.readOnly} maxLength={b.maxLen ?? undefined}
            onFocus={begin}
            onChange={(e) => onChange(b.name, e.target.value)}
            title={b.name}
          />
        ) : (
          <input
            key={`${b.name}:${i}`} type="text" className="pdf-form-input" style={style}
            value={text} readOnly={b.readOnly} maxLength={b.maxLen ?? undefined}
            onFocus={begin}
            onChange={(e) => onChange(b.name, e.target.value)}
            title={b.name}
          />
        );
      })}
    </div>
  );
}
