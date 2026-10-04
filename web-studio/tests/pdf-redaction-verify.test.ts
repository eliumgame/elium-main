import { describe, it, expect } from "vitest";
import { describeVerification, verifyRedaction } from "../src/pdf/ops/redaction-verify";

describe("vérification de caviardage", () => {
  it("signale une donnée restée lisible, même reformatée", () => {
    const v = verifyRedaction(["Bonjour", "IBAN FR76 3000 1007 9412"], ["FR76 3000 1007 9412", "Dupont"]);
    expect(v.ok).toBe(false);
    expect(v.leaks).toEqual([{ text: "FR76 3000 1007 9412", pages: [2] }]);
    expect(describeVerification(v).join(" ")).toContain("ATTENTION");
  });
  it("valide quand rien ne subsiste et ignore les textes trop courts", () => {
    const v = verifyRedaction(["Document propre"], ["Élodie Martin", "ab"]);
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(1);
    expect(v.skipped).toEqual(["ab"]);
    expect(describeVerification(v)[0]).toMatch(/Aucune donnée sous le noir/);
  });
});
