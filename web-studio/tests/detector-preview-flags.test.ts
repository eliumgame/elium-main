import { describe, expect, it } from "vitest";
import { segmentParagraph, flagsByParagraph, type PreviewFlag } from "../src/detector/ui/previewFlags";

describe("detector — segmentation des paragraphes pour la surbrillance rouge", () => {
  it("ne segmente pas un paragraphe sans finding", () => {
    expect(segmentParagraph("Un texte quelconque.", [])).toEqual([{ text: "Un texte quelconque.", flagged: false }]);
  });

  it("souligne exactement la citation littérale quand evidence est un extrait du texte", () => {
    const text = "Cette police Calibri 11pt détonne dans le document.";
    const flags: PreviewFlag[] = [{ id: "1", paragraphIndex: 0, label: "Police incohérente", evidence: "Calibri 11pt" }];
    const segs = segmentParagraph(text, flags);
    expect(segs.map((s) => s.text).join("")).toBe(text);
    const flagged = segs.filter((s) => s.flagged);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].text).toBe("Calibri 11pt");
    expect(flagged[0].labels).toEqual(["Police incohérente"]);
  });

  it("souligne tout le paragraphe quand evidence n'est pas une citation littérale", () => {
    const text = "Un paragraphe avec plusieurs tics d'écriture.";
    const flags: PreviewFlag[] = [{ id: "1", paragraphIndex: 0, label: "Clichés multiples", evidence: "« en conclusion, » (1 fois)" }];
    const segs = segmentParagraph(text, flags);
    expect(segs).toEqual([{ text, flagged: true, labels: ["Clichés multiples"] }]);
  });

  it("fusionne deux plages qui se chevauchent en une seule, avec les deux labels", () => {
    const text = "Le mot suspect apparaît ici deux fois: suspect suspect.";
    const flags: PreviewFlag[] = [
      { id: "1", paragraphIndex: 0, label: "A", evidence: "suspect apparaît" },
      { id: "2", paragraphIndex: 0, label: "B", evidence: "apparaît ici" },
    ];
    const segs = segmentParagraph(text, flags);
    const flagged = segs.filter((s) => s.flagged);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].labels).toEqual(["A", "B"]);
  });

  it("reconstitue le texte d'origine sans perte ni doublon pour des plages disjointes", () => {
    const text = "Début normal, puis ALPHA au milieu, puis normal encore, puis BETA à la fin.";
    const flags: PreviewFlag[] = [
      { id: "1", paragraphIndex: 0, label: "A", evidence: "ALPHA" },
      { id: "2", paragraphIndex: 0, label: "B", evidence: "BETA" },
    ];
    const segs = segmentParagraph(text, flags);
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs.filter((s) => s.flagged).map((s) => s.text)).toEqual(["ALPHA", "BETA"]);
  });

  it("retombe sur le paragraphe entier si aucune evidence ne correspond littéralement", () => {
    const text = "Texte qui ne contient pas la citation attendue.";
    const flags: PreviewFlag[] = [{ id: "1", paragraphIndex: 0, label: "X", evidence: "chaîne absente" }];
    expect(segmentParagraph(text, flags)).toEqual([{ text, flagged: true, labels: ["X"] }]);
  });

  it("flagsByParagraph regroupe correctement par index, plusieurs findings par paragraphe", () => {
    const flags: PreviewFlag[] = [
      { id: "1", paragraphIndex: 2, label: "A" },
      { id: "2", paragraphIndex: 2, label: "B" },
      { id: "3", paragraphIndex: 5, label: "C" },
    ];
    const map = flagsByParagraph(flags);
    expect(map.get(2)?.map((f) => f.id)).toEqual(["1", "2"]);
    expect(map.get(5)?.map((f) => f.id)).toEqual(["3"]);
    expect(map.get(0)).toBeUndefined();
  });
});
