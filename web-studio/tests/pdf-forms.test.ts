import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { readFields, hasFormFields, fillForm, type RawWidget } from "../src/pdf/forms";
import { buildEditedPdf } from "../src/pdf/pdf-save";
import type { Anno } from "../src/pdf/model";

/** Build a PDF carrying one of each fillable field type (pdf-lib AcroForm API). */
async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const form = doc.getForm();

  const name = form.createTextField("name");
  name.setText("");
  name.addToPage(page, { x: 20, y: 250, width: 160, height: 18 });

  const agree = form.createCheckBox("agree");
  agree.addToPage(page, { x: 20, y: 220, width: 14, height: 14 });

  const plan = form.createRadioGroup("plan");
  plan.addOptionToPage("basic", page, { x: 20, y: 190, width: 14, height: 14 });
  plan.addOptionToPage("pro", page, { x: 60, y: 190, width: 14, height: 14 });

  const country = form.createDropdown("country");
  country.addOptions(["France", "Belgique", "Suisse"]);
  country.addToPage(page, { x: 20, y: 150, width: 160, height: 18 });

  return doc.save();
}

describe("PDF forms — readFields (pdf.js annotation → box model)", () => {
  it("classifies each field kind and flips y to top-left scale-1 coords", () => {
    const anns: RawWidget[] = [
      { fieldType: "Tx", fieldName: "name", rect: [20, 232, 180, 250], fieldValue: "Alice", multiLine: false, maxLen: 40 },
      { fieldType: "Btn", checkBox: true, fieldName: "agree", rect: [20, 220, 34, 234], exportValue: "Yes", fieldValue: "Yes" },
      { fieldType: "Btn", radioButton: true, fieldName: "plan", rect: [20, 190, 34, 204], buttonValue: "basic", fieldValue: "pro" },
      { fieldType: "Ch", combo: true, fieldName: "country", rect: [20, 150, 180, 168], fieldValue: "Belgique",
        options: [{ exportValue: "FR", displayValue: "France" }, { exportValue: "BE", displayValue: "Belgique" }] },
    ];
    const boxes = readFields(anns, 300);

    expect(boxes.map((b) => b.kind)).toEqual(["text", "checkbox", "radio", "dropdown"]);
    const name = boxes[0];
    expect(name.value).toBe("Alice");
    expect(name.maxLen).toBe(40);
    expect(name.x).toBe(20);
    expect(name.w).toBe(160);
    // y = pageHeight - top(rect max y) = 300 - 250 = 50
    expect(name.y).toBe(50);
    expect(name.h).toBe(18);

    expect(boxes[1].value).toBe(true);          // agree checked (fieldValue === exportValue)
    expect(boxes[2].value).toBe("pro");         // radio group selected value
    expect(boxes[2].exportValue).toBe("basic"); // this widget's own export value
    expect(boxes[3].options).toEqual([{ value: "FR", label: "France" }, { value: "BE", label: "Belgique" }]);
  });

  it("skips push buttons, hidden widgets and non-widget annotations", () => {
    const anns: RawWidget[] = [
      { fieldType: "Btn", pushButton: true, fieldName: "submit", rect: [0, 0, 10, 10] },
      { fieldType: "Tx", fieldName: "secret", rect: [0, 0, 10, 10], hidden: true },
      { rect: [0, 0, 10, 10] }, // a link annotation: no fieldType
    ];
    expect(readFields(anns, 100)).toEqual([]);
  });

  it("hasFormFields detects fillable widgets", () => {
    expect(hasFormFields([{ fieldType: "Tx", fieldName: "a", rect: [0, 0, 1, 1] }])).toBe(true);
    expect(hasFormFields([{ rect: [0, 0, 1, 1] }, { fieldType: "Btn", pushButton: true, fieldName: "b" }])).toBe(false);
  });
});

describe("PDF forms — fillForm (pdf-lib write-back)", () => {
  it("writes values and flattens fields into static content", async () => {
    const src = await formPdf();
    const out = await fillForm(src, { name: "Bob", agree: true, plan: "pro", country: "Suisse" }, true);
    expect(new TextDecoder().decode(out.slice(0, 5))).toBe("%PDF-");
    const reloaded = await PDFDocument.load(out);
    // Flattened: the AcroForm fields are gone (baked into the page).
    expect(reloaded.getForm().getFields().length).toBe(0);
  });

  it("keeps fields interactive when not flattened and records the values", async () => {
    const src = await formPdf();
    const out = await fillForm(src, { name: "Bob", agree: true, plan: "pro", country: "Suisse" }, false);
    const reloaded = await PDFDocument.load(out);
    const form = reloaded.getForm();
    expect(form.getTextField("name").getText()).toBe("Bob");
    expect(form.getCheckBox("agree").isChecked()).toBe(true);
    expect(form.getRadioGroup("plan").getSelected()).toBe("pro");
    expect(form.getDropdown("country").getSelected()).toEqual(["Suisse"]);
  });

  it("ignores unknown field names and bad values without throwing", async () => {
    const src = await formPdf();
    const out = await fillForm(src, { doesNotExist: "x", plan: "invalid-option" }, false);
    const reloaded = await PDFDocument.load(out);
    // plan stays unselected (invalid option skipped); document still valid.
    expect(reloaded.getForm().getRadioGroup("plan").getSelected()).toBeUndefined();
  });
});

describe("PDF forms — buildEditedPdf integration", () => {
  it("pure fill without flatten keeps fields interactive (short-circuit)", async () => {
    const src = await formPdf();
    const out = await buildEditedPdf(src, [{ id: "p1", from: 0 }], {}, {}, {
      formValues: { name: "Zoé", agree: true }, flattenForm: false,
    });
    const form = (await PDFDocument.load(out)).getForm();
    expect(form.getTextField("name").getText()).toBe("Zoé");
    expect(form.getCheckBox("agree").isChecked()).toBe(true);
  });

  it("forces flatten when form filling is combined with structural/overlay edits", async () => {
    const src = await formPdf();
    const annos: Record<string, Anno[]> = {
      p1: [{ id: "a", type: "rect", x: 5, y: 5, w: 40, h: 20, color: "#ff0000", strokeWidth: 2, fontSize: 16 }],
    };
    const out = await buildEditedPdf(src, [
      { id: "p1", from: 0 },
      { id: "p2", from: null }, // structural change → not a pure fill
    ], annos, {}, { formValues: { name: "Zoé" }, flattenForm: false });
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(2);
    // Combined path flattens regardless of the flag, so no interactive fields remain.
    expect(reloaded.getForm().getFields().length).toBe(0);
  });

  it("leaves a plain PDF untouched when no form values are given", async () => {
    const src = await formPdf();
    const out = await buildEditedPdf(src, [{ id: "p1", from: 0 }], {});
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
  });
});

// Exercises the real seam our unit tests mock: pdf.js `getAnnotations()` output
// feeding `readFields`, then filling with pdf-lib. Catches property-name drift
// between the two libraries (e.g. radios exposing `buttonValue`, not `exportValue`).
describe("PDF forms — pdf.js round-trip (read → fill)", () => {
  it("reads real pdf.js annotations and fills every field back correctly", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const src = await formPdf();
    const pdf = await pdfjs.getDocument({ data: src.slice(), isEvalSupported: false }).promise;
    const page = await pdf.getPage(1);
    const anns = await page.getAnnotations();
    const h = page.getViewport({ scale: 1 }).height;
    const boxes = readFields(anns, h);

    expect(boxes.map((b) => b.kind).sort()).toEqual(["checkbox", "dropdown", "radio", "radio", "text"]);
    const radio = boxes.find((b) => b.kind === "radio");
    expect(radio?.exportValue).toBeTruthy(); // buttonValue surfaced (not empty)

    // Simulate a user filling the form via the overlay, then export.
    const values = { name: "Iris", agree: true, plan: radio!.exportValue as string, country: "Belgique" };
    const filled = await fillForm(src, values, false);
    const form = (await PDFDocument.load(filled)).getForm();
    expect(form.getTextField("name").getText()).toBe("Iris");
    expect(form.getCheckBox("agree").isChecked()).toBe(true);
    // The radio's pdf.js appearance-state name maps back to a real pdf-lib option.
    expect(form.getRadioGroup("plan").getOptions()).toContain(form.getRadioGroup("plan").getSelected());
    expect(form.getRadioGroup("plan").getSelected()).toBeTruthy();
    expect(form.getDropdown("country").getSelected()).toEqual(["Belgique"]);
  });
});
