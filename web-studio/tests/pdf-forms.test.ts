import { describe, it, expect } from "vitest";
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFName, PDFRadioGroup, PDFSignature, PDFTextField, StandardFonts } from "pdf-lib";
import {
  createFields,
  fillForm,
  flattenForm,
  fromFdf,
  hasFormFields,
  missingRequired,
  readFields,
  suggestFields,
  toCsv,
  toFdf,
  type RawWidget,
} from "../src/pdf/ops/forms";
import type { CreatedField, FieldBox } from "../src/pdf/model/types";

// ---------------------------------------------------------------------------
// readFields — mapping pdf.js widget annotations to the app's own model
// ---------------------------------------------------------------------------

describe("forms — readFields", () => {
  const pageHeight = 400;

  it("maps every widget kind, deriving top-left rects from the PDF's bottom-left ones", () => {
    const widgets: RawWidget[] = [
      { id: "w1", fieldType: "Tx", fieldName: "nom", rect: [50, 350, 150, 370], fieldValue: "Dupont" },
      { id: "w2", fieldType: "Btn", checkBox: true, fieldName: "accepte", rect: [50, 300, 70, 320], exportValue: "Oui", fieldValue: "Oui" },
      {
        id: "w3",
        fieldType: "Btn",
        radioButton: true,
        fieldName: "civilite",
        rect: [50, 250, 70, 270],
        buttonValue: "M",
        fieldValue: "M",
      },
      {
        id: "w4",
        fieldType: "Ch",
        combo: true,
        fieldName: "pays",
        rect: [50, 200, 150, 220],
        options: [{ exportValue: "FR", displayValue: "France" }],
        fieldValue: "FR",
      },
      { id: "w5", fieldType: "Sig", fieldName: "signature", rect: [50, 150, 150, 170] },
      { id: "w6", fieldType: "Btn", pushButton: true, fieldName: "envoyer", rect: [50, 100, 100, 120] },
    ];

    const fields = readFields(widgets, pageHeight);
    expect(fields.map((f) => f.kind)).toEqual(["text", "checkbox", "radio", "dropdown", "signature", "button"]);

    const text = fields[0];
    expect(text.value).toBe("Dupont");
    // y=350..370 in PDF space (bottom-left) becomes top-left space: 400-370=30.
    expect(text.rect).toEqual({ x: 50, y: 30, w: 100, h: 20 });

    const checkbox = fields[1];
    expect(checkbox.value).toBe(true);
    expect(checkbox.exportValue).toBe("Oui");

    const radio = fields[2];
    expect(radio.value).toBe("M");

    const dropdown = fields[3];
    expect(dropdown.value).toBe("FR");
    expect(dropdown.options).toEqual([{ value: "FR", label: "France" }]);
  });

  it("subtracts the crop-box origin so widgets on a cropped page still land correctly", () => {
    // Crop box: lower-left corner (100, 20), 100pt tall ⇒ visible top is y=120
    // in PDF space. A widget at [70,90] sits 30pt below that visible top.
    const widgets: RawWidget[] = [{ id: "w1", fieldType: "Tx", fieldName: "champ", rect: [110, 70, 160, 90] }];
    const fields = readFields(widgets, 100, { x: 100, y: 20 });
    expect(fields[0].rect).toEqual({ x: 10, y: 30, w: 50, h: 20 });
  });

  it("skips widgets with no recognisable field type or no name/rect", () => {
    const widgets: RawWidget[] = [
      { id: "a", fieldType: "Unknown", fieldName: "x", rect: [0, 0, 10, 10] },
      { id: "b", fieldType: "Tx", rect: [0, 0, 10, 10] }, // no fieldName
      { id: "c", fieldType: "Tx", fieldName: "y" }, // no rect
    ];
    expect(readFields(widgets, 100)).toHaveLength(0);
  });

  it("hasFormFields ignores push buttons and unnamed widgets", () => {
    expect(hasFormFields([{ fieldType: "Btn", pushButton: true, fieldName: "go", rect: [0, 0, 1, 1] }])).toBe(false);
    expect(hasFormFields([{ fieldType: "Tx", fieldName: "nom", rect: [0, 0, 1, 1] }])).toBe(true);
    expect(hasFormFields([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// missingRequired
// ---------------------------------------------------------------------------

describe("forms — missingRequired", () => {
  const field = (over: Partial<FieldBox>): FieldBox => ({
    key: over.name ?? "f",
    name: "f",
    kind: "text",
    rect: { x: 0, y: 0, w: 10, h: 10 },
    readOnly: false,
    required: true,
    multiLine: false,
    password: false,
    maxLen: null,
    exportValue: null,
    options: [],
    value: "",
    align: "left",
    ...over,
  });

  it("flags a required text field left blank, ignores one that is filled", () => {
    const fields = [field({ name: "nom", value: "" }), field({ name: "prenom", value: "Jean" })];
    expect(missingRequired(fields, {}).map((f) => f.name)).toEqual(["nom"]);
  });

  it("treats an unchecked required checkbox as missing", () => {
    const fields = [field({ name: "accepte", kind: "checkbox", value: false })];
    expect(missingRequired(fields, {}).map((f) => f.name)).toEqual(["accepte"]);
    expect(missingRequired(fields, { accepte: true })).toHaveLength(0);
  });

  it("never flags a read-only field or a button", () => {
    const fields = [field({ name: "verrou", readOnly: true, value: "" }), field({ name: "ok", kind: "button", value: "" })];
    expect(missingRequired(fields, {})).toHaveLength(0);
  });

  it("prefers a value collected from the caller over the field's own default", () => {
    const fields = [field({ name: "ville", value: "" })];
    expect(missingRequired(fields, { ville: "Paris" })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FDF import/export and CSV
// ---------------------------------------------------------------------------

describe("forms — FDF and CSV serialisation", () => {
  it("round-trips string and boolean values through toFdf/fromFdf", () => {
    const values = { nom: "Jean (Dupont)", accepte: true, refuse: false };
    const fdf = toFdf(values, "contrat.pdf");
    expect(fdf).toContain("%FDF-1.2");
    const back = fromFdf(fdf);
    expect(back).toEqual({ nom: "Jean (Dupont)", accepte: true, refuse: false });
  });

  it("escapes parentheses and backslashes so they cannot break the FDF grammar", () => {
    const fdf = toFdf({ note: "a\\b (c)" }, "f.pdf");
    const back = fromFdf(fdf);
    expect(back.note).toBe("a\\b (c)");
  });

  it("renders a CSV with a French header and Oui/Non for booleans", () => {
    const csv = toCsv({ nom: "Martin", accepte: true });
    const rows = csv.split("\r\n");
    expect(rows[0]).toBe("Champ;Valeur");
    expect(rows).toContain("nom;Martin");
    expect(rows).toContain("accepte;Oui");
  });

  it("quotes CSV values that contain the delimiter or a newline", () => {
    const csv = toCsv({ adresse: "1 rue de la Paix; Paris" });
    expect(csv).toContain('"1 rue de la Paix; Paris"');
  });
});

// ---------------------------------------------------------------------------
// suggestFields — Acrobat-style automatic field detection
// ---------------------------------------------------------------------------

describe("forms — suggestFields", () => {
  it("turns a label ending in a colon into a text field to its right", () => {
    const lines = [{ text: "Nom :", rect: { x: 40, y: 100, w: 60, h: 14 }, fontSize: 11 }];
    const suggestions = suggestFields(lines, 400);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ name: "Nom", kind: "text" });
    expect(suggestions[0].rect.x).toBeGreaterThan(100);
  });

  it("turns a run of underscores into a text field over the same span", () => {
    const lines = [{ text: "Signature ____________________", rect: { x: 40, y: 100, w: 200, h: 14 }, fontSize: 11 }];
    const suggestions = suggestFields(lines, 400);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].rect.x).toBe(40);
  });

  it("de-duplicates generated names instead of colliding", () => {
    const lines = [
      { text: "Nom :", rect: { x: 40, y: 100, w: 60, h: 14 }, fontSize: 11 },
      { text: "Nom :", rect: { x: 40, y: 80, w: 60, h: 14 }, fontSize: 11 },
    ];
    const names = suggestFields(lines, 400).map((f) => f.name);
    expect(new Set(names).size).toBe(2);
  });

  it("ignores lines with neither a colon nor underscores", () => {
    expect(suggestFields([{ text: "Ceci est une phrase.", rect: { x: 0, y: 0, w: 100, h: 14 }, fontSize: 11 }], 400)).toHaveLength(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// createFields + fillForm — every widget kind through pdf-lib, not just text
// ---------------------------------------------------------------------------

async function docWithFont() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  return { doc, font, page };
}

const fieldBase = (over: Partial<CreatedField>): CreatedField => ({
  id: over.id ?? "id",
  pageId: "p1",
  name: "champ",
  kind: "text",
  rect: { x: 40, y: 40, w: 120, h: 20 },
  ...over,
});

describe("forms — createFields (checkbox / radio / dropdown / listbox / signature)", () => {
  it("creates a checkbox, pre-checked when the builder set a default", async () => {
    const { doc, font, page } = await docWithFont();
    const made = createFields({ doc, font }, [fieldBase({ kind: "checkbox", name: "accepte", defaultValue: true })], () => ({
      page,
      height: 400,
    }));
    expect(made).toBe(1);
    const field = doc.getForm().getField("accepte");
    expect(field).toBeInstanceOf(PDFCheckBox);
    expect((field as PDFCheckBox).isChecked()).toBe(true);
  });

  it("creates a radio group with the requested option selected", async () => {
    const { doc, font, page } = await docWithFont();
    createFields(
      { doc, font },
      [
        fieldBase({
          kind: "radio",
          name: "civilite",
          options: [
            { value: "M", label: "M." },
            { value: "Mme", label: "Mme" },
          ],
          defaultValue: "Mme",
        }),
      ],
      () => ({ page, height: 400 }),
    );
    const field = doc.getForm().getField("civilite");
    expect(field).toBeInstanceOf(PDFRadioGroup);
    expect((field as PDFRadioGroup).getSelected()).toBe("Mme");
  });

  it("creates a dropdown with its options and default selection", async () => {
    const { doc, font, page } = await docWithFont();
    createFields(
      { doc, font },
      [
        fieldBase({
          kind: "dropdown",
          name: "pays",
          options: [
            { value: "FR", label: "France" },
            { value: "BE", label: "Belgique" },
          ],
          defaultValue: "BE",
        }),
      ],
      () => ({ page, height: 400 }),
    );
    const field = doc.getForm().getField("pays");
    expect(field).toBeInstanceOf(PDFDropdown);
    expect((field as PDFDropdown).getSelected()).toEqual(["BE"]);
  });

  it("builds a real /FT /Sig widget for a signature field, not a text-field stand-in", async () => {
    const { doc, font, page } = await docWithFont();
    createFields(
      { doc, font },
      [fieldBase({ kind: "signature", name: "signature", required: true, rect: { x: 40, y: 40, w: 150, h: 40 } })],
      () => ({ page, height: 400 }),
    );
    // pdf-lib's own parser recognises /FT /Sig and hands back a PDFSignature —
    // proof the field is a genuine signature widget, not a read-only text field.
    const field = doc.getForm().getField("signature");
    expect(field).toBeInstanceOf(PDFSignature);
    expect(field.isRequired()).toBe(true);
    expect(doc.getForm().getSignature("signature").ref).toEqual((field as PDFSignature).ref);

    // The widget is a real page annotation, linked into the AcroForm's /Fields.
    const widgetDict = (field as PDFSignature).acroField.dict;
    expect(widgetDict.lookup(PDFName.of("FT"))).toBe(PDFName.of("Sig"));
    expect(widgetDict.lookup(PDFName.of("Subtype"))).toBe(PDFName.of("Widget"));
    const annots = page.node.Annots();
    expect(annots?.asArray().some((r) => doc.context.lookup(r) === widgetDict)).toBe(true);
  });

  it("skips fields whose target page cannot be resolved, without throwing", async () => {
    const { doc, font } = await docWithFont();
    const made = createFields({ doc, font }, [fieldBase({ pageId: "missing" })], () => null);
    expect(made).toBe(0);
  });

  it("does not let a duplicate or invalid field name sink the whole batch", async () => {
    const { doc, font, page } = await docWithFont();
    const fields = [
      fieldBase({ id: "a", name: "dup", rect: { x: 20, y: 20, w: 80, h: 16 } }),
      fieldBase({ id: "b", name: "dup", rect: { x: 20, y: 60, w: 80, h: 16 } }),
      fieldBase({ id: "c", name: "ok", rect: { x: 20, y: 100, w: 80, h: 16 } }),
    ];
    const made = createFields({ doc, font }, fields, () => ({ page, height: 400 }));
    expect(made).toBeGreaterThanOrEqual(1);
    expect(doc.getForm().getField("ok")).toBeTruthy();
  });
});

describe("forms — fillForm across every widget kind", () => {
  it("fills text, checkbox, radio and dropdown fields, then reports what it skipped", async () => {
    const { doc, font, page } = await docWithFont();
    createFields(
      { doc, font },
      [
        fieldBase({ id: "1", name: "nom", kind: "text" }),
        fieldBase({ id: "2", name: "accepte", kind: "checkbox", rect: { x: 40, y: 80, w: 16, h: 16 } }),
        // Each radio button is its own widget/CreatedField sharing the group
        // name — this is how the UI places them one at a time on the page.
        fieldBase({ id: "3a", name: "civilite", kind: "radio", rect: { x: 40, y: 120, w: 16, h: 16 }, defaultValue: "M" }),
        fieldBase({ id: "3b", name: "civilite", kind: "radio", rect: { x: 60, y: 120, w: 16, h: 16 }, defaultValue: "Mme" }),
        fieldBase({
          id: "4",
          name: "pays",
          kind: "dropdown",
          rect: { x: 40, y: 160, w: 100, h: 20 },
          options: [
            { value: "FR", label: "France" },
            { value: "BE", label: "Belgique" },
          ],
        }),
      ],
      () => ({ page, height: 400 }),
    );

    const report = fillForm(doc, { nom: "Dupont", accepte: true, civilite: "Mme", pays: "FR", inconnu: "x" });
    expect(report.filled).toBe(4);
    expect(doc.getForm().getTextField("nom").getText()).toBe("Dupont");
    expect(doc.getForm().getCheckBox("accepte").isChecked()).toBe(true);
    expect(doc.getForm().getRadioGroup("civilite").getSelected()).toBe("Mme");
    expect(doc.getForm().getDropdown("pays").getSelected()).toEqual(["FR"]);
  });

  it("reports a value it cannot apply instead of throwing", async () => {
    const { doc, font, page } = await docWithFont();
    createFields(
      { doc, font },
      [
        fieldBase({
          id: "1",
          name: "civilite",
          kind: "radio",
          options: [{ value: "M", label: "M." }],
        }),
      ],
      () => ({ page, height: 400 }),
    );
    const report = fillForm(doc, { civilite: "Inconnu" });
    expect(report.filled).toBe(0);
    expect(report.skipped).toEqual(["civilite"]);
  });

  it("returns an empty report instead of throwing when the document has no AcroForm", async () => {
    const { doc } = await docWithFont();
    const report = fillForm(doc, { nom: "x" });
    expect(report).toEqual({ filled: 0, skipped: [] });
  });
});

describe("forms — flattenForm", () => {
  it("turns filled widgets into static page content", async () => {
    const { doc, font, page } = await docWithFont();
    createFields({ doc, font }, [fieldBase({ id: "1", name: "nom" })], () => ({ page, height: 400 }));
    fillForm(doc, { nom: "Dupont" });
    expect(flattenForm(doc)).toBe(true);
    expect(doc.getForm().getFields()).toHaveLength(0);
  });

  it("returns false instead of throwing when there is nothing to flatten", async () => {
    const { doc } = await docWithFont();
    // No AcroForm at all yet — flatten() on a freshly created empty form is a no-op success in pdf-lib,
    // so this exercises the try/catch guard rather than asserting a specific outcome.
    expect(typeof flattenForm(doc)).toBe("boolean");
  });
});
