// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { savePdf } from "../src/pdf/ops/save";
import { calculateScript, formatScripts, validateScript, withFontSize } from "../src/pdf/ops/formedit";
import * as D from "../src/pdf/model/doc";
import { emptyState, type CreatedField, type FieldEdit, type PdfState } from "../src/pdf/model/types";
import { orderFormPdf } from "./fixtures/pdf-form-fixtures";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

type Ann = {
  id: string;
  fieldName?: string;
  rect: number[];
  required?: boolean;
  readOnly?: boolean;
  alternativeText?: string;
  maxLen?: number;
  textAlignment?: number;
  defaultAppearanceData?: { fontSize?: number };
  options?: { exportValue: string; displayValue: string }[];
  fieldValue?: unknown;
  defaultFieldValue?: unknown;
  exportValue?: string;
  hidden?: boolean;
};

async function inspect(bytes: Uint8Array) {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const anns = ((await page.getAnnotations()) as Ann[]).filter((a) => a.fieldName);
  const objects = (await doc.getFieldObjects()) as Record<string, { actions?: Record<string, string[]> }[]> | null;
  const co = (await doc.getCalculationOrderIds()) as string[] | null;
  await task.destroy();
  const by = (name: string) => anns.find((a) => a.fieldName === name);
  return { anns, objects: objects ?? {}, co: co ?? [], by };
}

function stateWith(over: Partial<PdfState>): PdfState {
  return { ...emptyState(), pages: D.pagesFromSource(1), ...over };
}

async function edit(edits: FieldEdit[], values: PdfState["formValues"] = {}) {
  const src = await orderFormPdf();
  const before = await inspect(src);
  const res = await savePdf({ source: src, state: stateWith({ fieldEdits: edits, formValues: values }) });
  return { res, before, after: await inspect(res.bytes) };
}

describe("formedit — the file's own fields", () => {
  it("moves and resizes a widget, redrawn, as an incremental update", async () => {
    const src = await orderFormPdf();
    const id = (await inspect(src)).by("nom")!.id;
    // Top-left page space: 400 pt high page.
    const { res, after } = await edit([{ name: "nom", rects: { [id]: { x: 50, y: 60, w: 250, h: 30 } } }], {
      nom: "Wałęsa",
    });
    expect(res.report.mode).toBe("incremental");
    expect(res.report.lost).toEqual([]);
    expect(after.by("nom")!.rect.map(Math.round)).toEqual([50, 310, 300, 340]);
    const doc = await PDFDocument.load(res.bytes);
    const w = doc.getForm().getTextField("nom").acroField.getWidgets()[0];
    expect(w.getAppearances()?.normal).toBeDefined();
  });

  it("deletes a field: gone from the form, the page and the calculation order", async () => {
    const { after, res } = await edit([{ name: "total", deleted: true }]);
    expect(after.by("total")).toBeUndefined();
    expect(after.co).toEqual([]);
    const doc = await PDFDocument.load(res.bytes);
    expect(doc.getForm().getFieldMaybe("total")).toBeUndefined();
    const annots = doc.getPage(0).node.Annots()!;
    expect(annots.size()).toBe(4);
  });

  it("renames within the same branch and into a new branch, keeping the value", async () => {
    const { after } = await edit(
      [
        { name: "nom", rename: "client.nom" },
        { name: "pays", rename: "destination" },
      ],
      { nom: "Dupont" },
    );
    expect(after.by("client.nom")?.fieldValue).toBe("Dupont");
    expect(after.by("destination")).toBeDefined();
    expect(after.by("nom")).toBeUndefined();
    expect(after.by("pays")).toBeUndefined();
  });

  it("refuses a rename onto a name already taken", async () => {
    const { res, after } = await edit([{ name: "nom", rename: "qte" }]);
    expect(res.report.lost.join(" ")).toContain("déjà pris");
    expect(after.by("nom")).toBeDefined();
  });

  it("sets flags, tooltip, length, alignment and font size as viewers read them", async () => {
    const { after } = await edit([
      {
        name: "nom",
        props: {
          required: false,
          readOnly: true,
          tooltip: "Nom de famille — « obligatoire »",
          maxLen: 30,
          align: "center",
          fontSize: 14,
        },
      },
    ]);
    const a = after.by("nom")!;
    expect(a.required).toBe(false);
    expect(a.readOnly).toBe(true);
    expect(a.alternativeText).toBe("Nom de famille — « obligatoire »");
    expect(a.maxLen).toBe(30);
    expect(a.textAlignment).toBe(1);
    expect(a.defaultAppearanceData?.fontSize).toBe(14);
  });

  it("writes Format / Validate / Calculate as Acrobat JavaScript, with the calculation order", async () => {
    const { after, before } = await edit([
      { name: "nom", props: { format: { kind: "date", pattern: "dd/mm/yyyy" }, validate: null } },
      {
        name: "prix",
        props: {
          calculate: { kind: "simple", op: "SUM", fields: ["qte"] },
          validate: { min: 0, max: 1000 },
        },
      },
    ]);
    const nomActions = after.objects.nom.find((o) => o.actions)?.actions ?? {};
    expect(nomActions.Keystroke?.[0]).toBe('AFDate_KeystrokeEx("dd/mm/yyyy");');
    expect(nomActions.Format?.[0]).toBe('AFDate_FormatEx("dd/mm/yyyy");');
    const prixActions = after.objects.prix.find((o) => o.actions)?.actions ?? {};
    expect(prixActions.Calculate?.[0]).toBe('AFSimple_Calculate("SUM", new Array("qte"));');
    expect(prixActions.Validate?.[0]).toBe("AFRange_Validate(true, 0, true, 1000);");
    expect(before.co.length).toBe(1);
    expect(after.co.length).toBe(2);
    // /CO lists FIELDS (here split from their widget): the new entry is « prix ».
    expect(after.co).toContain(
      `${(await PDFDocument.load(await orderFormPdf())).getForm().getField("prix").ref.objectNumber}R`,
    );
  });

  it("replaces a dropdown's items, labels kept", async () => {
    const { after } = await edit([
      {
        name: "pays",
        props: {
          options: [
            { value: "BE", label: "Belgique" },
            { value: "LU", label: "Luxembourg" },
          ],
        },
      },
    ]);
    expect(after.by("pays")!.options).toEqual([
      { exportValue: "BE", displayValue: "Belgique" },
      { exportValue: "LU", displayValue: "Luxembourg" },
    ]);
  });
});

describe("formedit — fields created in Elium", () => {
  const base = (over: Partial<CreatedField>): CreatedField => ({
    id: over.id ?? "f",
    pageId: "",
    name: "champ",
    kind: "text",
    rect: { x: 20, y: 20, w: 150, h: 22 },
    ...over,
  });

  async function create(fields: CreatedField[]) {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const src = await doc.save();
    const state = stateWith({});
    const withPage = fields.map((f) => ({ ...f, pageId: state.pages[0].id }));
    const res = await savePdf({ source: src, state: { ...state, createdFields: withPage } });
    return { res, after: await inspect(res.bytes) };
  }

  it("a dropdown keeps its labels and is not editable unless asked", async () => {
    const { after, res } = await create([
      base({
        kind: "dropdown",
        name: "pays",
        options: [
          { value: "FR", label: "France" },
          { value: "CH", label: "Suisse" },
        ],
        defaultValue: "CH",
      }),
    ]);
    const a = after.by("pays")!;
    expect(a.options).toEqual([
      { exportValue: "FR", displayValue: "France" },
      { exportValue: "CH", displayValue: "Suisse" },
    ]);
    expect(a.fieldValue).toEqual(["CH"]);
    expect(a.defaultFieldValue).toBe("CH");
    const doc = await PDFDocument.load(res.bytes);
    expect(doc.getForm().getDropdown("pays").isEditable()).toBe(false);
  });

  it("a text field with a Unicode default, tooltip and format", async () => {
    const { after, res } = await create([
      base({
        name: "ville",
        defaultValue: "Łódź",
        tooltip: "Ville",
        required: true,
        format: { kind: "number", decimals: 2, sepStyle: 2, negStyle: 0, currency: " €", currencyPrepend: false },
      }),
    ]);
    expect(res.report.lost).toEqual([]);
    const a = after.by("ville")!;
    expect(a.fieldValue).toBe("Łódź");
    expect(a.defaultFieldValue).toBe("Łódź");
    expect(a.alternativeText).toBe("Ville");
    expect(a.required).toBe(true);
    const actions = after.objects.ville.find((o) => o.actions)?.actions ?? {};
    expect(actions.Format?.[0]).toBe('AFNumber_Format(2, 2, 0, 0, " €", false);');
  });

  it("a checkbox with its own export value", async () => {
    const { after } = await create([
      base({ kind: "checkbox", name: "accord", exportValue: "Oui", defaultValue: true }),
    ]);
    const a = after.by("accord")!;
    expect(a.exportValue).toBe("Oui");
    expect(a.fieldValue).toBe("Oui");
  });
});

describe("formedit — script builders", () => {
  it("builds Acrobat's own calls", () => {
    expect(formatScripts({ kind: "percent", decimals: 1, sepStyle: 2 })).toEqual({
      K: "AFPercent_Keystroke(1, 2);",
      F: "AFPercent_Format(1, 2);",
    });
    expect(formatScripts({ kind: "time", style: 0 })?.F).toBe("AFTime_Format(0);");
    expect(formatScripts({ kind: "none" })).toBeNull();
    expect(validateScript({ max: 10 })).toBe("AFRange_Validate(false, 0, true, 10);");
    expect(validateScript({})).toBeNull();
    // Names are JS string literals: quotes cannot break out.
    expect(calculateScript({ kind: "simple", op: "AVG", fields: ['a"b', "c"] })).toBe(
      'AFSimple_Calculate("AVG", new Array("a\\"b", "c"));',
    );
    expect(withFontSize("/Helv 0 Tf 0 g", 12)).toBe("/Helv 12 Tf 0 g");
    expect(withFontSize("0 0 1 rg", 9)).toBe("/Helv 9 Tf 0 0 1 rg");
  });
});
