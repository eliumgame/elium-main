// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import {
  AnnotationFlags,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  StandardFonts,
  TextAlignment,
} from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { savePdf } from "../src/pdf/ops/save";
import { appearanceMatrix, isWinAnsi, writeFieldValues } from "../src/pdf/ops/formpdf";
import * as D from "../src/pdf/model/doc";
import { emptyState, type FormValue, type PdfState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

const STD_FONTS = pathToFileURL(
  createRequire(import.meta.url)
    .resolve("pdfjs-dist/package.json")
    .replace(/package\.json$/, "standard_fonts/"),
).href;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FormOpts {
  needAppearances?: boolean;
  hiddenField?: boolean;
  password?: boolean;
}

/** A one-page form: text, dropdown with export ≠ label, two « oui/non » boxes sharing a name, list box. */
async function makeForm(o: FormOpts = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();

  const nom = form.createTextField("nom");
  nom.addToPage(page, { x: 20, y: 340, width: 200, height: 24, font });

  const pays = form.createDropdown("pays");
  pays.addToPage(page, { x: 20, y: 300, width: 200, height: 24, font });
  // [export, label] pairs, as most administrative forms have them.
  pays.acroField.dict.set(
    PDFName.of("Opt"),
    doc.context.obj([
      [PDFHexString.fromText("FR"), PDFHexString.fromText("France")],
      [PDFHexString.fromText("CH"), PDFHexString.fromText("Suisse")],
    ]),
  );

  // One field, two widgets, distinct export values (« Oui » / « Non »).
  const rep = form.createCheckBox("reponse");
  rep.addToPage(page, { x: 20, y: 260, width: 16, height: 16 });
  rep.addToPage(page, { x: 60, y: 260, width: 16, height: 16 });
  const [w1, w2] = rep.acroField.getWidgets();
  renameOnState(w1.dict, "Oui");
  renameOnState(w2.dict, "Non");

  const langues = form.createOptionList("langues");
  langues.setOptions(["fr", "de", "it"]);
  langues.enableMultiselect();
  langues.addToPage(page, { x: 20, y: 180, width: 120, height: 60, font });

  if (o.hiddenField) {
    const cache = form.createTextField("cache");
    cache.setText("secret");
    cache.addToPage(page, { x: 20, y: 120, width: 200, height: 24, font });
    cache.acroField.getWidgets()[0].setFlagTo(AnnotationFlags.Hidden, true);
  }
  if (o.password) {
    const pw = form.createTextField("motdepasse");
    pw.addToPage(page, { x: 20, y: 80, width: 200, height: 24, font });
    pw.acroField.setFlagTo(1 << 13, true);
  }
  nom.setAlignment(TextAlignment.Left);
  form.updateFieldAppearances(font);
  if (o.needAppearances) form.acroForm.dict.set(PDFName.of("NeedAppearances"), doc.context.obj(true));
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

function renameOnState(widget: PDFDict, name: string): void {
  const ap = widget.lookup(PDFName.of("AP"), PDFDict);
  for (const key of ["N", "D"]) {
    const sub = ap.lookup(PDFName.of(key));
    if (!(sub instanceof PDFDict)) continue;
    const on = sub.keys().find((k) => k.decodeText() !== "Off");
    if (!on) continue;
    const v = sub.get(on);
    sub.delete(on);
    sub.set(PDFName.of(name), v!);
  }
  widget.set(PDFName.of("AS"), PDFName.of("Off"));
}

function stateWith(values: Record<string, FormValue>, pages = 1): PdfState {
  return { ...emptyState(), pages: D.pagesFromSource(pages), formValues: values };
}

async function openJs(bytes: Uint8Array) {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, standardFontDataUrl: STD_FONTS });
  const doc = await task.promise;
  return Object.assign(doc, { destroy: () => task.destroy() });
}

async function pageText(bytes: Uint8Array): Promise<string> {
  const js = await openJs(bytes);
  const page = await js.getPage(1);
  const tc = await page.getTextContent();
  const s = tc.items.map((i) => ("str" in i ? i.str : "")).join(" ");
  await js.destroy();
  return s;
}

function fieldDict(doc: PDFDocument, name: string): PDFDict {
  return doc.getForm().getField(name).acroField.dict;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

describe("formpdf — writeFieldValues", () => {
  it("selects a dropdown by its EXPORT value without making it editable", async () => {
    const doc = await PDFDocument.load(await makeForm());
    const r = writeFieldValues(doc, { pays: "CH" });
    expect(r.changed).toEqual(["pays"]);
    const d = fieldDict(doc, "pays");
    expect(doc.getForm().getDropdown("pays").getSelected()).toEqual(["CH"]);
    // Ff bit 19 (Edit) untouched.
    const ff = d.lookup(PDFName.of("Ff"));
    expect(((ff instanceof PDFNumber ? ff.asNumber() : 0) >> 18) & 1).toBe(0);
  });

  it("checks the widget whose export value matches, among boxes sharing a name", async () => {
    const doc = await PDFDocument.load(await makeForm());
    writeFieldValues(doc, { reponse: "Non" });
    const [w1, w2] = doc.getForm().getCheckBox("reponse").acroField.getWidgets();
    expect(w1.getAppearanceState()?.decodeText()).toBe("Off");
    expect(w2.getAppearanceState()?.decodeText()).toBe("Non");
    expect(fieldDict(doc, "reponse").lookup(PDFName.of("V"))?.toString()).toBe("/Non");
    writeFieldValues(doc, { reponse: "Off" });
    expect(w2.getAppearanceState()?.decodeText()).toBe("Off");
  });

  it("refuses an export value no widget has", async () => {
    const doc = await PDFDocument.load(await makeForm());
    expect(writeFieldValues(doc, { reponse: "Peut-être" }).skipped).toEqual(["reponse"]);
  });

  it("writes /I with /V for a multi-select list box", async () => {
    const doc = await PDFDocument.load(await makeForm());
    writeFieldValues(doc, { langues: ["it", "fr"] });
    const d = fieldDict(doc, "langues");
    expect(d.lookup(PDFName.of("I"))?.toString()).toBe("[ 0 2 ]");
    expect(doc.getForm().getOptionList("langues").getSelected().sort()).toEqual(["fr", "it"]);
  });

  it("leaves a field whose value is unchanged alone", async () => {
    const doc = await PDFDocument.load(await makeForm());
    writeFieldValues(doc, { nom: "Dupont" });
    const r = writeFieldValues(doc, { nom: "Dupont", reponse: "Off" });
    expect(r.changed).toEqual([]);
    expect(r.filled).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Through the save pipeline
// ---------------------------------------------------------------------------

describe("formpdf — appearances in the saved file", () => {
  it("draws a non-WinAnsi value with an embedded Unicode font, no /NeedAppearances", async () => {
    const src = await makeForm();
    const value = "Lech Wałęsa — Łódź, Ελλάδα, Москва";
    expect(isWinAnsi(value)).toBe(false);
    const r = await savePdf({ source: src, state: stateWith({ nom: value }) });
    expect(r.report.mode).toBe("incremental");
    expect(r.report.warnings.join(" ")).not.toContain("absent");
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getForm().acroForm.dict.lookup(PDFName.of("NeedAppearances"))).toBeUndefined();
    const w = doc.getForm().getTextField("nom").acroField.getWidgets()[0];
    const n = w.getAppearances()?.normal;
    const stream = n instanceof PDFRef ? doc.context.lookup(n) : n;
    expect(stream).toBeInstanceOf(PDFStream);
    const fonts = (stream as PDFStream).dict
      .lookup(PDFName.of("Resources"), PDFDict)
      .lookup(PDFName.of("Font"), PDFDict);
    const font = fonts.lookup(fonts.keys()[0], PDFDict);
    expect(font.lookup(PDFName.of("Subtype"))?.toString()).toBe("/Type0");
    // /DA left as the author wrote it (auto size, font name).
    expect(doc.getForm().getTextField("nom").acroField.getDefaultAppearance()).toContain("Tf");
    // pdf.js reads the value back.
    const js = await openJs(r.bytes);
    const fields = (await js.getFieldObjects()) as Record<string, { value: unknown }[]>;
    expect(fields.nom.find((f) => f.value !== undefined)?.value).toBe(value);
    await js.destroy();
  }, 30_000);

  it("shows the dropdown's LABEL, and a password field as bullets, once flattened", async () => {
    const src = await makeForm({ password: true });
    const r = await savePdf({
      source: src,
      state: stateWith({ pays: "CH", motdepasse: "hunter2", nom: "Łukasz" }),
      options: { flattenForms: true },
    });
    expect(r.report.lost).toEqual([]);
    const text = await pageText(r.bytes);
    expect(text).toContain("Suisse");
    expect(text).not.toContain("CH");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("•••••••");
    expect(text).toContain("Łukasz");
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getForm().getFields()).toHaveLength(0);
    for (const annot of doc.getPage(0).node.Annots()?.asArray() ?? []) {
      const a = doc.context.lookup(annot as PDFRef, PDFDict);
      expect(a.lookup(PDFName.of("Subtype"))?.toString()).not.toBe("/Widget");
    }
  }, 30_000);

  it("drops a hidden field when flattening without drawing it", async () => {
    const src = await makeForm({ hiddenField: true });
    const r = await savePdf({ source: src, state: stateWith({}), options: { flattenForms: true } });
    expect(await pageText(r.bytes)).not.toContain("secret");
  }, 30_000);

  it("redraws every field and clears /NeedAppearances when the file relied on it", async () => {
    const src = await makeForm({ needAppearances: true });
    const r = await savePdf({ source: src, state: stateWith({ nom: "Dupont" }) });
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getForm().acroForm.dict.lookup(PDFName.of("NeedAppearances"))).toBeUndefined();
  }, 30_000);

  it("an unchanged value adds no field object to an incremental save", async () => {
    const first = await savePdf({ source: await makeForm(), state: stateWith({ nom: "Dupont" }) });
    const again = await savePdf({ source: first.bytes, state: stateWith({ nom: "Dupont", reponse: "Off" }) });
    expect(again.report.mode).toBe("incremental");
    expect(again.report.objectsWritten).toBe(0);
  }, 30_000);
});

describe("formpdf — appearanceMatrix (§12.5.5)", () => {
  it("maps a rotated appearance's transformed BBox onto the Rect", () => {
    // 90° rotation of a 100×20 box: transformed bbox is [-20,0]..[0,100].
    const m = appearanceMatrix([0, 0, 100, 20], [0, 1, -1, 0, 0, 0], [50, 50, 70, 150]);
    expect(m).toEqual([1, 0, 0, 1, 70, 50]);
  });
});
