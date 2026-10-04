import { describe, it, expect } from "vitest";
import { phrasesUnder } from "../src/pdf/ops/redaction-check";
import { verifyRedaction } from "../src/pdf/ops/redaction-verify";
import type { LayoutWord } from "../src/pdf/ops/compare";

const word = (text: string, x: number, y: number, line: number): LayoutWord => ({
  text,
  rect: { x, y, w: 40, h: 10 },
  line,
  fontSize: 10,
  bold: false,
  italic: false,
});

describe("texte sous les zones caviardées", () => {
  it("relève, ligne par ligne, les mots dont le centre tombe dans la zone", () => {
    const words = [
      word("Jean", 10, 10, 0),
      word("Dupont", 60, 10, 0),
      word("né", 110, 10, 0),
      word("le", 10, 40, 1),
      word("12/03/1980", 60, 40, 1),
    ];
    const phrases = phrasesUnder(words, [{ x: 5, y: 5, w: 100, h: 50 }]);
    expect(phrases).toEqual(["Jean Dupont", "le 12/03/1980"]);
  });

  it("de bout en bout : fuite détectée si le texte survit dans le fichier enregistré", () => {
    expect(verifyRedaction(["Contrat de Jean Dupont"], ["Jean Dupont"]).ok).toBe(false);
    expect(verifyRedaction(["Contrat de ████"], ["Jean Dupont"]).ok).toBe(true);
  });
});
