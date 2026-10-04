// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readListRange, withLiveLists, buildValidator } from "../src/sheet/validation";
import { workbookToXlsx } from "../src/sheet/xlsx-export";
import { importXlsx } from "../src/sheet/xlsx-import";
import type { Workbook } from "../src/sheet/model";

const wb = (): Workbook => ({
  active: 0,
  sheets: [
    {
      name: "Saisie",
      rows: 5,
      cols: 3,
      cells: {},
      validations: [{ id: "v", c0: 0, r0: 0, c1: 0, r1: 4, type: "list", list: [], listRef: "Listes!A1:A3" }],
    },
    { name: "Listes", rows: 5, cols: 2, cells: { A1: "Oui", A2: "Non", A3: "Peut-être", A4: "ignoré" } },
  ],
});

describe("liste de validation depuis une plage", () => {
  it("lit les valeurs, ignore vides et formules, gère les noms de feuille cités", () => {
    const w = wb();
    expect(readListRange(w, "Listes!A1:A3", "Saisie")).toEqual(["Oui", "Non", "Peut-être"]);
    expect(readListRange(w, "A1:A2", "Listes")).toEqual(["Oui", "Non"]);
    expect(readListRange(w, "'Listes'!$A$1:$A$2", "Saisie")).toEqual(["Oui", "Non"]);
    expect(readListRange(w, "Nope!A1:A3", "Saisie")).toEqual([]);
    expect(readListRange(w, "n'importe quoi", "Saisie")).toEqual([]);
  });
  it("la liste suit les cellules (live) et la validation s'y réfère", () => {
    const w = wb();
    const live = withLiveLists(w.sheets[0]!.validations, w, "Saisie")!;
    expect(live[0]!.list).toEqual(["Oui", "Non", "Peut-être"]);
    const v = buildValidator(live, () => "");
    expect(v(0, 1)).toBeNull(); // pas de valeur : permis
    w.sheets[1]!.cells.A2 = "Jamais";
    expect(withLiveLists(w.sheets[0]!.validations, w, "Saisie")![0]!.list).toEqual(["Oui", "Jamais", "Peut-être"]);
  });
  it("XLSX : formula1 = la plage, relue au réimport avec son instantané", () => {
    const back = importXlsx(workbookToXlsx(wb()));
    const dv = back.sheets[0]!.validations![0]!;
    expect(dv.listRef).toBe("Listes!A1:A3");
    expect(dv.type).toBe("list");
  });
});
