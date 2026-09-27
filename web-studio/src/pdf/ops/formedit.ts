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
import type { FieldEdit, FieldProps, FormValue } from "../model/types";
import { calculateScript, formatScripts, validateScript } from "../core/forms/afscripts";
import { formOf } from "./pdfform";

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
// Acrobat JavaScript (built in core/forms/afscripts.ts)
// ---------------------------------------------------------------------------

export { calculateScript, formatScripts, validateScript };

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

/** The field's flags, inherited from its parents when it has none of its own. */
function flags(field: PDFField): number {
  return field.acroField.getFlags();
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

/**
 * Rewrite the font size of a /DA string (0 = auto), keeping font and colour.
 * The LAST « Tf » is the one viewers use; numbers may be « +12 » or « 12. ».
 */
export function withFontSize(da: string, size: number): string {
  const re = /(\/[^\s/()<>[\]{}%]+\s+)([+-]?(?:\d+\.?\d*|\.\d+))(\s+Tf)/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(da))) last = m;
  if (!last) return `/Helv ${size} Tf ${da}`.trim();
  return da.slice(0, last.index) + `${last[1]}${size}${last[3]}` + da.slice(last.index + last[0].length);
}

/** The /DA that applies to a field: its own, inherited from its parents, or the AcroForm's. */
function inheritedDA(field: PDFField, form: PDFForm): string {
  const own = decode(field.acroField.getInheritableAttribute(PDFName.of("DA")));
  return own ?? decode(form.acroForm.dict.lookup(PDFName.of("DA"))) ?? "/Helv 0 Tf 0 g";
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

/** The on-state (export value) a box widget declares in its /AP /N. */
function onStateOf(widget: PDFWidgetAnnotation): string | null {
  const n = widget.getAppearances()?.normal;
  if (!(n instanceof PDFDict)) return null;
  return (
    n
      .keys()
      .map((k) => k.decodeText())
      .find((k) => k !== "Off") ?? null
  );
}

/** Index of a widget among its field's kids (the /Opt index, §12.7.4.2.3). */
function kidIndex(field: PDFField, widget: PDFWidgetAnnotation): number {
  return field.acroField.getWidgets().findIndex((w) => w.dict === widget.dict);
}

/**
 * Give one box widget a new export value. With /Opt the value lives in /Opt
 * (the state name stays an index); otherwise the on-state is renamed in /AP
 * /N and /D, and /AS, /V, /DV follow when they named it.
 */
function setExportValue(doc: PDFDocument, field: PDFField, widget: PDFWidgetAnnotation, next: string): void {
  const opt = field.acroField.getInheritableAttribute(PDFName.of("Opt"));
  const i = kidIndex(field, widget);
  if (opt instanceof PDFArray && i >= 0 && i < opt.size()) {
    opt.set(i, text(next));
    return;
  }
  const previous = onStateOf(widget);
  if (previous === null || previous === next) return;
  const ap = widget.dict.lookup(PDFName.of("AP")) as PDFDict;
  for (const key of ["N", "D"]) {
    const sub = ap.lookup(PDFName.of(key));
    if (!(sub instanceof PDFDict)) continue;
    const on = sub.keys().find((k) => k.decodeText() === previous);
    if (!on) continue;
    const v = sub.get(on)!;
    sub.delete(on);
    sub.set(PDFName.of(next), v);
  }
  if (widget.getAppearanceState()?.decodeText() === previous) widget.setAppearanceState(PDFName.of(next));
  for (const key of ["V", "DV"]) {
    const v = field.acroField.dict.lookup(PDFName.of(key));
    if (v instanceof PDFName && v.decodeText() === previous)
      field.acroField.dict.set(PDFName.of(key), PDFName.of(next));
  }
  void doc;
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
      // A widget's own /DA, else the field's (inherited from its parents, then the form's).
      const da = (d !== dict && decode(d.lookup(PDFName.of("DA")))) || inheritedDA(field, form);
      d.set(PDFName.of("DA"), PDFString.of(withFontSize(da, props.fontSize)));
    }
  }
  if (props.align !== undefined) {
    redraw = true;
    dict.set(PDFName.of("Q"), PDFNumber.of({ left: 0, center: 1, right: 2 }[props.align]));
  }

  if ((field instanceof PDFCheckBox || field instanceof PDFRadioGroup) && props.exportValue && widgets[0]) {
    // A created box (one widget); the file's boxes are edited per widget (`exportValues`).
    setExportValue(doc, field, widgets[0], props.exportValue);
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
    const states = field.acroField
      .getWidgets()
      .map(onStateOf)
      .filter((x): x is string => !!x);
    let s =
      v === true ? (states[0] ?? "Yes") : v === false || v === "" ? "Off" : Array.isArray(v) ? (v[0] ?? "Off") : v;
    // A value that names no state (« Oui » for a « Yes » box): the box's own on-state.
    if (s !== "Off" && !states.includes(s)) s = states[0] ?? s;
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

/** The node of the field name tree at `parts` (terminal field or not), if any. */
function nodeAt(form: PDFForm, parts: readonly string[]): PDFDict | null {
  let list: unknown = form.acroForm.dict.lookup(PDFName.of("Fields"));
  let node: PDFDict | null = null;
  for (const part of parts) {
    if (!(list instanceof PDFArray)) return null;
    node = null;
    for (let i = 0; i < list.size(); i++) {
      const d = list.lookup(i);
      if (d instanceof PDFDict && decode(d.lookup(PDFName.of("T"))) === part) node = d;
    }
    if (!node) return null;
    list = node.lookup(PDFName.of("Kids"));
  }
  return node;
}

/** A field (as opposed to a mere branch of the name tree): it has a type, or widgets as kids. */
function isTerminal(dict: PDFDict): boolean {
  if (dict.has(PDFName.of("FT"))) return true;
  const kids = dict.lookup(PDFName.of("Kids"));
  if (!(kids instanceof PDFArray) || kids.size() === 0) return true;
  const first = kids.lookup(0);
  return first instanceof PDFDict && !first.has(PDFName.of("T"));
}

/** Entries a field may inherit from its parents (§12.7.3.1, table 220 and after). */
const INHERITABLE = ["FT", "Ff", "V", "DV", "DA", "Q", "MaxLen", "Opt"];

function renameField(doc: PDFDocument, form: PDFForm, field: PDFField, to: string): string | null {
  const parts = to.split(".").filter(Boolean);
  if (!parts.length) return "nom vide";
  const dict = field.acroField.dict;
  // Taken: any node of the tree with that name, field or branch (« a » when « a.b » exists).
  const existing = nodeAt(form, parts);
  if (existing && existing !== dict) return `le nom « ${to} » est déjà pris`;
  // A prefix that is itself a field cannot become a branch (« grp.x » → « grp.x.y »).
  for (let k = 1; k < parts.length; k++) {
    const n = nodeAt(form, parts.slice(0, k));
    if (n && isTerminal(n)) return `« ${parts.slice(0, k).join(".")} » est un champ, pas un groupe`;
  }
  const from = field.getName().split(".");
  const samePrefix = from.slice(0, -1).join(".") === parts.slice(0, -1).join(".");
  dict.set(PDFName.of("T"), text(parts[parts.length - 1]));
  if (samePrefix) return null;
  // Another branch of the name tree: move the field there, taking along what
  // it inherited from its old parents (type, flags, value, appearance…).
  for (const key of INHERITABLE) {
    if (dict.has(PDFName.of(key))) continue;
    const v = field.acroField.getInheritableAttribute(PDFName.of(key));
    if (v !== undefined) dict.set(PDFName.of(key), v);
  }
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
    form = formOf(doc);
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
      if (edit.removeWidgets?.length) {
        const widgets = field.acroField.getWidgets();
        const gone = widgets.filter((w) => {
          const ref = pages.get(w.dict)?.ref;
          return !!ref && edit.removeWidgets!.includes(pdfjsId(ref));
        });
        if (gone.length === widgets.length) {
          deleteField(doc, form, field, pages);
          report.applied++;
          continue;
        }
        const kids = field.acroField.dict.lookup(PDFName.of("Kids"));
        // /Opt: the i-th entry belongs to the i-th kid — splice it with the kid.
        const opt = field.acroField.getInheritableAttribute(PDFName.of("Opt"));
        const indices = gone.map((w) => kidIndex(field, w)).sort((a, b) => b - a);
        const goneStates = new Set(gone.map(onStateOf).filter((x): x is string => !!x));
        for (const w of gone) {
          const hit = pages.get(w.dict);
          if (hit) removeFrom(hit.page.node.Annots(), w.dict, doc);
          if (kids instanceof PDFArray) removeFrom(kids, w.dict, doc);
        }
        if (opt instanceof PDFArray) {
          const own = opt.clone();
          for (const i of indices) if (i >= 0 && i < own.size()) own.remove(i);
          field.acroField.dict.set(PDFName.of("Opt"), own);
        }
        // A value naming a removed button selects nothing any more.
        const v = field.acroField.dict.lookup(PDFName.of("V"));
        if (v instanceof PDFName && goneStates.has(v.decodeText()))
          field.acroField.dict.set(PDFName.of("V"), PDFName.of("Off"));
      }
      if (edit.props) setFieldProps(doc, form, field, edit.props);
      if (edit.exportValues && (field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) {
        for (const w of field.acroField.getWidgets()) {
          const ref = pages.get(w.dict)?.ref;
          const next = ref ? edit.exportValues[pdfjsId(ref)] : undefined;
          if (next) setExportValue(doc, field, w, next);
        }
      }
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
