import { describe, it, expect } from "vitest";
import { parseTsvToChart } from "../src/editor/chartPaste";

describe("collage depuis le Tableur", () => {
  it("en-têtes + libellés + plusieurs séries", () => {
    const r = parseTsvToChart("Mois\tVentes\tMarge\nJan\t10\t3,5\nFév\t20\t5\n");
    expect(r).toEqual({
      labels: ["Jan", "Fév"],
      series: [
        { label: "Ventes", values: [10, 20] },
        { label: "Marge", values: [3.5, 5] },
      ],
    });
  });
  it("sans en-tête, colonnes numériques seules", () => {
    const r = parseTsvToChart("1\t2\n3\t4");
    expect(r!.series).toHaveLength(2);
    expect(r!.labels).toEqual(["1", "2"]);
  });
  it("pourcentages et colonne unique", () => {
    expect(parseTsvToChart("12%\n50%")!.series[0]!.values).toEqual([0.12, 0.5]);
  });
  it("texte inexploitable : null", () => {
    expect(parseTsvToChart("bonjour")).toBeNull();
    expect(parseTsvToChart("")).toBeNull();
  });
});
