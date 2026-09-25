// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  StandardFonts,
} from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { savePdf } from "../src/pdf/ops/save";
import { applyFieldEdits, setFieldProps, withFontSize } from "../src/pdf/ops/formedit";
import { completeFieldAppearances, FieldFontBook, writeFieldValues } from "../src/pdf/ops/formpdf";
import { formOf } from "../src/pdf/ops/pdfform";
import {
  parseFdf,
  parseTabText,
  matchImported,
  toTabText,
  toXfdfFields,
  parseXfdfFields,
} from "../src/pdf/ops/formdata";
import { parseFormat } from "../src/pdf/core/forms/afscripts";
import type { FormField } from "../src/pdf/core/forms/values";
import * as D from "../src/pdf/model/doc";
import { emptyState, type FieldEdit, type PdfState } from "../src/pdf/model/types";

/**
 * Regression tests for the adversarial review of T2 (form writing): each
 * `it` names the defect it reproduces.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

const T = (s: string) => PDFHexString.fromText(s);

/**
 * A page with a hierarchy built by hand: parent « grp » (/FT /Tx, /Ff
 * multiline, /DA Courier red) whose kid « name » is a field merged with its
 * widget, holding /V (Dupont) — and a plain root field « solo ».
 */
async function hierarchy(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const ctx = doc.context;
  const form = formOf(doc);
  const cour = await doc.embedFont(StandardFonts.Courier);
  const dr = ctx.obj({ Font: { Cour: cour.ref } });
  form.acroForm.dict.set(PDFName.of("DR"), dr);
  const parentRef = ctx.nextRef();
  const kid = ctx.obj({
    Type: "Annot",
    Subtype: "Widget",
    T: T("name"),
    V: T("Dupont"),
    Rect: [20, 200, 200, 220],
    F: 4,
    P: page.ref,
    Parent: parentRef,
  });
  const kidRef = ctx.register(kid);
  ctx.assign(parentRef, ctx.obj({ T: T("grp"), FT: "Tx", Ff: 4096, DA: T("/Cour 10 Tf 1 0 0 rg"), Kids: [kidRef] }));
  const solo = ctx.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Tx",
    T: T("solo"),
    Rect: [20, 100, 200, 120],
    F: 4,
    P: page.ref,
  });
  const soloRef = ctx.register(solo);
  page.node.set(PDFName.of("Annots"), ctx.obj([kidRef, soloRef]));
  form.acroForm.dict.set(PDFName.of("Fields"), ctx.obj([parentRef, soloRef]));
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

async function fieldsOf(bytes: Uint8Array): Promise<Record<string, { value?: unknown; type?: string }[]>> {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  const objs = ((await doc.getFieldObjects()) ?? {}) as Record<string, { value?: unknown; type?: string }[]>;
  await task.destroy();
  return objs;
}

const state = (edits: FieldEdit[] = [], values: PdfState["formValues"] = {}): PdfState => ({
  ...emptyState(),
  pages: D.pagesFromSource(1),
  fieldEdits: edits,
  formValues: values,
});

describe("T2 review — renaming and the name tree", () => {
  it("#1 a field moved to another branch keeps what it inherited (type, value)", async () => {
    const r = await savePdf({ source: await hierarchy(), state: state([{ name: "grp.name", rename: "other.name" }]) });
    expect(r.report.lost).toEqual([]);
    const f = await fieldsOf(r.bytes);
    const got = f["other.name"]?.find((o) => o.value !== undefined);
    expect(got?.value).toBe("Dupont");
    expect(got?.type).toBe("text");
    expect(f["grp.name"]).toBeUndefined();
  });

  it("#2 refuses a name that is a branch, or under a field", async () => {
    const r1 = await savePdf({ source: await hierarchy(), state: state([{ name: "solo", rename: "grp" }]) });
    expect(r1.report.lost.join(" ")).toContain("déjà pris");
    const r2 = await savePdf({ source: await hierarchy(), state: state([{ name: "solo", rename: "grp.name.x" }]) });
    expect(r2.report.lost.join(" ")).toContain("est un champ");
    expect((await fieldsOf(r2.bytes))["grp.name"]).toBeDefined();
  });
});

describe("T2 review — inherited settings", () => {
  it("#3 setting a flag keeps the flags inherited from the parent", async () => {
    const doc = await PDFDocument.load(await hierarchy());
    const form = formOf(doc);
    const field = form.getTextField("grp.name");
    setFieldProps(doc, form, field, { required: true });
    expect(field.isMultiline()).toBe(true);
    expect(field.isRequired()).toBe(true);
  });

  it("#4 a new font size keeps the inherited /DA's font and colour", async () => {
    const doc = await PDFDocument.load(await hierarchy());
    const form = formOf(doc);
    setFieldProps(doc, form, form.getTextField("grp.name"), { fontSize: 14 });
    expect(form.getTextField("grp.name").acroField.dict.lookup(PDFName.of("DA"))?.toString()).toContain(
      "/Cour 14 Tf 1 0 0 rg",
    );
  });

  it("#16 odd /DA numbers, and the LAST Tf, are rewritten", () => {
    expect(withFontSize("/F1 +12 Tf 0 g", 14)).toBe("/F1 14 Tf 0 g");
    expect(withFontSize("/F1 12. Tf 0 g", 9)).toBe("/F1 9 Tf 0 g");
    expect(withFontSize("/Helv 12 Tf 0 g /Helv 9 Tf", 11)).toBe("/Helv 12 Tf 0 g /Helv 11 Tf");
  });

  it("#10 WinAnsi text keeps a Courier /DA's family", async () => {
    const doc = await PDFDocument.load(await hierarchy());
    writeFieldValues(doc, { "grp.name": "hello" });
    await completeFieldAppearances(doc, new FieldFontBook(doc));
    const w = formOf(doc).getTextField("grp.name").acroField.getWidgets()[0];
    const n = w.getAppearances()?.normal;
    const stream = (n instanceof PDFRef ? doc.context.lookup(n) : n) as PDFStream;
    // (The font dict itself is written by pdf-lib at flush time: its resource name tells the face.)
    const fonts = stream.dict.lookup(PDFName.of("Resources"), PDFDict).lookup(PDFName.of("Font"), PDFDict);
    expect(fonts.keys().map((k) => k.decodeText())).toEqual(["Courier"]);
  });
});

describe("T2 review — box export values", () => {
  async function checked(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const cb = formOf(doc).createCheckBox("cb");
    cb.addToPage(page, { x: 20, y: 20, width: 14, height: 14 });
    cb.check();
    return doc.save({ updateFieldAppearances: false });
  }

  it("#5 renaming a checkbox's export value carries /V along (it stays checked)", async () => {
    const src = await checked();
    const task = pdfjsLib.getDocument({ data: src.slice(), isEvalSupported: false });
    const js = await task.promise;
    const id = ((await (await js.getPage(1)).getAnnotations()) as { id: string; fieldName?: string }[]).find(
      (a) => a.fieldName === "cb",
    )!.id;
    await task.destroy();
    const r = await savePdf({ source: src, state: state([{ name: "cb", exportValues: { [id]: "Oui" } }]) });
    const doc = await PDFDocument.load(r.bytes);
    const box = formOf(doc).getCheckBox("cb");
    expect(box.isChecked()).toBe(true);
    expect(box.acroField.dict.lookup(PDFName.of("V"))?.toString()).toBe("/Oui");
  });

  it("#6 removing a radio button splices /Opt, so the others still select", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const g = formOf(doc).createRadioGroup("r");
    for (const [i, o] of ["A", "B", "C"].entries())
      g.addOptionToPage(o, page, { x: 20 + i * 30, y: 20, width: 14, height: 14 });
    const src = await doc.save({ updateFieldAppearances: false });
    const task = pdfjsLib.getDocument({ data: src.slice(), isEvalSupported: false });
    const js = await task.promise;
    const ids = ((await (await js.getPage(1)).getAnnotations()) as { id: string; fieldName?: string }[])
      .filter((a) => a.fieldName === "r")
      .map((a) => a.id);
    await task.destroy();
    const out = await PDFDocument.load(src);
    applyFieldEdits(out, [{ name: "r", removeWidgets: [ids[1]] }]);
    const res = writeFieldValues(out, { r: "C" });
    expect(res.skipped).toEqual([]);
    const opt = formOf(out).getRadioGroup("r").acroField.dict.lookup(PDFName.of("Opt"), PDFArray);
    expect(opt.size()).toBe(2);
    expect(formOf(out).getRadioGroup("r").getSelected()).toBe("C");
  });

  it("#17 a default « true » names the box's real on-state", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const cb = formOf(doc).createCheckBox("cb");
    cb.addToPage(page, { x: 20, y: 20, width: 14, height: 14 });
    setFieldProps(doc, formOf(doc), cb, { defaultValue: true });
    expect(cb.acroField.dict.lookup(PDFName.of("DV"))?.toString()).toBe("/Yes");
    setFieldProps(doc, formOf(doc), cb, { defaultValue: "Oui" });
    expect(cb.acroField.dict.lookup(PDFName.of("DV"))?.toString()).toBe("/Yes");
  });
});

describe("T2 review — appearances", () => {
  it("#7 a value no font can show leaves /NeedAppearances raised, never nothing", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    formOf(doc).createTextField("t").addToPage(page, { x: 20, y: 20, width: 150, height: 20, font });
    const src = await doc.save({ updateFieldAppearances: false });
    const r = await savePdf({ source: src, state: { ...state(), formValues: { t: "漢字" } } });
    const out = await PDFDocument.load(r.bytes);
    expect(formOf(out).acroForm.dict.lookup(PDFName.of("NeedAppearances"))?.toString()).toBe("true");
  });

  it("#7 a comb value longer than MaxLen is drawn truncated", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const t = formOf(doc).createTextField("c");
    t.setMaxLength(4);
    t.enableCombing();
    t.addToPage(page, { x: 20, y: 20, width: 100, height: 20, font });
    writeFieldValues(doc, { c: "123456" });
    const rep = await completeFieldAppearances(doc, new FieldFontBook(doc));
    expect(rep.failed).toEqual([]);
    expect(rep.generated).toEqual(["c"]);
  });

  it("#9 an inverted /Rect gives a positive BBox", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const t = formOf(doc).createTextField("inv");
    t.addToPage(page, { x: 10, y: 10, width: 100, height: 20, font });
    const w = t.acroField.getWidgets()[0];
    w.dict.set(PDFName.of("Rect"), doc.context.obj([110, 30, 10, 10]));
    writeFieldValues(doc, { inv: "x" });
    await completeFieldAppearances(doc, new FieldFontBook(doc));
    const n = w.getAppearances()?.normal;
    const bbox = ((n instanceof PDFRef ? doc.context.lookup(n) : n) as PDFStream).dict.lookup(
      PDFName.of("BBox"),
      PDFArray,
    );
    expect(bbox.asArray().map((x) => (x as PDFNumber).asNumber())).toEqual([0, 0, 100, 20]);
  });
});

describe("T2 review — data exchange robustness", () => {
  it("#11 \\u and \\x escapes in Acrobat scripts are decoded", () => {
    const f = parseFormat(undefined, 'AFNumber_Format(2, 0, 0, 0, "\\u20AC\\x20", false);');
    expect(f).toMatchObject({ kind: "number", currency: "€ " });
  });

  it("#12 a cyclic or shared /Kids FDF is read in linear time", () => {
    const parts = ["%FDF-1.2", "1 0 obj << /FDF << /Fields [2 0 R] >> >> endobj"];
    for (let i = 2; i < 40; i++)
      parts.push(`${i} 0 obj << /T (n${i}) /V (v) /Kids [${i + 1} 0 R ${i + 1} 0 R] >> endobj`);
    parts.push("40 0 obj << /T (loop) /Kids [40 0 R 40 0 R] >> endobj", "trailer << /Root 1 0 R >>", "%%EOF");
    const t0 = Date.now();
    const got = parseFdf(Uint8Array.from(parts.join("\n"), (c) => c.charCodeAt(0)));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(got.size).toBeGreaterThan(0);
  });

  it("#13 a huge token does not lose the whole file", () => {
    const text = `%FDF-1.2\n1 0 obj << /FDF << /Fields [ << /T (a) /V (ok) >> << /T (b) /V /${"x".repeat(200_000)} >> ] >> >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF`;
    const got = parseFdf(Uint8Array.from(text, (c) => c.charCodeAt(0)));
    expect(got.get("a")).toEqual({ kind: "text", text: "ok" });
  });

  it("#14 tab text keeps multi-select items that contain a comma", () => {
    const field: FormField = {
      name: "villes",
      type: "listbox",
      widgets: [],
      fileValue: [],
      defaultValue: [],
      multiSelect: true,
      options: [],
      readOnly: false,
      charLimit: 0,
      hasActions: false,
    };
    const raw = parseTabText(toTabText([{ name: "villes", type: "listbox", value: ["Paris, France", "Lyon"] }]));
    expect(matchImported(new Map([["villes", field]]), raw).values.villes).toEqual(["Paris, France", "Lyon"]);
  });

  it("#15 XFDF drops characters XML cannot carry instead of writing an unreadable file", () => {
    const xml = toXfdfFields([{ name: "t", type: "text", value: "a\u000Cb\u0001c" }], "x.pdf");
    // DOMParser exists only in the browser build of these tests' siblings: check the text.
    expect(xml).toContain("<value>abc</value>");
    void parseXfdfFields;
  });
});
