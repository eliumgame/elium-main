/**
 * Form fields inside the written PDF: appearance streams and flattening.
 *
 * pdf.js' `saveDocument()` writes the filled-in values and, for each changed
 * field, a new appearance stream in the field's own font. When a value holds a
 * character that font cannot encode (the standard Helvetica of most forms is
 * WinAnsi-only: « Wałęsa », « Łódź », Greek, Cyrillic…) it writes NO
 * appearance and raises the AcroForm's /NeedAppearances flag instead, leaving
 * it to the next viewer — which prints nothing in many of them, cannot be
 * flattened, and makes Acrobat treat the file as modified on open.
 *
 * `completeFieldAppearances` fills that gap the way Acrobat does: an
 * appearance drawn with an embedded (subset) Unicode font — Liberation Sans,
 * shipped with pdf.js' assets (so available offline, in the desktop app and in
 * the Drive alike), or a font the user imported — and clears /NeedAppearances
 * once every field has one. The field's /DA is left untouched (auto size and
 * font name survive, so Acrobat edits the field as before).
 *
 * `flattenFields` bakes the visible fields into the page content, following
 * ISO 32000 §12.5.5 (appearance BBox × Matrix mapped onto /Rect): hidden or
 * non-printing widgets are dropped WITHOUT being drawn, fields without an
 * appearance (an empty signature field) are dropped, and the report says which
 * values could not be drawn.
 */

import fontkit from "@pdf-lib/fontkit";
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
  PDFStream,
  PDFString,
  PDFTextField,
  StandardFonts,
  TextAlignment,
  adjustDimsForRotation,
  cmyk,
  componentsToColor,
  defaultOptionListAppearanceProvider,
  drawTextField,
  grayscale,
  layoutCombedText,
  layoutMultilineText,
  layoutSinglelineText,
  reduceRotation,
  rgb,
  rotateInPlace,
} from "pdf-lib";
import type { Color, PDFDocument, PDFField, PDFFont, PDFForm, PDFOperator, PDFPage, PDFWidgetAnnotation } from "pdf-lib";
import { pdfjsAssetUrls } from "../core/assets";
import { customFontNames, getCustomFont } from "../../ui/fonts";

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export type FontStyle = "r" | "b" | "i" | "bi";

const LIBERATION: Record<FontStyle, string> = {
  r: "LiberationSans-Regular.ttf",
  b: "LiberationSans-Bold.ttf",
  i: "LiberationSans-Italic.ttf",
  bi: "LiberationSans-BoldItalic.ttf",
};
const STANDARD: Record<FontStyle, StandardFonts> = {
  r: StandardFonts.Helvetica,
  b: StandardFonts.HelveticaBold,
  i: StandardFonts.HelveticaOblique,
  bi: StandardFonts.HelveticaBoldOblique,
};

const fontBytes = new Map<string, Promise<Uint8Array | null>>();

/** Bytes of one of pdf.js' bundled Liberation Sans faces (null when unavailable). */
export function liberationBytes(style: FontStyle): Promise<Uint8Array | null> {
  const file = LIBERATION[style];
  let p = fontBytes.get(file);
  if (!p) {
    p = (async () => {
      const urls = pdfjsAssetUrls();
      if (urls) {
        const res = await fetch(`${urls.standardFontDataUrl}${file}`);
        if (!res.ok) return null;
        return new Uint8Array(await res.arrayBuffer());
      }
      // Node (tests, scripts): straight from node_modules.
      const proc = (globalThis as { process?: { cwd(): string } }).process;
      if (!proc) return null;
      const fsName = "node:fs/promises";
      const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(p: string): Promise<Uint8Array> };
      for (const dir of ["node_modules/pdfjs-dist/standard_fonts/", "web-studio/node_modules/pdfjs-dist/standard_fonts/"]) {
        try {
          return new Uint8Array(await fs.readFile(`${proc.cwd()}/${dir}${file}`));
        } catch {
          /* next candidate */
        }
      }
      return null;
    })().catch(() => null);
    fontBytes.set(file, p);
  }
  return p;
}

interface Coverage {
  hasGlyphForCodePoint(cp: number): boolean;
}
const coverageCache = new WeakMap<Uint8Array, Coverage | null>();
function coverageOf(bytes: Uint8Array): Coverage | null {
  if (coverageCache.has(bytes)) return coverageCache.get(bytes)!;
  let c: Coverage | null = null;
  try {
    c = (fontkit as unknown as { create(b: Uint8Array): Coverage }).create(bytes);
  } catch {
    c = null;
  }
  coverageCache.set(bytes, c);
  return c;
}

const WINANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Can a standard (WinAnsi) font show every character of `text`? */
export function isWinAnsi(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 10 || c === 13 || c === 9) continue;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) continue;
    if (WINANSI_EXTRA.has(ch)) continue;
    return false;
  }
  return true;
}

/** Characters of `text` a font does not cover. */
function uncovered(text: string, cov: Coverage): string {
  let out = "";
  for (const ch of new Set(text)) {
    const c = ch.codePointAt(0)!;
    if (c === 10 || c === 13 || c === 9 || c === 0x20) continue;
    if (!cov.hasGlyphForCodePoint(c)) out += ch;
  }
  return out;
}

/** Fonts for field appearances in one output document (cached, subset-embedded). */
export class FieldFontBook {
  private embedded = new Map<string, Promise<PDFFont | null>>();
  private fontkitReady = false;

  constructor(private readonly doc: PDFDocument) {}

  private registerFontkit(): void {
    if (this.fontkitReady) return;
    this.doc.registerFontkit(fontkit);
    this.fontkitReady = true;
  }

  private embed(key: string, make: () => Promise<PDFFont | null>): Promise<PDFFont | null> {
    let p = this.embedded.get(key);
    if (!p) {
      p = make().catch(() => null);
      this.embedded.set(key, p);
    }
    return p;
  }

  /**
   * A font showing every character of `text`: the standard face when WinAnsi
   * suffices, else Liberation Sans, else an imported font that covers it.
   * `missing` lists what nothing covers (the result is then null).
   */
  async pick(text: string, style: FontStyle): Promise<{ font: PDFFont | null; missing: string }> {
    if (isWinAnsi(text)) {
      return { font: await this.embed(`std-${style}`, () => this.doc.embedFont(STANDARD[style])), missing: "" };
    }
    const lib = (await liberationBytes(style)) ?? (await liberationBytes("r"));
    let missing = text;
    if (lib) {
      const cov = coverageOf(lib);
      missing = cov ? uncovered(text, cov) : text;
      if (!missing) {
        this.registerFontkit();
        return {
          font: await this.embed(`lib-${style}`, () => this.doc.embedFont(lib, { subset: true })),
          missing: "",
        };
      }
    }
    for (const name of customFontNames()) {
      const bytes = getCustomFont(name);
      const cov = bytes ? coverageOf(bytes) : null;
      if (!bytes || !cov || uncovered(text, cov)) continue;
      this.registerFontkit();
      return { font: await this.embed(`custom-${name}`, () => this.doc.embedFont(bytes, { subset: true })), missing: "" };
    }
    return { font: null, missing };
  }
}

// ---------------------------------------------------------------------------
// Default appearance (/DA) helpers
// ---------------------------------------------------------------------------

const TF_RE = /\/([^\0\t\n\f\r ]+)[\0\t\n\f\r ]+(-?\d*\.?\d+)[\0\t\n\f\r ]+Tf/;
const COLOR_RE =
  /(\d*\.?\d+)[\0\t\n\f\r ]*(\d*\.?\d+)?[\0\t\n\f\r ]*(\d*\.?\d+)?[\0\t\n\f\r ]*(\d*\.?\d+)?[\0\t\n\f\r ]+(g|rg|k)(?![A-Za-z])/;

function decodeText(v: unknown): string | undefined {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return undefined;
}

/** The /DA that applies to a widget (widget, then the field and its parents, then the AcroForm). */
export function defaultAppearanceOf(widget: PDFWidgetAnnotation, field: PDFField, form: PDFForm): string {
  const own = decodeText(widget.dict.lookup(PDFName.of("DA")));
  if (own) return own;
  let dict: PDFDict | undefined = field.acroField.dict;
  for (let depth = 0; dict && depth < 32; depth++) {
    const da = decodeText(dict.lookup(PDFName.of("DA")));
    if (da) return da;
    const parent = dict.lookup(PDFName.of("Parent"));
    dict = parent instanceof PDFDict ? parent : undefined;
  }
  return decodeText(form.acroForm.dict.lookup(PDFName.of("DA"))) ?? "/Helv 0 Tf 0 g";
}

export function parseDA(da: string): { fontName: string | null; fontSize: number; color: Color } {
  let fontName: string | null = null;
  let fontSize = 0;
  let m: RegExpExecArray | null;
  const tf = new RegExp(TF_RE.source, "g");
  while ((m = tf.exec(da))) {
    fontName = m[1];
    fontSize = Math.max(0, Number(m[2]) || 0);
  }
  let color: Color = rgb(0, 0, 0);
  const cr = new RegExp(COLOR_RE.source, "g");
  let last: RegExpExecArray | null = null;
  while ((m = cr.exec(da))) last = m;
  if (last) {
    const [, a, b, c, d, op] = last;
    if (op === "g") color = grayscale(Number(a));
    else if (op === "rg" && c !== undefined) color = rgb(Number(a), Number(b), Number(c));
    else if (op === "k" && d !== undefined) color = cmyk(Number(a), Number(b), Number(c), Number(d));
  }
  return { fontName, fontSize, color };
}

/** Bold / italic of the /DA font (read from the /DR entry's BaseFont, else its resource name). */
function styleOfDA(fontName: string | null, form: PDFForm): FontStyle {
  let base = fontName ?? "";
  const dr = form.acroForm.dict.lookup(PDFName.of("DR"));
  const fonts = dr instanceof PDFDict ? dr.lookup(PDFName.of("Font")) : undefined;
  if (fontName && fonts instanceof PDFDict) {
    const f = fonts.lookup(PDFName.of(fontName));
    const bf = f instanceof PDFDict ? f.lookup(PDFName.of("BaseFont")) : undefined;
    if (bf instanceof PDFName) base = bf.decodeText();
  }
  const bold = /bold|bd\b|HeBo|HeBI|TiBo|TiBI|CoBo|CoBI/i.test(base);
  const italic = /italic|oblique|HeOb|HeBI|TiIt|TiBI|CoOb|CoBI/i.test(base);
  return bold && italic ? "bi" : bold ? "b" : italic ? "i" : "r";
}

// ---------------------------------------------------------------------------
// Appearances
// ---------------------------------------------------------------------------

function hasNormalAppearance(widget: PDFWidgetAnnotation): boolean {
  const ap = widget.dict.lookup(PDFName.of("AP"));
  if (!(ap instanceof PDFDict)) return false;
  const n = ap.get(PDFName.of("N"));
  return n instanceof PDFRef || n instanceof PDFStream || n instanceof PDFDict;
}

const ALIGN: Record<number, TextAlignment> = { 0: TextAlignment.Left, 1: TextAlignment.Center, 2: TextAlignment.Right };

/** Auto-size multi-line text: Acrobat starts at 12 pt and shrinks to fit. */
const AUTO_MULTILINE_MAX = 12;

interface DrawSpec {
  text: string;
  multiline: boolean;
  comb: number;
  alignment: TextAlignment;
}

/** Operators drawing `spec` into `widget` with `font` — Acrobat's text-field look, /DA untouched. */
function textAppearance(widget: PDFWidgetAnnotation, font: PDFFont, da: string, spec: DrawSpec): PDFOperator[] {
  const { fontSize: daSize, color: textColor } = parseDA(da);
  const rectangle = widget.getRectangle();
  const mk = widget.getAppearanceCharacteristics();
  const bs = widget.getBorderStyle();
  const borderWidth = bs?.getWidth() ?? (mk?.getBorderColor() ? 1 : 0);
  const rotation = reduceRotation(mk?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);
  const rotate = rotateInPlace({ ...rectangle, rotation });
  const borderColor = componentsToColor(mk?.getBorderColor());
  const background = componentsToColor(mk?.getBackgroundColor());
  const padding = spec.comb ? 0 : 2;
  const bounds = {
    x: borderWidth + padding,
    y: borderWidth + padding,
    width: Math.max(1, width - (borderWidth + padding) * 2),
    height: Math.max(1, height - (borderWidth + padding) * 2),
  };
  let textLines;
  let fontSize: number;
  if (spec.multiline) {
    let size = daSize || undefined;
    if (!size) {
      const fit = layoutMultilineText(spec.text, { alignment: spec.alignment, fontSize: undefined, font, bounds });
      size = Math.min(AUTO_MULTILINE_MAX, fit.fontSize);
    }
    const layout = layoutMultilineText(spec.text, { alignment: spec.alignment, fontSize: size, font, bounds });
    textLines = layout.lines;
    fontSize = layout.fontSize;
  } else if (spec.comb > 0) {
    const layout = layoutCombedText(spec.text, { fontSize: daSize || undefined, font, bounds, cellCount: spec.comb });
    textLines = layout.cells;
    fontSize = layout.fontSize;
  } else {
    const layout = layoutSinglelineText(spec.text, {
      alignment: spec.alignment,
      fontSize: daSize || undefined,
      font,
      bounds,
    });
    textLines = [layout.line];
    fontSize = layout.fontSize;
  }
  return [
    ...rotate,
    ...drawTextField({
      x: borderWidth / 2,
      y: borderWidth / 2,
      width: width - borderWidth,
      height: height - borderWidth,
      borderWidth,
      borderColor,
      textColor,
      font: font.name,
      fontSize,
      color: background,
      textLines,
      padding,
    }),
  ];
}

/** Save every /DA a pdf-lib appearance provider might rewrite, to put them back. */
function snapshotDA(field: PDFField): () => void {
  const dicts: PDFDict[] = [field.acroField.dict, ...field.acroField.getWidgets().map((w) => w.dict)];
  const saved = dicts.map((d) => [d, d.get(PDFName.of("DA"))] as const);
  return () => {
    for (const [d, v] of saved) {
      if (v === undefined) d.delete(PDFName.of("DA"));
      else d.set(PDFName.of("DA"), v);
    }
  };
}

export interface AppearanceReport {
  /** Fields that got a new appearance. */
  generated: string[];
  /** Fields whose value holds characters no available font covers. */
  uncovered: { field: string; chars: string }[];
  /** /NeedAppearances was raised and could be cleared. */
  clearedNeedAppearances: boolean;
}

function textOf(field: PDFField): { text: string; spec: Omit<DrawSpec, "text"> } | null {
  if (field instanceof PDFTextField) {
    return {
      text: field.getText() ?? "",
      spec: {
        multiline: field.isMultiline(),
        comb: field.isCombed() ? (field.getMaxLength() ?? 0) : 0,
        alignment: ALIGN[field.acroField.getQuadding() ?? 0] ?? TextAlignment.Left,
      },
    };
  }
  if (field instanceof PDFDropdown) {
    // The LABEL of the chosen export value — never the code (« Suisse », not « CH »).
    const value = field.acroField.getValues()[0];
    const v = value ? value.decodeText() : "";
    const opt = field.acroField.getOptions().find((o) => o.value.decodeText() === v);
    return {
      text: opt?.display?.decodeText() ?? v,
      spec: { multiline: false, comb: 0, alignment: ALIGN[field.acroField.getQuadding() ?? 0] ?? TextAlignment.Left },
    };
  }
  return null;
}

/**
 * Give every text / list field that lacks an appearance one drawn with a
 * font that covers its value (see the file header).
 */
export async function completeFieldAppearances(doc: PDFDocument, fonts: FieldFontBook): Promise<AppearanceReport> {
  const report: AppearanceReport = { generated: [], uncovered: [], clearedNeedAppearances: false };
  let form: PDFForm;
  try {
    form = doc.getForm();
  } catch {
    return report;
  }
  let fields: PDFField[];
  try {
    fields = form.getFields();
  } catch {
    return report;
  }
  let stillLacking = false;
  for (const field of fields) {
    let widgets: PDFWidgetAnnotation[];
    try {
      widgets = field.acroField.getWidgets();
    } catch {
      continue;
    }
    const lacking = widgets.filter((w) => !hasNormalAppearance(w));
    if (!lacking.length) continue;
    const name = field.getName();
    try {
      if (field instanceof PDFTextField || field instanceof PDFDropdown) {
        const t = textOf(field)!;
        if (!t.text) {
          // Nothing to show: an empty appearance (background / border only).
          await drawField(field, form, fonts, lacking, { ...t.spec, text: "" });
          continue;
        }
        const da = defaultAppearanceOf(lacking[0], field, form);
        const { font, missing } = await fonts.pick(t.text, styleOfDA(parseDA(da).fontName, form));
        if (!font) {
          report.uncovered.push({ field: name, chars: missing });
          stillLacking = true;
          continue;
        }
        await drawField(field, form, fonts, lacking, { ...t.spec, text: t.text }, font);
        report.generated.push(name);
      } else if (field instanceof PDFOptionList) {
        const labels = field.getOptions().join("\n");
        const da = defaultAppearanceOf(lacking[0], field, form);
        const { font, missing } = await fonts.pick(labels, styleOfDA(parseDA(da).fontName, form));
        if (!font) {
          report.uncovered.push({ field: name, chars: missing });
          stillLacking = true;
          continue;
        }
        const restore = snapshotDA(field);
        try {
          field.updateAppearances(font, defaultOptionListAppearanceProvider);
        } finally {
          restore();
        }
        report.generated.push(name);
      } else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
        // Boxes carry their on/off appearances in the file; one without any
        // still relies on the viewer.
        stillLacking = true;
      }
    } catch {
      stillLacking = true;
    }
  }
  const na = form.acroForm.dict.lookup(PDFName.of("NeedAppearances"));
  if (na && na.toString() === "true" && !stillLacking) {
    form.acroForm.dict.delete(PDFName.of("NeedAppearances"));
    report.clearedNeedAppearances = true;
  }
  return report;
}

async function drawField(
  field: PDFTextField | PDFDropdown,
  form: PDFForm,
  fonts: FieldFontBook,
  widgets: PDFWidgetAnnotation[],
  spec: DrawSpec,
  font?: PDFFont,
): Promise<void> {
  const useFont = font ?? (await fonts.pick("", "r")).font;
  if (!useFont) return;
  const doc = form.doc;
  for (const widget of widgets) {
    const da = defaultAppearanceOf(widget, field, form);
    const ops = textAppearance(widget, useFont, da, spec);
    // Same frame as pdf-lib's own appearances: BBox = the widget's size, the
    // /MK rotation is inside the operators (rotateInPlace).
    const { width, height } = widget.getRectangle();
    const stream = doc.context.formXObject(ops, {
      BBox: doc.context.obj([0, 0, width, height]),
      Matrix: doc.context.obj([1, 0, 0, 1, 0, 0]),
      Resources: { Font: { [useFont.name]: useFont.ref } },
    });
    const ref = doc.context.register(stream);
    widget.setNormalAppearance(ref);
  }
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

export interface FlattenReport {
  /** Widgets drawn into the page content. */
  drawn: number;
  /** Hidden / non-printing widgets removed without being drawn. */
  hiddenRemoved: number;
  /** Fields holding a value that could not be drawn (no appearance). */
  notDrawn: string[];
  /** Fields in the form before flattening. */
  fields: number;
}

const F_HIDDEN = 2;
const F_PRINT = 4;
const F_NOVIEW = 32;

type Matrix = [number, number, number, number, number, number];

function numbers(arr: unknown, n: number): number[] | null {
  if (!(arr instanceof PDFArray) || arr.size() < n) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = arr.lookup(i);
    if (!(v instanceof PDFNumber)) return null;
    out.push(v.asNumber());
  }
  return out;
}

/** The matrix mapping an appearance (BBox transformed by its Matrix) onto the widget's Rect (§12.5.5). */
export function appearanceMatrix(bbox: number[], matrix: Matrix, rect: number[]): Matrix {
  const [a, b, c, d, e, f] = matrix;
  const pts = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[0], bbox[3]],
    [bbox[2], bbox[3]],
  ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  const rx = Math.min(rect[0], rect[2]);
  const ry = Math.min(rect[1], rect[3]);
  const rw = Math.abs(rect[2] - rect[0]);
  const rh = Math.abs(rect[3] - rect[1]);
  const sx = maxX - minX > 1e-9 ? rw / (maxX - minX) : 1;
  const sy = maxY - minY > 1e-9 ? rh / (maxY - minY) : 1;
  return [sx, 0, 0, sy, rx - minX * sx, ry - minY * sy];
}

const fmt = (n: number) => (Math.abs(n) < 1e-9 ? "0" : String(Math.round(n * 10000) / 10000));

/** Every annotation dict on a page → its reference and page (one pass, not a search per widget). */
function pageOfWidgets(doc: PDFDocument): Map<PDFDict, { page: PDFPage; ref: PDFRef }> {
  const out = new Map<PDFDict, { page: PDFPage; ref: PDFRef }>();
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (!(ref instanceof PDFRef)) continue;
      const dict = doc.context.lookup(ref);
      if (dict instanceof PDFDict) out.set(dict, { page, ref });
    }
  }
  return out;
}

function removeFromAnnots(page: PDFPage, ref: PDFRef): void {
  const annots = page.node.Annots();
  if (!annots) return;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const r = annots.get(i);
    if (r instanceof PDFRef && r.objectNumber === ref.objectNumber && r.generationNumber === ref.generationNumber) {
      annots.remove(i);
    }
  }
}

function hasValue(field: PDFField): boolean {
  if (field instanceof PDFTextField) return !!field.getText();
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return field.getSelected().length > 0;
  if (field instanceof PDFCheckBox) return field.isChecked();
  if (field instanceof PDFRadioGroup) return !!field.getSelected();
  return false;
}

/**
 * Bake the form into the pages: every visible, printable widget's appearance
 * becomes page content; the fields are removed from the AcroForm.
 */
export function flattenFields(doc: PDFDocument): FlattenReport {
  const report: FlattenReport = { drawn: 0, hiddenRemoved: 0, notDrawn: [], fields: 0 };
  let form: PDFForm;
  let fields: PDFField[];
  try {
    form = doc.getForm();
    fields = form.getFields();
  } catch {
    return report;
  }
  report.fields = fields.length;
  const pageOf = pageOfWidgets(doc);
  const draws = new Map<PDFPage, string[]>();
  const context = doc.context;

  for (const field of fields) {
    let widgets: PDFWidgetAnnotation[];
    try {
      widgets = field.acroField.getWidgets();
    } catch {
      continue;
    }
    let lostValue = false;
    for (const widget of widgets) {
      const hit = pageOf.get(widget.dict);
      const page = hit?.page ?? null;
      const ref = hit?.ref ?? null;
      const flags = widget.getFlags();
      if (flags & F_HIDDEN || flags & F_NOVIEW || !(flags & F_PRINT)) {
        if (page && ref) removeFromAnnots(page, ref);
        report.hiddenRemoved++;
        continue;
      }
      // The appearance to draw: /N, or its /AS state for boxes.
      const ap = widget.dict.lookup(PDFName.of("AP"));
      let n = ap instanceof PDFDict ? ap.get(PDFName.of("N")) : undefined;
      let nObj = n instanceof PDFRef ? context.lookup(n) : n;
      if (nObj instanceof PDFDict && !(nObj instanceof PDFStream)) {
        const as = widget.getAppearanceState();
        n = as ? nObj.get(as) : undefined;
        nObj = n instanceof PDFRef ? context.lookup(n) : n;
      }
      if (!page || !ref) continue;
      removeFromAnnots(page, ref);
      if (!(nObj instanceof PDFStream)) {
        if (hasValue(field)) lostValue = true;
        continue;
      }
      const streamRef = n instanceof PDFRef ? n : context.register(nObj);
      const dict = nObj.dict;
      if (!dict.get(PDFName.of("Subtype"))) dict.set(PDFName.of("Subtype"), PDFName.of("Form"));
      if (!dict.get(PDFName.of("Type"))) dict.set(PDFName.of("Type"), PDFName.of("XObject"));
      const rect = numbers(widget.dict.lookup(PDFName.of("Rect")), 4);
      if (!rect) continue;
      const bbox = numbers(dict.lookup(PDFName.of("BBox")), 4) ?? [0, 0, Math.abs(rect[2] - rect[0]), Math.abs(rect[3] - rect[1])];
      const matrix = (numbers(dict.lookup(PDFName.of("Matrix")), 6) as Matrix | null) ?? [1, 0, 0, 1, 0, 0];
      if (Math.abs(bbox[2] - bbox[0]) < 1e-9 || Math.abs(bbox[3] - bbox[1]) < 1e-9) continue;
      const m = appearanceMatrix(bbox, matrix, rect);
      const key = page.node.newXObject("FlatField", streamRef);
      const list = draws.get(page) ?? [];
      list.push(`q ${m.map(fmt).join(" ")} cm ${key.toString()} Do Q`);
      draws.set(page, list);
      report.drawn++;
    }
    if (lostValue) report.notDrawn.push(field.getName());
  }

  for (const [page, ops] of draws) {
    // The page's own content may leave the graphics state altered: wrap it.
    const start = context.register(context.stream("q\n"));
    const end = context.register(context.stream("Q\n"));
    page.node.wrapContentStreams(start, end);
    page.node.addContentStream(context.register(context.stream(`${ops.join("\n")}\n`)));
  }

  // The form itself goes: no field survives a flattening.
  form.acroForm.dict.set(PDFName.of("Fields"), context.obj([]));
  form.acroForm.dict.delete(PDFName.of("NeedAppearances"));
  form.acroForm.dict.delete(PDFName.of("CO"));
  form.acroForm.dict.delete(PDFName.of("XFA"));
  return report;
}
