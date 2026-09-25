// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  decodePdfString,
  encodePdfName,
  encodePdfString,
  exportEntries,
  matchImported,
  parseFdf,
  parseTabText,
  parseXfdfFields,
  toCsv,
  toFdf,
  toTabText,
  toXfdfFields,
  type DataEntry,
} from "../src/pdf/ops/formdata";
import type { FormField } from "../src/pdf/core/forms/values";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function field(name: string, type: FormField["type"], over: Partial<FormField> = {}): FormField {
  return {
    name,
    type,
    widgets: [{ id: `${name}-w`, page: 0, rect: null, exportValue: null, hidden: false }],
    fileValue: type === "checkbox" || type === "radiobutton" ? "Off" : "",
    defaultValue: "",
    multiSelect: false,
    options: [],
    readOnly: false,
    charLimit: 0,
    hasActions: false,
    ...over,
  };
}

// What Acrobat writes: indirect objects, a /Kids hierarchy, UTF-16 strings,
// octal escapes, a name with #20, a multi-select array, /V by reference.
const ACROBAT_FDF = [
  "%FDF-1.2",
  "%âãÏÓ",
  "1 0 obj",
  "<</FDF<</F(commande.pdf)/Fields[2 0 R 3 0 R<</T(accord)/V/Oui>><</T(langues)/V[(fr)(it)]>>]>>/Type/Catalog>>",
  "endobj",
  "2 0 obj",
  "<</T(client)/Kids[<</T(nom)/V<FEFF0141006F0064007A>>><</T(ville)/V(Gen\\350ve \\(CH\\))>>]>>",
  "endobj",
  "3 0 obj",
  "<</T(civilit\\351)/V 4 0 R>>",
  "endobj",
  "4 0 obj",
  "/Mme#20Dr",
  "endobj",
  "trailer",
  "<</Root 1 0 R>>",
  "%%EOF",
].join("\r\n");

describe("formdata — FDF as Acrobat writes it", () => {
  it("reads hierarchies, references, UTF-16, octal escapes, #xx names and arrays", () => {
    const got = Object.fromEntries(parseFdf(bytes(ACROBAT_FDF)));
    expect(got).toEqual({
      "client.nom": { kind: "text", text: "Łodz" },
      "client.ville": { kind: "text", text: "Genève (CH)" },
      civilité: { kind: "name", text: "Mme Dr" },
      accord: { kind: "name", text: "Oui" },
      langues: { kind: "list", items: ["fr", "it"] },
    });
  });

  it("refuses a file that is not an FDF", () => {
    expect(() => parseFdf(bytes("%PDF-1.7\n"))).toThrow();
  });

  it("round-trips every kind of value, Unicode included", () => {
    const entries: DataEntry[] = [
      { name: "client.nom", type: "text", value: "Wałęsa — « Łódź »" },
      { name: "client.adresse", type: "text", value: "1 rue (bis)\nGenève \\ CH" },
      { name: "accord", type: "checkbox", value: "Oui" },
      { name: "civilité", type: "radiobutton", value: "Mme Dr" },
      { name: "langues", type: "listbox", value: ["fr", "de"] },
      { name: "vide", type: "checkbox", value: "Off" },
    ];
    const fdf = toFdf(entries, "commande.pdf");
    const text = new TextDecoder("latin1").decode(fdf);
    // One hierarchy for « client », names for boxes.
    expect(text).toContain("/T (client) /Kids");
    expect(text).toContain("/V /Oui");
    expect(text).toContain("/V /Mme#20Dr");
    const back = parseFdf(fdf);
    expect(back.get("client.nom")).toEqual({ kind: "text", text: "Wałęsa — « Łódź »" });
    expect(back.get("client.adresse")).toEqual({ kind: "text", text: "1 rue (bis)\nGenève \\ CH" });
    expect(back.get("civilité")).toEqual({ kind: "name", text: "Mme Dr" });
    expect(back.get("langues")).toEqual({ kind: "list", items: ["fr", "de"] });
    expect(back.get("vide")).toEqual({ kind: "name", text: "Off" });
  });

  it("encodes strings and names per ISO 32000", () => {
    expect(encodePdfString("a(b)\\c")).toBe("(a\\(b\\)\\\\c)");
    expect(encodePdfString("é")).toBe("<FEFF00E9>");
    expect(encodePdfName("a b/c")).toBe("/a#20b#2Fc");
    expect(decodePdfString([0x95, 0x80])).toBe("Ł•");
  });
});

describe("formdata — XFDF form data", () => {
  it("round-trips nested fields and multi-values", () => {
    const entries: DataEntry[] = [
      { name: "client.nom", type: "text", value: "Dupont & <fils>" },
      { name: "langues", type: "listbox", value: ["fr", "it"] },
    ];
    const xml = toXfdfFields(entries, "c.pdf");
    expect(xml).toContain('<field name="client">');
    const back = parseXfdfFields(xml);
    expect(back.get("client.nom")).toEqual({ kind: "text", text: "Dupont & <fils>" });
    expect(back.get("langues")).toEqual({ kind: "list", items: ["fr", "it"] });
  });

  it("finds no field data in a comments-only XFDF", () => {
    const xml = '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots><text page="0"/></annots></xfdf>';
    expect(parseXfdfFields(xml).size).toBe(0);
  });
});

describe("formdata — tab-delimited text and CSV", () => {
  it("round-trips Acrobat's text format (header row, value row)", () => {
    const entries: DataEntry[] = [
      { name: "nom", type: "text", value: 'Dupont "fils"' },
      { name: "note", type: "text", value: "ligne 1\nligne 2" },
    ];
    const back = parseTabText(toTabText(entries));
    expect(back.get("nom")).toEqual({ kind: "text", text: 'Dupont "fils"' });
    expect(back.get("note")).toEqual({ kind: "text", text: "ligne 1\nligne 2" });
  });

  it("writes a CSV Excel opens in French (BOM, semicolons, lists joined)", () => {
    const csv = toCsv([{ name: "langues", type: "listbox", value: ["fr", "it"] }]);
    expect(csv.startsWith("﻿Champ;Valeur\r\n")).toBe(true);
    expect(csv).toContain("langues;fr, it");
  });
});

describe("formdata — matching imported values to the document", () => {
  const fields = new Map<string, FormField>([
    ["nom", field("nom", "text")],
    [
      "accord",
      field("accord", "checkbox", { widgets: [{ id: "a", page: 0, rect: null, exportValue: "Oui", hidden: false }] }),
    ],
    ["langues", field("langues", "listbox", { multiSelect: true })],
    ["signature", field("signature", "signature")],
  ]);

  it("shapes values by field type and reports unknown or unfitting names", () => {
    const res = matchImported(
      fields,
      new Map([
        ["nom", { kind: "text", text: "Dupont" }],
        ["accord", { kind: "name", text: "Yes" }],
        ["langues", { kind: "list", items: ["fr", "it"] }],
        ["inconnu", { kind: "text", text: "x" }],
        ["signature", { kind: "text", text: "x" }],
      ] as const),
    );
    expect(res.values).toEqual({ nom: "Dupont", accord: "Oui", langues: ["fr", "it"] });
    expect(res.unknown.sort()).toEqual(["inconnu", "signature"]);
    const bad = matchImported(fields, new Map([["accord", { kind: "name", text: "Peut-être" }]] as const));
    expect(bad.rejected).toEqual(["accord"]);
  });

  it("exports EVERY fillable field, not only the edited ones", () => {
    const entries = exportEntries(fields, { nom: "Dupont" });
    expect(entries.map((e) => e.name)).toEqual(["nom", "accord", "langues"]);
    expect(entries[1].value).toBe("Off");
  });
});
