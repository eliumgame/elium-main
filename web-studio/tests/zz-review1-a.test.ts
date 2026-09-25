import { describe, it, expect } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts } from "pdf-lib";
import { applyFieldEdits, setFieldProps } from "../src/pdf/ops/formedit";
import { FieldFontBook, completeFieldAppearances, writeFieldValues, flattenFields } from "../src/pdf/ops/formpdf";
import { parseFormat, parseValidate } from "../src/pdf/core/forms/afscripts";

/** Parent non-terminal "grp" carrying /FT /DA /Ff, one terminal kid "name" (merged widget). */
async function hierDoc(parentExtra: Record<string, unknown>) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const ctx = doc.context;
  const form = doc.getForm();
  form.acroForm.dict.set(PDFName.of("DA"), PDFString.of("/Helv 0 Tf 0 g"));
  const parent = ctx.obj({ T: PDFString.of("grp"), Kids: [], ...parentExtra }) as PDFDict;
  const parentRef = ctx.register(parent);
  const kid = ctx.obj({
    Type: "Annot",
    Subtype: "Widget",
    T: PDFString.of("name"),
    Parent: parentRef,
    Rect: [10, 10, 200, 30],
    F: 4,
    P: page.ref,
  }) as PDFDict;
  const kidRef = ctx.register(kid);
  (parent.lookup(PDFName.of("Kids")) as PDFArray).push(kidRef);
  page.node.set(PDFName.of("Annots"), ctx.obj([kidRef]));
  form.acroForm.addField(parentRef);
  return { doc, form, parent, kid };
}

const str = (v: unknown) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : String(v));

describe("review formedit", () => {
  it("fontSize edit ignores /DA inherited from the parent", async () => {
    const { doc, form, kid } = await hierDoc({
      FT: PDFName.of("Tx"),
      DA: PDFString.of("/Cour 10 Tf 1 0 0 rg"),
    });
    const f = form.getTextField("grp.name");
    setFieldProps(doc, form, f, { fontSize: 14 });
    console.log("DA after:", str(kid.get(PDFName.of("DA"))));
    expect(str(kid.get(PDFName.of("DA")))).toBe("/Cour 14 Tf 1 0 0 rg");
  });

  it("setting required overrides inherited Ff (multiline lost)", async () => {
    const { doc, form, kid } = await hierDoc({ FT: PDFName.of("Tx"), Ff: PDFNumber.of(1 << 12) });
    const f = form.getTextField("grp.name");
    expect(f.isMultiline()).toBe(true);
    setFieldProps(doc, form, f, { required: true });
    console.log("Ff after:", String(kid.get(PDFName.of("Ff"))));
    const f2 = form.getTextField("grp.name");
    expect(f2.isRequired()).toBe(true);
    expect(f2.isMultiline()).toBe(true);
  });

  it("rename across branch loses inherited /FT", async () => {
    const { doc, form } = await hierDoc({ FT: PDFName.of("Tx"), DA: PDFString.of("/Helv 9 Tf 0 g") });
    const r = applyFieldEdits(doc, [{ name: "grp.name", rename: "other.name" }]);
    console.log("rename report", r);
    const names = form.getFields().map((x) => `${x.getName()}:${x.constructor.name}`);
    console.log("fields after rename", names);
    expect(form.getFieldMaybe("other.name")?.constructor.name).toBe("PDFTextField");
  });

  it("rename onto the name of a non-terminal / inside a terminal", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const a = form.createTextField("a");
    a.addToPage(page, { x: 10, y: 10, width: 100, height: 20 });
    const gx = form.createTextField("grp.x");
    gx.addToPage(page, { x: 10, y: 40, width: 100, height: 20 });
    const b = form.createTextField("b");
    b.addToPage(page, { x: 10, y: 70, width: 100, height: 20 });
    const r = applyFieldEdits(doc, [
      { name: "a", rename: "grp" },
      { name: "b", rename: "grp.x.y" },
    ]);
    console.log("report", r);
    const top = (form.acroForm.dict.lookup(PDFName.of("Fields")) as PDFArray)
      .asArray()
      .map((ref) => str((doc.context.lookup(ref) as PDFDict).lookup(PDFName.of("T"))));
    console.log("top-level /T:", top);
    let names: string[] = [];
    try {
      names = form.getFields().map((x) => `${x.getName()}:${x.constructor.name}`);
    } catch (e) {
      names = [`getFields threw ${e}`];
    }
    console.log("fields", names);
    expect(r.problems.length).toBe(2);
  });

  it("checkbox export value rename leaves /V on the old state", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const cb = form.createCheckBox("cb");
    cb.addToPage(page, { x: 10, y: 10, width: 20, height: 20 });
    cb.check();
    applyFieldEdits(doc, [{ name: "cb", props: { exportValue: "Oui" } }]);
    const d = cb.acroField.dict;
    console.log("V", String(d.get(PDFName.of("V"))), "AS", String(d.get(PDFName.of("AS"))));
    expect(String(d.get(PDFName.of("V")))).toBe("/Oui");
  });

  it("checkbox default true written as /Yes even when on-state is Oui", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const cb = form.createCheckBox("cb");
    cb.addToPage(page, { x: 10, y: 10, width: 20, height: 20 });
    setFieldProps(doc, form, cb, { exportValue: "Oui", defaultValue: true });
    console.log("DV", String(cb.acroField.dict.get(PDFName.of("DV"))));
    expect(String(cb.acroField.dict.get(PDFName.of("DV")))).toBe("/Oui");
  });

  it("removeWidgets on a radio with /Opt leaves /Opt misaligned", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const rg = form.createRadioGroup("r");
    rg.addOptionToPage("0", page, { x: 10, y: 10, width: 20, height: 20 });
    rg.addOptionToPage("1", page, { x: 40, y: 10, width: 20, height: 20 });
    rg.addOptionToPage("2", page, { x: 70, y: 10, width: 20, height: 20 });
    rg.acroField.dict.set(PDFName.of("Opt"), doc.context.obj([PDFString.of("A"), PDFString.of("B"), PDFString.of("C")]));
    const annots = page.node.Annots()!;
    const second = annots.get(1) as PDFRef;
    applyFieldEdits(doc, [{ name: "r", removeWidgets: [`${second.objectNumber}R`] }]);
    const kids = rg.acroField.Kids()!.size();
    const opt = (rg.acroField.dict.lookup(PDFName.of("Opt")) as PDFArray).size();
    console.log("kids", kids, "opt", opt);
    // Select « C » (export value) -> must select the third (now second) widget.
    const rep = writeFieldValues(doc, { r: "C" });
    const states = rg.acroField.getWidgets().map((w) => w.getAppearanceState()?.decodeText());
    console.log("after selecting C:", rep, states);
    expect(opt).toBe(kids);
  });
});

describe("review formpdf", () => {
  it("comb value longer than MaxLen: AP dropped, nothing drawn, no NeedAppearances", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const t = form.createTextField("code");
    t.setMaxLength(4);
    t.enableCombing();
    t.addToPage(page, { x: 10, y: 10, width: 100, height: 20 });
    writeFieldValues(doc, { code: "123456" });
    const rep = await completeFieldAppearances(doc, new FieldFontBook(doc), { refreshStale: true });
    const w = t.acroField.getWidgets()[0];
    console.log("report", rep, "AP", !!w.dict.get(PDFName.of("AP")), "NA", String(form.acroForm.dict.get(PDFName.of("NeedAppearances"))));
    expect(!!w.dict.get(PDFName.of("AP")) || String(form.acroForm.dict.get(PDFName.of("NeedAppearances"))) === "true").toBe(true);
  });

  it("uncovered chars: AP dropped, no NeedAppearances raised", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const t = form.createTextField("nom");
    t.addToPage(page, { x: 10, y: 10, width: 100, height: 20 });
    writeFieldValues(doc, { nom: "漢字" });
    const rep = await completeFieldAppearances(doc, new FieldFontBook(doc), { refreshStale: true });
    const w = t.acroField.getWidgets()[0];
    console.log("report", rep, "AP", !!w.dict.get(PDFName.of("AP")), "NA", String(form.acroForm.dict.get(PDFName.of("NeedAppearances"))));
    expect(!!w.dict.get(PDFName.of("AP")) || String(form.acroForm.dict.get(PDFName.of("NeedAppearances"))) === "true").toBe(true);
  });

  it("inverted /Rect gives a negative BBox", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const t = form.createTextField("nom");
    t.addToPage(page, { x: 10, y: 10, width: 100, height: 20 });
    const w = t.acroField.getWidgets()[0];
    w.dict.set(PDFName.of("Rect"), doc.context.obj([110, 30, 10, 10]));
    writeFieldValues(doc, { nom: "Hello" });
    await completeFieldAppearances(doc, new FieldFontBook(doc));
    const ap = w.dict.lookup(PDFName.of("AP")) as PDFDict;
    const n = doc.context.lookup(ap.get(PDFName.of("N")) as PDFRef) as { dict: PDFDict };
    console.log("BBox", String(n.dict.get(PDFName.of("BBox"))));
    expect(String(n.dict.get(PDFName.of("BBox")))).toBe("[ 0 0 100 20 ]");
  });

  it("flatten draws in field order, not annotation order", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const a = form.createTextField("a");
    const b = form.createTextField("b");
    b.addToPage(page, { x: 10, y: 10, width: 100, height: 20, font });
    a.addToPage(page, { x: 10, y: 10, width: 100, height: 20, font });
    // annots order: b then a (a on top). Fields order: a then b.
    const annotOrder = page.node.Annots()!.asArray().map((r) => (r as PDFRef).objectNumber);
    const aRef = a.acroField.getWidgets()[0];
    void aRef;
    flattenFields(doc);
    console.log("annots order", annotOrder, "fields order", ["a", "b"]);
  });

  it("parseFormat with Acrobat's \\u escaped currency", () => {
    const f = parseFormat('AFNumber_Keystroke(2, 0, 0, 0, "\\u20AC", false);', 'AFNumber_Format(2, 0, 0, 0, "\\u20AC", false);');
    console.log(f);
    expect((f as { currency: string }).currency).toBe("€");
  });

  it("parseValidate with 1e21 bound", () => {
    console.log(parseValidate(`AFRange_Validate(true, 0, true, ${1e21});`));
  });
});
