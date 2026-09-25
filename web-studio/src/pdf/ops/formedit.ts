/**
 * « Préparer un formulaire » in the written PDF: the same properties for the
 * fields Elium creates and for the file's own fields being edited (moved,
 * resized, renamed, deleted, re-configured), written the way Acrobat writes
 * them — field flags (ISO 32000 §12.7.4), /DA, /Q, /Opt, /DV, /TU, widget
 * flags, and the Acrobat JavaScript of the Format / Validate / Calculate tabs
 * (AFNumber_*, AFDate_*, AFRange_Validate, AFSimple_Calculate) with the
 * form's calculation order (/CO).
 *
 * A text or list field whose look changes loses its appearance here;
 * `completeFieldAppearances` (formpdf.ts) draws the new one, in a font that
 * shows its value.
 */

import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFTextField,
} from "pdf-lib";
import type { PDFDocument, PDFField, PDFForm, PDFPage, PDFWidgetAnnotation } from "pdf-lib";
import type { Rect } from "../core/coords";
import type { FieldEdit, FieldFormat, FieldProps, FormValue } from "../model/types";

// Field flags (Ff), ISO 32000-1 tables 221, 228, 230.
const FF = {
  readOnly: 1 << 0,
  required: 1 << 1,
  multiLine: 1 << 12,
  password: 1 << 13,
  comb: 1 << 24,
  combo: 1 << 17,
  edit: 1 << 18,
  multiSelect: 1 << 21,
};
// Annotation flags (F), table 165.
const AF = { hidden: 1 << 1, print: 1 << 2 };

const text = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? PDFString.of(s) : PDFHexString.fromText(s));

// ---------------------------------------------------------------------------
// Acrobat JavaScript
// ---------------------------------------------------------------------------

const js = JSON.stringify;

/** Keystroke and format scripts of a Format tab choice (null: remove them). */
export function formatScripts(f: FieldFormat | undefined): { K: string; F: string } | null {
  if (!f || f.kind === "none") return null;
  switch (f.kind) {
    case "number": {
      const args = `${f.decimals}, ${f.sepStyle}, ${f.negStyle}, 0, ${js(f.currency)}, ${f.currencyPrepend}`;
      return { K: `AFNumber_Keystroke(${args});`, F: `AFNumber_Format(${args});` };
    }
    case "percent":
      return {
        K: `AFPercent_Keystroke(${f.decimals}, ${f.sepStyle});`,
        F: `AFPercent_Format(${f.decimals}, ${f.sepStyle});`,
      };
    case "date":
      return { K: `AFDate_KeystrokeEx(${js(f.pattern)});`, F: `AFDate_FormatEx(${js(f.pattern)});` };
    case "time":
      return { K: `AFTime_Keystroke(${f.style});`, F: `AFTime_Format(${f.style});` };
    case "custom":
      return { K: f.keystroke ?? "", F: f.format ?? "" };
  }
}

export function validateScript(v: FieldProps["validate"]): string | null {
  if (!v || (v.min == null && v.max == null)) return null;
  return `AFRange_Validate(${v.min != null}, ${v.min ?? 0}, ${v.max != null}, ${v.max ?? 0});`;
}

export function calculateScript(c: FieldProps["calculate"]): string | null {
  if (!c) return null;
  if (c.kind === "custom") return c.script;
  return `AFSimple_Calculate(${js(c.op)}, new Array(${c.fields.map((n) => js(n)).join(", ")}));`;
}

function setAction(doc: PDFDocument, dict: PDFDict, key: "K" | "F" | "V" | "C", code: string | null): void {
  let aa = dict.lookup(PDFName.of("AA"));
  if (!(aa instanceof PDFDict)) {
    if (code === null) return;
    aa = doc.context.obj({});
    dict.set(PDFName.of("AA"), aa as PDFDict);
  }
  const map = aa as PDFDict;
  if (code === null || code === "") map.delete(PDFName.of(key));
  else map.set(PDFName.of(key), doc.context.obj({ S: "JavaScript", JS: text(code) }));
  if (!map.keys().length) dict.delete(PDFName.of("AA"));
}

/** Keep the calculated field in (or out of) the form's calculation order. */
function setCalculationOrder(form: PDFForm, ref: PDFRef, calculated: boolean): void {
  const dict = form.acroForm.dict;
  const co = dict.lookup(PDFName.of("CO"));
  const list = co instanceof PDFArray ? co : form.doc.context.obj([]);
  const at = list.asArray().findIndex((r) => r instanceof PDFRef && r.objectNumber === ref.objectNumber);
  if (calculated && at < 0) list.push(ref);
  if (!calculated && at >= 0) list.remove(at);
  if (list.size()) dict.set(PDFName.of("CO"), list);
  else dict.delete(PDFName.of("CO"));
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function flags(field: PDFField): number {
  const ff = field.acroField.dict.lookup(PDFName.of("Ff"));
  return ff instanceof PDFNumber ? ff.asNumber() : 0;
}

function setFlag(field: PDFField, bit: number, on: boolean | undefined): void {
  if (on === undefined) return;
  const next = on ? flags(field) | bit : flags(field) & ~bit;
  if (next) field.acroField.dict.set(PDFName.of("Ff"), PDFNumber.of(next));
  else field.acroField.dict.delete(PDFName.of("Ff"));
}

function setWidgetFlag(widget: PDFWidgetAnnotation, bit: number, on: boolean): void {
  const f = widget.getFlags();
  widget.dict.set(PDFName.of("F"), PDFNumber.of(on ? f | bit : f & ~bit));
}

/** Rewrite the font size of a /DA string (0 = auto), keeping font and colour. */
export function withFontSize(da: string, size: number): string {
  const re = /(\/[^\s/]+\s+)(-?\d*\.?\d+)(\s+Tf)/;
  if (re.test(da)) return da.replace(re, `$1${size}$3`);
  return `/Helv ${size} Tf ${da}`.trim();
}

function daDicts(field: PDFField): PDFDict[] {
  const out = [field.acroField.dict];
  for (const w of field.acroField.getWidgets())
    if (w.dict !== field.acroField.dict && w.dict.has(PDFName.of("DA"))) out.push(w.dict);
  return out;
}

function decode(v: unknown): string | undefined {
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
}

/** Rename a box widget's on-state (its /AP /N and /D keys, /AS, /V). */
function setOnState(widget: PDFWidgetAnnotation, next: string): void {
  const ap = widget.dict.lookup(PDFName.of("AP"));
  if (!(ap instanceof PDFDict)) return;
  let previous: string | null = null;
  for (const key of ["N", "D"]) {
    const sub = ap.lookup(PDFName.of(key));
    if (!(sub instanceof PDFDict)) continue;
    const on = sub.keys().find((k) => k.decodeText() !== "Off");
    if (!on || on.decodeText() === next) continue;
    previous = on.decodeText();
    const v = sub.get(on)!;
    sub.delete(on);
    sub.set(PDFName.of(next), v);
  }
  if (previous !== null && widget.getAppearanceState()?.decodeText() === previous) {
    widget.setAppearanceState(PDFName.of(next));
  }
}

export interface PropsResult {
  /** The field's look changed: text/list appearances were dropped for a redraw. */
  redraw: boolean;
}

/**
 * Apply `props` to `field` (only what `props` sets; `undefined` leaves the
 * file's setting alone).
 */
export function setFieldProps(doc: PDFDocument, form: PDFForm, field: PDFField, props: FieldProps): PropsResult {
  const dict = field.acroField.dict;
  const widgets = field.acroField.getWidgets();
  let redraw = false;

  if (props.tooltip !== undefined) {
    // On the field (Acrobat) AND on separate widgets: pdf.js reads /TU from
    // the widget annotation only, so a field split from its widgets lost it.
    for (const d of [dict, ...widgets.map((w) => w.dict).filter((d) => d !== dict)]) {
      if (props.tooltip) d.set(PDFName.of("TU"), text(props.tooltip));
      else d.delete(PDFName.of("TU"));
    }
  }
  setFlag(field, FF.required, props.required);
  setFlag(field, FF.readOnly, props.readOnly);
  if (props.hidden !== undefined || props.noPrint !== undefined) {
    for (const w of widgets) {
      if (props.hidden !== undefined) setWidgetFlag(w, AF.hidden, props.hidden);
      if (props.noPrint !== undefined) setWidgetFlag(w, AF.print, !props.noPrint);
    }
  }

  if (field instanceof PDFTextField) {
    if (props.multiLine !== undefined || props.password !== undefined || props.comb !== undefined) redraw = true;
    setFlag(field, FF.multiLine, props.multiLine);
    setFlag(field, FF.password, props.password);
    setFlag(field, FF.comb, props.comb);
    if (props.maxLen !== undefined) {
      redraw = true;
      if (props.maxLen && props.maxLen > 0) dict.set(PDFName.of("MaxLen"), PDFNumber.of(props.maxLen));
      else dict.delete(PDFName.of("MaxLen"));
    }
  }

  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    if (field instanceof PDFDropdown) setFlag(field, FF.edit, props.editable);
    if (field instanceof PDFOptionList) setFlag(field, FF.multiSelect, props.multiSelect);
    if (props.options) {
      redraw = true;
      dict.set(
        PDFName.of("Opt"),
        doc.context.obj(
          props.options.map((o) => (o.label && o.label !== o.value ? [text(o.value), text(o.label)] : text(o.value))),
        ),
      );
    }
  }

  if (props.fontSize !== undefined) {
    redraw = true;
    for (const d of daDicts(field)) {
      const da =
        decode(d.lookup(PDFName.of("DA"))) ?? decode(form.acroForm.dict.lookup(PDFName.of("DA"))) ?? "/Helv 0 Tf 0 g";
      d.set(PDFName.of("DA"), PDFString.of(withFontSize(da, props.fontSize)));
    }
  }
  if (props.align !== undefined) {
    redraw = true;
    dict.set(PDFName.of("Q"), PDFNumber.of({ left: 0, center: 1, right: 2 }[props.align]));
  }

  if ((field instanceof PDFCheckBox || field instanceof PDFRadioGroup) && props.exportValue) {
    // One widget per box: the first one takes the new export value.
    if (widgets[0]) setOnState(widgets[0], props.exportValue);
  }

  if (props.defaultValue !== undefined) setDefault(doc, field, props.defaultValue);

  if (field instanceof PDFTextField) {
    if (props.format !== undefined) {
      const s = formatScripts(props.format);
      setAction(doc, dict, "K", s?.K ?? null);
      setAction(doc, dict, "F", s?.F ?? null);
      redraw = true;
    }
    if (props.validate !== undefined) setAction(doc, dict, "V", validateScript(props.validate));
    if (props.calculate !== undefined) {
      const code = calculateScript(props.calculate);
      setAction(doc, dict, "C", code);
      setCalculationOrder(form, field.ref, !!code);
    }
  }

  if (redraw && !(field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) {
    for (const w of widgets) w.dict.delete(PDFName.of("AP"));
  }
  return { redraw };
}

function setDefault(doc: PDFDocument, field: PDFField, v: FormValue): void {
  const dict = field.acroField.dict;
  const key = PDFName.of("DV");
  if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
    const s = v === true ? "Yes" : v === false || v === "" ? "Off" : Array.isArray(v) ? (v[0] ?? "Off") : v;
    dict.set(key, PDFName.of(s));
    return;
  }
  if (Array.isArray(v)) {
    if (v.length) dict.set(key, doc.context.obj(v.map(text)));
    else dict.delete(key);
    return;
  }
  const s = typeof v === "boolean" ? (v ? "Oui" : "") : v;
  if (s) dict.set(key, text(s));
  else dict.delete(key);
}

// ---------------------------------------------------------------------------
// Editing the file's fields
// ---------------------------------------------------------------------------

export interface EditReport {
  applied: number;
  /** Human-readable problems (field not found, name taken…). */
  problems: string[];
}

/** Page and reference of every annotation, in one pass. */
function widgetPages(doc: PDFDocument): Map<PDFDict, { page: PDFPage; ref: PDFRef | null }> {
  const out = new Map<PDFDict, { page: PDFPage; ref: PDFRef | null }>();
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const d = annots.lookup(i);
      if (d instanceof PDFDict) out.set(d, { page, ref: raw instanceof PDFRef ? raw : null });
    }
  }
  return out;
}

/** pdf.js' id of an annotation: « 12R », « 12R3 » for a non-zero generation. */
const pdfjsId = (ref: PDFRef) => `${ref.objectNumber}R${ref.generationNumber || ""}`;

function removeFrom(array: PDFArray | undefined, target: PDFDict, doc: PDFDocument): void {
  if (!array) return;
  for (let i = array.size() - 1; i >= 0; i--) {
    const raw = array.get(i);
    const d = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
    if (d === target) array.remove(i);
  }
}

/** The /Kids array holding `dict`, or the AcroForm's /Fields. */
function containerOf(form: PDFForm, dict: PDFDict): PDFArray | undefined {
  const parent = dict.lookup(PDFName.of("Parent"));
  if (parent instanceof PDFDict) {
    const kids = parent.lookup(PDFName.of("Kids"));
    return kids instanceof PDFArray ? kids : undefined;
  }
  const fields = form.acroForm.dict.lookup(PDFName.of("Fields"));
  return fields instanceof PDFArray ? fields : undefined;
}

/** Remove non-terminal parents left without kids. */
function pruneParents(form: PDFForm, start: PDFDict | undefined, doc: PDFDocument): void {
  let node = start;
  for (let depth = 0; node && depth < 32; depth++) {
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray && kids.size() > 0) return;
    const up = node.lookup(PDFName.of("Parent"));
    removeFrom(containerOf(form, node), node, doc);
    node = up instanceof PDFDict ? up : undefined;
  }
}

/** The reference of a field dict from its container (a /Kids or /Fields entry). */
function refIn(array: PDFArray, dict: PDFDict, doc: PDFDocument): PDFRef | null {
  for (let i = 0; i < array.size(); i++) {
    const raw = array.get(i);
    if (raw instanceof PDFRef && doc.context.lookup(raw) === dict) return raw;
  }
  return null;
}

/** The non-terminal field for `parts` (created on the way) and its reference, or null for the root. */
function ensureParent(doc: PDFDocument, form: PDFForm, parts: string[]): { dict: PDFDict; ref: PDFRef } | null {
  let container = form.acroForm.dict.lookup(PDFName.of("Fields"));
  if (!(container instanceof PDFArray)) {
    container = doc.context.obj([]);
    form.acroForm.dict.set(PDFName.of("Fields"), container as PDFArray);
  }
  let parent: { dict: PDFDict; ref: PDFRef } | null = null;
  for (const part of parts) {
    const kids = container as PDFArray;
    let found: PDFDict | null = null;
    let foundRef: PDFRef | null = null;
    for (let i = 0; i < kids.size(); i++) {
      const d = kids.lookup(i);
      const raw = kids.get(i);
      if (d instanceof PDFDict && raw instanceof PDFRef && decode(d.lookup(PDFName.of("T"))) === part) {
        found = d;
        foundRef = raw;
      }
    }
    if (!found || !foundRef) {
      found = doc.context.obj({ T: text(part), Kids: [] }) as PDFDict;
      if (parent) found.set(PDFName.of("Parent"), parent.ref);
      foundRef = doc.context.register(found);
      kids.push(foundRef);
    }
    parent = { dict: found, ref: foundRef };
    let next = found.lookup(PDFName.of("Kids"));
    if (!(next instanceof PDFArray)) {
      next = doc.context.obj([]);
      found.set(PDFName.of("Kids"), next as PDFArray);
    }
    container = next;
  }
  return parent;
}

function renameField(doc: PDFDocument, form: PDFForm, field: PDFField, to: string): string | null {
  const parts = to.split(".").filter(Boolean);
  if (!parts.length) return "nom vide";
  if (form.getFieldMaybe(to)) return `le nom « ${to} » est déjà pris`;
  const dict = field.acroField.dict;
  const from = field.getName().split(".");
  const samePrefix = from.slice(0, -1).join(".") === parts.slice(0, -1).join(".");
  dict.set(PDFName.of("T"), text(parts[parts.length - 1]));
  if (samePrefix) return null;
  // Another branch of the name tree: move the field there.
  const oldParent = dict.lookup(PDFName.of("Parent"));
  const container = containerOf(form, dict);
  const ref = (container && refIn(container, dict, doc)) || field.ref;
  removeFrom(container, dict, doc);
  const parent = ensureParent(doc, form, parts.slice(0, -1));
  if (parent) {
    dict.set(PDFName.of("Parent"), parent.ref);
    (parent.dict.lookup(PDFName.of("Kids")) as PDFArray).push(ref);
  } else {
    dict.delete(PDFName.of("Parent"));
    (form.acroForm.dict.lookup(PDFName.of("Fields")) as PDFArray).push(ref);
  }
  if (oldParent instanceof PDFDict) pruneParents(form, oldParent, doc);
  return null;
}

function deleteField(
  doc: PDFDocument,
  form: PDFForm,
  field: PDFField,
  pages: Map<PDFDict, { page: PDFPage; ref: PDFRef | null }>,
): void {
  const dict = field.acroField.dict;
  for (const w of field.acroField.getWidgets()) {
    const hit = pages.get(w.dict);
    if (hit) removeFrom(hit.page.node.Annots(), w.dict, doc);
  }
  setCalculationOrder(form, field.ref, false);
  const parent = dict.lookup(PDFName.of("Parent"));
  removeFrom(containerOf(form, dict), dict, doc);
  if (parent instanceof PDFDict) pruneParents(form, parent, doc);
}

/** Top-left unrotated page space (like annotations) → PDF user space. */
export function rectToPdf(page: PDFPage, r: Rect): [number, number, number, number] {
  const box = page.getCropBox();
  const x1 = box.x + r.x;
  const y2 = box.y + box.height - r.y;
  return [x1, y2 - Math.max(1, r.h), x1 + Math.max(1, r.w), y2];
}

/** Apply « Préparer un formulaire » edits to the file's fields. */
export function applyFieldEdits(doc: PDFDocument, edits: readonly FieldEdit[]): EditReport {
  const report: EditReport = { applied: 0, problems: [] };
  if (!edits.length) return report;
  let form: PDFForm;
  try {
    form = doc.getForm();
  } catch {
    report.problems.push("formulaire illisible");
    return report;
  }
  const pages = widgetPages(doc);
  for (const edit of edits) {
    const field = form.getFieldMaybe(edit.name);
    if (!field) {
      report.problems.push(`champ « ${edit.name} » introuvable`);
      continue;
    }
    try {
      if (edit.deleted) {
        deleteField(doc, form, field, pages);
        report.applied++;
        continue;
      }
      if (edit.props) setFieldProps(doc, form, field, edit.props);
      if (edit.rects) {
        for (const w of field.acroField.getWidgets()) {
          const hit = pages.get(w.dict);
          const r = hit?.ref ? edit.rects[pdfjsId(hit.ref)] : undefined;
          if (!r || !hit) continue;
          w.dict.set(PDFName.of("Rect"), doc.context.obj(rectToPdf(hit.page, r)));
          const isBox = field instanceof PDFCheckBox || field instanceof PDFRadioGroup;
          // A box keeps its drawings (scaled to the new Rect by every viewer).
          if (!isBox) w.dict.delete(PDFName.of("AP"));
        }
      }
      if (edit.rename && edit.rename !== edit.name) {
        const problem = renameField(doc, form, field, edit.rename);
        if (problem) report.problems.push(`« ${edit.name} » : ${problem}`);
      }
      report.applied++;
    } catch (e) {
      report.problems.push(`« ${edit.name} » : ${e instanceof Error ? e.message : "modification impossible"}`);
    }
  }
  return report;
}
