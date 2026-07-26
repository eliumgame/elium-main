/**
 * AcroForm support: reading the fields a PDF already declares, filling them,
 * and *creating* new ones (Acrobat's "Prepare form").
 *
 * Reading is done from pdf.js widget annotations, because that is what the
 * viewer already has in hand and it gives positions in the same space the
 * overlay uses. Writing is done with pdf-lib.
 */

import {
  PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField,
} from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import type { Rect } from "../core/coords";
import type { CreatedField, FieldKind, FormValue } from "../model/types";

/** Subset of a pdf.js widget annotation we consume (`getAnnotations()` is untyped). */
export interface RawWidget {
  id?: string;
  fieldType?: string;
  fieldName?: string;
  alternativeText?: string;
  fieldValue?: unknown;
  defaultFieldValue?: unknown;
  rect?: number[];
  readOnly?: boolean;
  required?: boolean;
  hidden?: boolean;
  multiLine?: boolean;
  password?: boolean;
  maxLen?: number | null;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  combo?: boolean;
  multiSelect?: boolean;
  options?: { exportValue?: string; displayValue?: string }[];
  textAlignment?: number | null;
  defaultAppearanceData?: { fontSize?: number; fontName?: string };
  subtype?: string;
}

export interface FieldBox {
  /** Stable per-widget id (a radio group has one entry per button). */
  key: string;
  name: string;
  kind: FieldKind;
  rect: Rect;
  readOnly: boolean;
  required: boolean;
  multiLine: boolean;
  password: boolean;
  maxLen: number | null;
  /** Checkbox/radio "on" value; null otherwise. */
  exportValue: string | null;
  options: { value: string; label: string }[];
  value: FormValue;
  tooltip?: string;
  fontSize?: number;
  align: "left" | "center" | "right";
}

function kindOf(a: RawWidget): FieldKind | null {
  if (a.fieldType === "Tx") return "text";
  if (a.fieldType === "Ch") return a.combo ? "dropdown" : "listbox";
  if (a.fieldType === "Sig") return "signature";
  if (a.fieldType === "Btn") {
    if (a.pushButton) return "button";
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

const ALIGN: Record<number, "left" | "center" | "right"> = { 0: "left", 1: "center", 2: "right" };

/**
 * Map pdf.js widgets to boxes in the page's *unrotated* top-left point space —
 * the same space annotations use, so the fill layer positions with one scale
 * multiplication.
 */
export function readFields(anns: readonly RawWidget[], pageHeight: number): FieldBox[] {
  const out: FieldBox[] = [];
  anns.forEach((a, i) => {
    const kind = kindOf(a);
    if (!kind || !a.fieldName || !a.rect || a.rect.length < 4) return;
    const [x1, y1, x2, y2] = a.rect;
    const x = Math.min(x1, x2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    const y = pageHeight - Math.max(y1, y2);
    const exportValue = kind === "radio" ? a.buttonValue ?? "" : kind === "checkbox" ? a.exportValue ?? "" : null;
    out.push({
      key: a.id ?? `${a.fieldName}:${i}`,
      name: a.fieldName,
      kind,
      rect: { x, y, w, h },
      readOnly: !!a.readOnly,
      required: !!a.required,
      multiLine: !!a.multiLine,
      password: !!a.password,
      maxLen: a.maxLen ?? null,
      exportValue,
      options: (a.options ?? []).map((o) => ({
        value: o.exportValue ?? o.displayValue ?? "",
        label: o.displayValue ?? o.exportValue ?? "",
      })),
      value: initialValue(a, kind, exportValue),
      tooltip: a.alternativeText || undefined,
      fontSize: a.defaultAppearanceData?.fontSize || undefined,
      align: ALIGN[a.textAlignment ?? 0] ?? "left",
    });
  });
  return out;
}

export function hasFormFields(anns: readonly RawWidget[]): boolean {
  return anns.some((a) => {
    const k = kindOf(a);
    return !!k && k !== "button" && !!a.fieldName;
  });
}

/** Fields that still need a value before the form is complete. */
export function missingRequired(fields: readonly FieldBox[], values: Record<string, FormValue>): FieldBox[] {
  return fields.filter((f) => {
    if (!f.required || f.readOnly || f.kind === "button") return false;
    const v = f.name in values ? values[f.name] : f.value;
    if (f.kind === "checkbox") return v !== true;
    return !String(v ?? "").trim();
  });
}

// ---------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------

export interface FillReport {
  filled: number;
  skipped: string[];
}

/** Write collected values into an already-loaded document. */
export function fillForm(doc: PDFDocument, values: Record<string, FormValue>, font?: PDFFont): FillReport {
  const report: FillReport = { filled: 0, skipped: [] };
  let form;
  try {
    form = doc.getForm();
  } catch {
    return report;
  }
  for (const field of form.getFields()) {
    const name = field.getName();
    if (!(name in values)) continue;
    const val = values[name];
    try {
      if (field instanceof PDFTextField) {
        field.setText(typeof val === "boolean" ? (val ? "Oui" : "") : String(val ?? ""));
      } else if (field instanceof PDFCheckBox) {
        if (val === true || (typeof val === "string" && val && val !== "Off")) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (typeof val === "string" && val) {
          const opts = field.getOptions();
          // pdf.js reports the appearance-state name, which may be a numeric
          // index rather than pdf-lib's option name — map it back.
          if (opts.includes(val)) field.select(val);
          else if (/^\d+$/.test(val) && opts[Number(val)] != null) field.select(opts[Number(val)]);
          else { report.skipped.push(name); continue; }
        } else field.clear();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        if (typeof val === "string" && val) field.select(val);
        else field.clear();
      } else {
        continue;
      }
      report.filled++;
    } catch {
      report.skipped.push(name);
    }
  }
  try {
    if (font) form.updateFieldAppearances(font);
    else form.updateFieldAppearances();
  } catch { /* appearances are best-effort */ }
  return report;
}

export function flattenForm(doc: PDFDocument): boolean {
  try {
    doc.getForm().flatten();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Creating fields ("Prepare form")
// ---------------------------------------------------------------------------

/** Suggest fields from the page's text — Acrobat's automatic field detection. */
export interface FieldSuggestion {
  name: string;
  kind: FieldKind;
  rect: Rect;
}

/**
 * Detect likely form fields from a page's line geometry: a label ending in
 * ":" followed by whitespace, or a run of underscores / a horizontal rule,
 * becomes a text field.
 */
export function suggestFields(
  lines: readonly { text: string; rect: Rect; fontSize: number }[],
  pageWidth: number,
): FieldSuggestion[] {
  const out: FieldSuggestion[] = [];
  const used = new Set<string>();
  const nameFor = (label: string) => {
    const base = label
      .replace(/[:：]\s*$/, "")
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 40) || "champ";
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base}_${i++}`;
    used.add(name);
    return name;
  };

  for (const line of lines) {
    const underscores = /_{4,}\s*$/.test(line.text);
    const colon = /[:：]\s*$/.test(line.text);
    if (!underscores && !colon) continue;
    const h = Math.max(14, line.fontSize * 1.5);
    const x = line.rect.x + line.rect.w + (colon ? 6 : 0);
    const w = Math.max(60, Math.min(pageWidth - x - 36, 240));
    if (w < 40) continue;
    out.push({
      name: nameFor(line.text),
      kind: "text",
      rect: { x: underscores ? line.rect.x : x, y: line.rect.y - 2, w: underscores ? line.rect.w : w, h },
    });
  }
  return out;
}

export interface CreateFieldsContext {
  doc: PDFDocument;
  font: PDFFont;
}

/**
 * Materialise the fields the user drew with the form builder.
 * `pageOf` resolves a field's page id to the output page it belongs to.
 */
export function createFields(
  ctx: CreateFieldsContext,
  fields: readonly CreatedField[],
  pageOf: (pageId: string) => { page: PDFPage; height: number } | null,
): number {
  if (!fields.length) return 0;
  const form = ctx.doc.getForm();
  let made = 0;
  const ordered = [...fields].sort((a, b) => (a.tabIndex ?? 0) - (b.tabIndex ?? 0));

  for (const f of ordered) {
    const target = pageOf(f.pageId);
    if (!target) continue;
    const { page } = target;
    const box = page.getCropBox();
    const at = {
      x: box.x + f.rect.x,
      y: box.y + box.height - f.rect.y - f.rect.h,
      width: Math.max(6, f.rect.w),
      height: Math.max(6, f.rect.h),
    };
    // NOTE: anything that touches a field's default appearance — the font
    // size, and any value whose look has to be rendered — only works *after*
    // `addToPage`, which is what creates the `/DA` entry in the first place.
    try {
      switch (f.kind) {
        case "text": {
          const field = form.createTextField(f.name);
          if (f.multiLine) field.enableMultiline();
          if (f.maxLen) field.setMaxLength(f.maxLen);
          if (f.required) field.enableRequired();
          field.addToPage(page, { ...at, font: ctx.font });
          field.setFontSize(f.fontSize ?? 11);
          if (typeof f.defaultValue === "string" && f.defaultValue) field.setText(f.defaultValue);
          if (f.readOnly) field.enableReadOnly();
          break;
        }
        case "checkbox": {
          const field = form.createCheckBox(f.name);
          if (f.required) field.enableRequired();
          field.addToPage(page, at);
          if (f.defaultValue === true) field.check();
          if (f.readOnly) field.enableReadOnly();
          break;
        }
        case "radio": {
          const existing = form.getFieldMaybe(f.name);
          const group = existing instanceof PDFRadioGroup ? existing : form.createRadioGroup(f.name);
          const option = (typeof f.defaultValue === "string" && f.defaultValue) || f.options?.[0]?.value || "Option1";
          if (f.required) group.enableRequired();
          group.addOptionToPage(option, page, at);
          break;
        }
        case "dropdown": {
          const field = form.createDropdown(f.name);
          field.addOptions((f.options ?? []).map((o) => o.value));
          field.enableEditing();
          if (f.required) field.enableRequired();
          field.addToPage(page, { ...at, font: ctx.font });
          field.setFontSize(f.fontSize ?? 11);
          if (typeof f.defaultValue === "string" && f.defaultValue) field.select(f.defaultValue);
          if (f.readOnly) field.enableReadOnly();
          break;
        }
        case "listbox": {
          const field = form.createOptionList(f.name);
          field.addOptions((f.options ?? []).map((o) => o.value));
          if (f.required) field.enableRequired();
          field.addToPage(page, { ...at, font: ctx.font });
          field.setFontSize(f.fontSize ?? 11);
          if (typeof f.defaultValue === "string" && f.defaultValue) field.select(f.defaultValue);
          if (f.readOnly) field.enableReadOnly();
          break;
        }
        case "signature": {
          // pdf-lib has no signature-field builder; a read-only text field with
          // a visible border is the closest interoperable placeholder.
          const field = form.createTextField(f.name);
          field.addToPage(page, { ...at, font: ctx.font });
          field.enableReadOnly();
          break;
        }
        default:
          continue;
      }
      made++;
    } catch { /* a duplicate or invalid field name must not sink the export */ }
  }
  return made;
}

// ---------------------------------------------------------------------------
// Import / export of form data
// ---------------------------------------------------------------------------

/** Serialise filled values as FDF, which Acrobat can import into the same form. */
export function toFdf(values: Record<string, FormValue>, fileName: string): string {
  const esc = (s: string) => s.replace(/([\\()])/g, "\\$1");
  const entries = Object.entries(values).map(([name, value]) => {
    const v = typeof value === "boolean" ? (value ? "/Yes" : "/Off") : `(${esc(String(value))})`;
    return `<< /T (${esc(name)}) /V ${v} >>`;
  });
  return [
    "%FDF-1.2",
    "1 0 obj",
    `<< /FDF << /Fields [ ${entries.join(" ")} ] /F (${esc(fileName)}) >> >>`,
    "endobj",
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
}

/** Read values back from an FDF produced by Acrobat or by `toFdf`. */
export function fromFdf(text: string): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  const re = /\/T\s*\(((?:[^()\\]|\\.)*)\)\s*\/V\s*(?:\(((?:[^()\\]|\\.)*)\)|\/([A-Za-z0-9_.]+))/g;
  let m: RegExpExecArray | null;
  const unesc = (s: string) => s.replace(/\\([\\()])/g, "$1");
  while ((m = re.exec(text)) !== null) {
    const name = unesc(m[1]);
    if (m[2] !== undefined) out[name] = unesc(m[2]);
    else if (m[3] !== undefined) out[name] = m[3] !== "Off";
  }
  return out;
}

/** CSV of the filled values, for spreadsheets and mail merges. */
export function toCsv(values: Record<string, FormValue>): string {
  const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [["Champ", "Valeur"], ...Object.entries(values).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "Oui" : "Non") : String(v)])];
  return rows.map((r) => r.map(esc).join(";")).join("\r\n");
}
