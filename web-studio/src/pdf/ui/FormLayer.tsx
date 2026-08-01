import { useEffect, useState } from "react";
import type { Rotation, Size } from "../core/coords";
import { psToView } from "../core/coords";
import type { PdfEngine } from "../core/engine";
import type { CreatedField, FormValue } from "../model/types";
import { readFields, type FieldBox, type RawWidget } from "../ops/forms";

/**
 * The form-filling surface for one page: one native control per AcroForm
 * widget, positioned over the rendered field so tabbing through a form feels
 * like a web form rather than like drawing on a picture.
 */

export interface FormLayerProps {
  engine: PdfEngine;
  from: number | null;
  pageId: string;
  size: Size;
  rotation: Rotation;
  scale: number;
  values: Record<string, FormValue>;
  created: CreatedField[];
  highlight: boolean;
  onChange: (name: string, value: FormValue) => void;
  onBeginChange: () => void;
  onFields: (pageId: string, fields: FieldBox[]) => void;
}

export default function FormLayer(p: FormLayerProps) {
  const [boxes, setBoxes] = useState<FieldBox[]>([]);

  useEffect(() => {
    if (p.from == null) { setBoxes([]); return; }
    let cancelled = false;
    (async () => {
      const anns = (await p.engine.annotations(p.from!)) as RawWidget[];
      if (cancelled) return;
      const info = p.engine.pages[p.from!];
      const origin = { x: info?.ox ?? 0, y: info?.oy ?? 0 };
      const fields = readFields(anns, p.size.h, origin);
      setBoxes(fields);
      p.onFields(p.pageId, fields);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.engine, p.from, p.size.h, p.pageId]);

  const place = (rect: { x: number; y: number; w: number; h: number }): React.CSSProperties => {
    const a = psToView({ x: rect.x, y: rect.y }, p.size, p.rotation);
    const b = psToView({ x: rect.x + rect.w, y: rect.y + rect.h }, p.size, p.rotation);
    return {
      position: "absolute",
      left: Math.min(a.x, b.x) * p.scale,
      top: Math.min(a.y, b.y) * p.scale,
      width: Math.abs(b.x - a.x) * p.scale,
      height: Math.abs(b.y - a.y) * p.scale,
    };
  };

  const all = [
    ...boxes,
    ...p.created
      .filter((f) => f.pageId === p.pageId)
      .map<FieldBox>((f) => ({
        key: f.id,
        name: f.name,
        kind: f.kind,
        rect: f.rect,
        readOnly: !!f.readOnly,
        required: !!f.required,
        multiLine: !!f.multiLine,
        password: false,
        maxLen: f.maxLen ?? null,
        exportValue: null,
        options: f.options ?? [],
        value: f.defaultValue ?? "",
        tooltip: f.tooltip,
        fontSize: f.fontSize,
        align: "left",
      })),
  ];

  if (!all.length) return null;

  return (
    <div className={`pdfx-formlayer ${p.highlight ? "is-highlighted" : ""}`}>
      {all.map((b) => {
        const value = b.name in p.values ? p.values[b.name] : b.value;
        const style = { ...place(b.rect), fontSize: Math.max(8, (b.fontSize ?? b.rect.h * 0.62) * p.scale) };
        const common = {
          key: b.key,
          style,
          title: b.tooltip ?? b.name,
          "aria-label": b.tooltip ?? b.name,
          onFocus: p.onBeginChange,
          className: `pdfx-field ${b.required ? "is-required" : ""} ${b.readOnly ? "is-readonly" : ""}`,
        };

        if (b.kind === "checkbox") {
          return (
            <input
              {...common}
              type="checkbox"
              className={`${common.className} pdfx-field--check`}
              checked={value === true}
              disabled={b.readOnly}
              onChange={(e) => p.onChange(b.name, e.target.checked)}
            />
          );
        }
        if (b.kind === "radio") {
          return (
            <input
              {...common}
              type="radio"
              className={`${common.className} pdfx-field--check`}
              name={`radio-${b.name}`}
              checked={value === b.exportValue}
              disabled={b.readOnly}
              onChange={() => p.onChange(b.name, b.exportValue ?? "")}
            />
          );
        }
        if (b.kind === "dropdown" || b.kind === "listbox") {
          return (
            <select
              {...common}
              value={typeof value === "string" ? value : ""}
              disabled={b.readOnly}
              onChange={(e) => p.onChange(b.name, e.target.value)}
            >
              <option value="" />
              {b.options.map((o, i) => <option key={i} value={o.value}>{o.label}</option>)}
            </select>
          );
        }
        if (b.kind === "signature") {
          return (
            <div {...common} className={`${common.className} pdfx-field--sig`}>
              <span>Signature</span>
            </div>
          );
        }
        if (b.kind === "button") return null;

        const text = typeof value === "string" ? value : "";
        return b.multiLine ? (
          <textarea
            {...common}
            value={text}
            readOnly={b.readOnly}
            maxLength={b.maxLen ?? undefined}
            onChange={(e) => p.onChange(b.name, e.target.value)}
          />
        ) : (
          <input
            {...common}
            type={b.password ? "password" : "text"}
            style={{ ...style, textAlign: b.align }}
            value={text}
            readOnly={b.readOnly}
            maxLength={b.maxLen ?? undefined}
            onChange={(e) => p.onChange(b.name, e.target.value)}
          />
        );
      })}
    </div>
  );
}
