/**
 * Form values: the bridge between what pdf.js knows about a document's
 * AcroForm (`getFieldObjects()`, the per-widget `annotationStorage` entries its
 * form layer writes) and Elium's model (`state.formValues`, keyed by fully
 * qualified field name, persisted in `.elium` sessions, drafts and undo).
 *
 * Pure functions only — the live glue is `session.ts`.
 *
 * Elium's value of a field, by type:
 *  - text                      → string
 *  - checkbox                  → the export value of the checked widget, "Off" when none
 *                                (so « Oui » / « Non » boxes sharing one name stay distinct)
 *  - radiobutton               → the export value of the selected button, "Off" when none
 *  - combobox, single listbox  → the selected export value, "" when none
 *  - multi-select listbox      → the selected export values (string[])
 *
 * Older sessions stored checkboxes as booleans: `coerceValue` maps `true` to
 * the field's (first) export value.
 */

import type { FormValue } from "../../model/types";

export type PdfjsFieldType = "text" | "checkbox" | "radiobutton" | "combobox" | "listbox" | "button" | "signature";

/** What `PDFDocumentProxy.getFieldObjects()` returns per widget (untyped in pdf.js). */
export interface RawFieldObject {
  id: string;
  type?: string;
  name?: string;
  value?: unknown;
  defaultValue?: unknown;
  exportValues?: string;
  editable?: boolean;
  hidden?: boolean;
  kidIds?: string[];
  page?: number;
  rect?: number[];
  multipleSelection?: boolean;
  items?: { exportValue?: string; displayValue?: string }[];
  charLimit?: number;
  comb?: boolean;
  multiline?: boolean;
  actions?: Record<string, string[]> | null;
}

export interface FormWidget {
  /** pdf.js annotation id ("12R"), also the key of its annotationStorage entry. */
  id: string;
  /** 0-based source page, -1 when unknown. */
  page: number;
  /** PDF user-space rectangle [x1, y1, x2, y2]. */
  rect: number[] | null;
  /** On-state of a checkbox / radio button widget. */
  exportValue: string | null;
  hidden: boolean;
}

export interface FormField {
  name: string;
  type: PdfjsFieldType;
  widgets: FormWidget[];
  /** The value the FILE holds. */
  fileValue: FormValue;
  /** /DV — what « Réinitialiser » restores. */
  defaultValue: FormValue;
  multiSelect: boolean;
  options: { value: string; label: string }[];
  readOnly: boolean;
  charLimit: number;
  /** Has JavaScript actions (format, keystroke, validate, calculate…). */
  hasActions: boolean;
}

const TYPES = new Set<string>(["text", "checkbox", "radiobutton", "combobox", "listbox", "button", "signature"]);

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Group pdf.js field objects into fields with their widgets (parent-only entries are skipped). */
export function buildFields(objects: Record<string, RawFieldObject[]> | null | undefined): Map<string, FormField> {
  const out = new Map<string, FormField>();
  if (!objects) return out;
  for (const [name, list] of Object.entries(objects)) {
    for (const o of list ?? []) {
      if (!o || !o.id || !o.type || !TYPES.has(o.type)) continue;
      const type = o.type as PdfjsFieldType;
      let field = out.get(name);
      if (!field) {
        const multiSelect = type === "listbox" && !!o.multipleSelection;
        field = {
          name,
          type,
          widgets: [],
          fileValue: "",
          defaultValue: "",
          multiSelect,
          options: (o.items ?? []).map((it) => ({
            value: str(it.exportValue ?? it.displayValue),
            label: str(it.displayValue ?? it.exportValue),
          })),
          readOnly: o.editable === false,
          charLimit: typeof o.charLimit === "number" && o.charLimit > 0 ? o.charLimit : 0,
          hasActions: !!o.actions && Object.keys(o.actions).length > 0,
        };
        field.fileValue = normalizeValue(field, o.value);
        field.defaultValue = normalizeValue(field, o.defaultValue);
        out.set(name, field);
      } else if (o.actions && Object.keys(o.actions).length) {
        field.hasActions = true;
      }
      field.widgets.push({
        id: o.id,
        page: typeof o.page === "number" ? o.page : -1,
        rect: Array.isArray(o.rect) && o.rect.length >= 4 ? o.rect.slice(0, 4) : null,
        exportValue: type === "checkbox" || type === "radiobutton" ? str(o.exportValues) || null : null,
        hidden: !!o.hidden,
      });
    }
  }
  return out;
}

/** A value as pdf.js reports it (field /V, /DV, a storage entry of the whole field) → Elium's form. */
export function normalizeValue(field: Pick<FormField, "type" | "multiSelect">, raw: unknown): FormValue {
  switch (field.type) {
    case "checkbox":
    case "radiobutton": {
      if (raw === true) return "Yes";
      if (raw === false || raw == null) return "Off";
      const s = str(raw);
      return s === "" ? "Off" : s;
    }
    case "listbox":
      if (field.multiSelect) {
        if (Array.isArray(raw)) return raw.map(str).filter((s) => s !== "");
        const s = str(raw);
        return s ? [s] : [];
      }
      return Array.isArray(raw) ? str(raw[0]) : str(raw);
    case "combobox":
      return Array.isArray(raw) ? str(raw[0]) : str(raw);
    default:
      return Array.isArray(raw) ? raw.map(str).join("\n") : str(raw);
  }
}

/** Bring a stored value (possibly from an older session) to the field's current shape. */
export function coerceValue(field: FormField, v: FormValue): FormValue {
  if (field.type === "checkbox" || field.type === "radiobutton") {
    if (v === true) return field.widgets.find((w) => w.exportValue)?.exportValue ?? "Yes";
    if (v === false) return "Off";
    if (Array.isArray(v)) return v[0] ?? "Off";
    return v === "" ? "Off" : v;
  }
  if (field.type === "listbox" && field.multiSelect) {
    if (Array.isArray(v)) return v;
    if (typeof v === "boolean") return [];
    return v ? [v] : [];
  }
  if (typeof v === "boolean") return v ? "Oui" : "";
  if (Array.isArray(v)) return field.type === "text" ? v.join("\n") : (v[0] ?? "");
  return v;
}

export function sameFormValue(a: FormValue | undefined, b: FormValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((x, i) => x === sb[i]);
  }
  return false;
}

/** True when the field is empty (for the « required » check). */
export function isEmptyValue(field: Pick<FormField, "type">, v: FormValue): boolean {
  if (field.type === "checkbox" || field.type === "radiobutton") return v === "Off" || v === "" || v === false;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === "boolean" ? !v : !v.trim();
}

/**
 * The annotationStorage entries that make pdf.js show / save `value`: one per
 * widget, in the shape its form layer writes.
 */
export function storageEntries(field: FormField, value: FormValue): [string, { value: unknown }][] {
  const v = coerceValue(field, value);
  switch (field.type) {
    case "checkbox":
    case "radiobutton":
      return field.widgets.map((w) => [w.id, { value: v !== "Off" && w.exportValue === v }]);
    case "listbox":
      if (field.multiSelect) return field.widgets.map((w) => [w.id, { value: Array.isArray(v) ? [...v] : [] }]);
      return field.widgets.map((w) => [w.id, { value: typeof v === "string" && v ? v : null }]);
    case "combobox":
      return field.widgets.map((w) => [w.id, { value: typeof v === "string" && v ? v : null }]);
    case "text":
      return field.widgets.map((w) => [w.id, { value: typeof v === "string" ? v : String(v) }]);
    default:
      return [];
  }
}

/**
 * The field's value as the storage currently holds it, or `undefined` when no
 * widget of it has an entry (the file's value applies).
 */
export function valueFromStorage(
  field: FormField,
  get: (id: string) => { value?: unknown; formattedValue?: unknown } | undefined,
): FormValue | undefined {
  const entries = field.widgets.map((w) => [w, get(w.id)] as const);
  if (!entries.some(([, e]) => e && "value" in e)) return undefined;
  switch (field.type) {
    case "checkbox":
    case "radiobutton": {
      let any = false;
      for (const [w, e] of entries) {
        if (!e || !("value" in e)) continue;
        any = true;
        if (e.value === true || (typeof e.value === "string" && e.value !== "Off" && e.value === w.exportValue)) {
          return w.exportValue ?? "Yes";
        }
      }
      // A widget without an entry still shows the file's state.
      for (const [w, e] of entries) {
        if (e && "value" in e) continue;
        if (w.exportValue && w.exportValue === field.fileValue) return w.exportValue;
      }
      return any ? "Off" : undefined;
    }
    default: {
      const e = entries.find(([, x]) => x && "value" in x)?.[1];
      return normalizeValue(field, e?.value);
    }
  }
}

/** The value every field would take after « Réinitialiser » (its /DV, else empty). */
export function defaultsOf(fields: Iterable<FormField>): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const f of fields) {
    if (f.type === "button" || f.type === "signature") continue;
    out[f.name] = f.defaultValue;
  }
  return out;
}

/** Every field's effective value: the file's, overridden by `overrides` (Elium's formValues). */
export function effectiveValues(
  fields: Iterable<FormField>,
  overrides: Record<string, FormValue> = {},
): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const f of fields) {
    if (f.type === "button" || f.type === "signature") continue;
    out[f.name] = f.name in overrides ? coerceValue(f, overrides[f.name]) : f.fileValue;
  }
  return out;
}

/** Display label of an export value (list fields). */
export function labelOf(field: FormField, value: string): string {
  return field.options.find((o) => o.value === value)?.label ?? value;
}

/** Field values as text for exports (CSV…): lists joined, box states kept as their export value. */
export function valueAsText(v: FormValue): string {
  if (Array.isArray(v)) return v.join("; ");
  if (typeof v === "boolean") return v ? "Oui" : "Off";
  return v;
}
