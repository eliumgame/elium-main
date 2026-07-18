/**
 * AcroForm (PDF form) support. Two independent halves:
 *  - `readFields`: maps the untyped objects pdf.js returns from
 *    `page.getAnnotations()` into a small, testable box model in the page's
 *    *unrotated* top-left coordinates at scale 1 — same space the overlay
 *    annotations use, so the fill layer positions cleanly (× current scale).
 *  - `fillForm`: writes the collected values back into the PDF with pdf-lib,
 *    optionally flattening (baking fields into static page content).
 */
import {
  PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
} from "pdf-lib";
import type { FormValue } from "./model";

export type FieldKind = "text" | "checkbox" | "radio" | "dropdown" | "listbox";

/** Subset of a pdf.js widget annotation we consume (getAnnotations() is untyped). */
export interface RawWidget {
  fieldType?: string;   // "Tx" (text) | "Btn" (button/checkbox/radio) | "Ch" (choice)
  fieldName?: string;   // fully-qualified field name
  fieldValue?: unknown; // string | string[] | null
  rect?: number[];      // [x1, y1, x2, y2] in PDF bottom-left points
  readOnly?: boolean;
  hidden?: boolean;
  multiLine?: boolean;
  maxLen?: number | null;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string; // checkbox "on" value for THIS widget
  buttonValue?: string; // radio appearance-state name for THIS widget (may be a "0"/"1" index)
  combo?: boolean;      // choice field rendered as a dropdown (vs list box)
  options?: { exportValue?: string; displayValue?: string }[];
}

/** A single fillable widget, positioned in top-left scale-1 page points. */
export interface FieldBox {
  name: string;
  kind: FieldKind;
  x: number; y: number; w: number; h: number;
  readOnly: boolean;
  multiLine: boolean;
  maxLen: number | null;
  /** checkbox/radio "on" value; null for other kinds. */
  exportValue: string | null;
  /** choice options (value = export value, label = shown text). */
  options: { value: string; label: string }[];
  /** best-effort initial value read from the PDF. */
  value: FormValue;
}

function kindOf(a: RawWidget): FieldKind | null {
  if (a.fieldType === "Tx") return "text";
  if (a.fieldType === "Ch") return a.combo ? "dropdown" : "listbox";
  if (a.fieldType === "Btn") {
    if (a.pushButton) return null; // action buttons carry no fillable value
    if (a.radioButton) return "radio";
    return "checkbox";
  }
  return null;
}

function initialValue(a: RawWidget, kind: FieldKind, exportValue: string | null): FormValue {
  const fv = a.fieldValue;
  if (kind === "checkbox") return exportValue ? fv === exportValue : fv != null && fv !== "Off";
  if (kind === "radio") return typeof fv === "string" && fv !== "Off" ? fv : "";
  if (Array.isArray(fv)) return typeof fv[0] === "string" ? fv[0] : "";
  return typeof fv === "string" ? fv : "";
}

/**
 * Map pdf.js annotations to fillable field boxes. `pageHeight` is the page's
 * unrotated height (scale-1 points) used to flip the y axis to top-left.
 */
export function readFields(anns: readonly RawWidget[], pageHeight: number): FieldBox[] {
  const out: FieldBox[] = [];
  for (const a of anns) {
    const kind = kindOf(a);
    if (!kind || !a.fieldName || !a.rect || a.rect.length < 4 || a.hidden) continue;
    const [x1, y1, x2, y2] = a.rect;
    const x = Math.min(x1, x2), w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1), y = pageHeight - Math.max(y1, y2);
    // Checkboxes expose `exportValue`; radios expose `buttonValue` (the widget's
    // appearance-state name, which pdf.js may normalise to a "0"/"1" index).
    const exportValue = kind === "radio" ? a.buttonValue ?? "" : kind === "checkbox" ? a.exportValue ?? "" : null;
    const options = (a.options ?? []).map((o) => ({
      value: o.exportValue ?? o.displayValue ?? "",
      label: o.displayValue ?? o.exportValue ?? "",
    }));
    out.push({
      name: a.fieldName, kind, x, y, w, h,
      readOnly: !!a.readOnly, multiLine: !!a.multiLine, maxLen: a.maxLen ?? null,
      exportValue, options, value: initialValue(a, kind, exportValue),
    });
  }
  return out;
}

/** True if the document declares at least one AcroForm field (cheap gate for the UI). */
export function hasFormFields(anns: readonly RawWidget[]): boolean {
  return anns.some((a) => kindOf(a) !== null && !!a.fieldName);
}

/**
 * Write `values` (keyed by fully-qualified field name) into `bytes` with pdf-lib.
 * Unknown names and per-field failures are skipped so one bad field never aborts
 * the whole fill. `flatten` bakes the fields into static content (they stop being
 * interactive but render identically everywhere).
 */
export async function fillForm(
  bytes: Uint8Array,
  values: Record<string, FormValue>,
  flatten: boolean,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  for (const field of form.getFields()) {
    const name = field.getName();
    if (!(name in values)) continue;
    const val = values[name];
    try {
      if (field instanceof PDFTextField) {
        field.setText(val === true ? "" : val === false ? "" : String(val ?? ""));
      } else if (field instanceof PDFCheckBox) {
        if (val === true || (typeof val === "string" && val && val !== "Off")) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (typeof val === "string" && val) {
          const opts = field.getOptions();
          // pdf.js reports the selected radio by appearance-state name, which may
          // be a "0"/"1" index rather than the pdf-lib option name — map it back.
          if (opts.includes(val)) field.select(val);
          else if (/^\d+$/.test(val) && opts[Number(val)] != null) field.select(opts[Number(val)]);
        } else field.clear();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        if (typeof val === "string" && val) field.select(val);
        else field.clear();
      }
    } catch { /* skip a field that rejects its value rather than fail the export */ }
  }
  try { form.updateFieldAppearances(); } catch { /* best-effort appearances */ }
  if (flatten) { try { form.flatten(); } catch { /* leave interactive if flatten fails */ } }
  return doc.save();
}
