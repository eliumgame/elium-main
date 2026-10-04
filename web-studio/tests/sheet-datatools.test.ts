import { describe, it, expect } from "vitest";
import { buildPattern, findAll, removeDuplicates, replaceAll, splitText, textToColumns } from "../src/sheet/datatools";
import type { SheetData, Workbook } from "../src/sheet/model";

const sheet = (cells: Record<string, string>, extra: Partial<SheetData> = {}): SheetData => ({
  name: "F",
  rows: 20,
  cols: 6,
  cells,
  ...extra,
});

describe("suppression des doublons", () => {
  const s = sheet({
    A1: "Nom",
    B1: "Ville",
    A2: "Ana",
    B2: "Paris",
    A3: "ana",
    B3: "paris",
    A4: "Bob",
    B4: "Lyon",
    A5: "Ana",
    B5: "Nice",
    A6: "Bob",
    B6: "Lyon",
  });
  it("sur toutes les colonnes, insensible à la casse, en-tête conservé", () => {
    const r = removeDuplicates(s, { c0: 0, r0: 0, c1: 1, r1: 5 }, { hasHeader: true });
    expect(r.removed).toBe(2);
    expect(r.sheet.cells).toMatchObject({
      A1: "Nom",
      A2: "Ana",
      B2: "Paris",
      A3: "Bob",
      B3: "Lyon",
      A4: "Ana",
      B4: "Nice",
    });
    expect(r.sheet.cells.A5).toBeUndefined();
    expect(r.sheet.cells.A6).toBeUndefined();
  });
  it("sur une seule colonne clé", () => {
    const r = removeDuplicates(s, { c0: 0, r0: 0, c1: 1, r1: 5 }, { hasHeader: true, cols: [0] });
    expect(r.removed).toBe(3);
    expect(r.sheet.cells.A2).toBe("Ana");
    expect(r.sheet.cells.B3).toBe("Lyon");
    expect(r.sheet.cells.A4).toBeUndefined();
  });
  it("sensible à la casse ; sans doublon : feuille inchangée", () => {
    expect(removeDuplicates(s, { c0: 0, r0: 1, c1: 0, r1: 2 }, { hasHeader: false, caseSensitive: true }).removed).toBe(
      0,
    );
    const same = sheet({ A1: "a", A2: "b" });
    const r = removeDuplicates(same, { c0: 0, r0: 0, c1: 0, r1: 1 }, { hasHeader: false });
    expect(r.sheet).toBe(same);
  });
  it("les styles suivent les lignes déplacées", () => {
    const st = sheet({ A1: "x", A2: "x", A3: "y" }, { styles: { A3: { bold: true } } });
    const r = removeDuplicates(st, { c0: 0, r0: 0, c1: 0, r1: 2 }, { hasHeader: false });
    expect(r.sheet.styles).toEqual({ A2: { bold: true } });
  });
});

describe("texte en colonnes", () => {
  it("séparateurs multiples, guillemets, fusion des consécutifs", () => {
    expect(splitText('a;b,"c;d",e', { delimiters: [";", ","] })).toEqual(["a", "b", "c;d", "e"]);
    expect(splitText("a  b   c", { delimiters: [" "], mergeConsecutive: true })).toEqual(["a", "b", "c"]);
    expect(splitText("a,,c", { delimiters: [","] })).toEqual(["a", "", "c"]);
    expect(splitText('"il dit ""oui""",x', { delimiters: [","] })).toEqual(['il dit "oui"', "x"]);
  });
  it("largeurs fixes", () => {
    expect(splitText("20260315Paris", { widths: [4, 2, 2] })).toEqual(["2026", "03", "15", "Paris"]);
  });
  it("répartit sur les colonnes de droite, agrandit la feuille, ignore les formules", () => {
    const s = sheet({ A1: "a,b,c", A2: "d,e", A3: "=1+1", B2: "ancien" }, { cols: 2 });
    const r = textToColumns(s, { c0: 0, r0: 0, c1: 0, r1: 2 }, { delimiters: [","] });
    expect(r.maxParts).toBe(3);
    expect(r.sheet.cells).toMatchObject({ A1: "a", B1: "b", C1: "c", A2: "d", B2: "e", A3: "=1+1" });
    expect(r.sheet.cells.C2).toBeUndefined();
    expect(r.sheet.cols).toBe(3);
  });
});

describe("rechercher / remplacer", () => {
  const wb: Workbook = {
    active: 0,
    sheets: [
      sheet({ A1: "Chat noir", A2: "chat", B1: '=CONCAT("chat",A1)', A3: "Chien" }),
      { ...sheet({ A1: "un CHAT", B2: "12" }), name: "G" },
    ],
  };
  it("recherche littérale, insensible à la casse, sur toutes les feuilles, valeurs seulement", () => {
    const r = findAll(wb, { find: "chat" }) as { matches: { sheet: number; ref: string }[] };
    expect(r.matches.map((m) => `${m.sheet}:${m.ref}`)).toEqual(["0:A1", "0:A2", "1:A1"]);
  });
  it("formules incluses, feuille unique, cellule entière, casse", () => {
    expect((findAll(wb, { find: "chat", inFormulas: true }) as { matches: unknown[] }).matches).toHaveLength(4);
    expect((findAll(wb, { find: "chat", sheet: 1 }) as { matches: unknown[] }).matches).toHaveLength(1);
    expect(
      (findAll(wb, { find: "chat", wholeCell: true }) as { matches: { ref: string }[] }).matches.map((m) => m.ref),
    ).toEqual(["A2"]);
    expect((findAll(wb, { find: "chat", caseSensitive: true }) as { matches: unknown[] }).matches).toHaveLength(1);
  });
  it("regex avec groupes capturés et $&", () => {
    const r = replaceAll(wb, { find: "(\\w+) (\\w+)", replace: "$2 $1", regex: true, sheet: 0 }) as {
      wb: Workbook;
      count: number;
    };
    expect(r.count).toBe(1);
    expect(r.wb.sheets[0]!.cells.A1).toBe("noir Chat");
    expect(r.wb.sheets[1]!.cells.A1).toBe("un CHAT");
    const amp = replaceAll(wb, { find: "ch", replace: "[$&]", regex: true, sheet: 0 }) as { wb: Workbook };
    expect(amp.wb.sheets[0]!.cells.A1).toBe("[Ch]at noir");
  });
  it("remplacement littéral : les caractères spéciaux ne sont pas interprétés", () => {
    const w: Workbook = { active: 0, sheets: [sheet({ A1: "1.5 + 2", A2: "1x5" })] };
    const r = replaceAll(w, { find: "1.5", replace: "$1" }) as { wb: Workbook; count: number };
    expect(r.count).toBe(1);
    expect(r.wb.sheets[0]!.cells.A1).toBe("$1 + 2");
    expect(r.wb.sheets[0]!.cells.A2).toBe("1x5");
  });
  it("l'original n'est pas modifié ; formules touchées seulement si demandé", () => {
    const r = replaceAll(wb, { find: "chat", replace: "chien", inFormulas: true }) as { wb: Workbook };
    expect(r.wb.sheets[0]!.cells.B1).toContain("chien");
    expect(wb.sheets[0]!.cells.A2).toBe("chat");
    const nf = replaceAll(wb, { find: "chat", replace: "chien" }) as { wb: Workbook };
    expect(nf.wb.sheets[0]!.cells.B1).toContain('"chat"');
  });
  it("expression invalide ou vide : message d'erreur, pas d'exception", () => {
    expect(buildPattern({ find: "(", regex: true })).toHaveProperty("error");
    expect(findAll(wb, { find: "" })).toHaveProperty("error");
    expect(replaceAll(wb, { find: "[", regex: true })).toHaveProperty("error");
  });
});
