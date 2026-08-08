import { describe, it, expect } from "vitest";
import { fingerprintWords } from "../src/sign/safety-words";

describe("safety-words", () => {
  const fpr = "a".repeat(64); // sha256-like hex

  it("est déterministe et renvoie le nombre de mots demandé", () => {
    const a = fingerprintWords(fpr);
    expect(a).toBe(fingerprintWords(fpr));
    expect(a.split(" ")).toHaveLength(6);
    expect(fingerprintWords(fpr, 4).split(" ")).toHaveLength(4);
  });

  it("distingue deux empreintes différentes", () => {
    expect(fingerprintWords("a".repeat(64))).not.toBe(fingerprintWords("b".repeat(64)));
    // Une différence sur le 1er octet change le 1er mot.
    const w1 = fingerprintWords("00" + "a".repeat(62)).split(" ")[0];
    const w2 = fingerprintWords("ff" + "a".repeat(62)).split(" ")[0];
    expect(w1).not.toBe(w2);
  });

  it("gère une empreinte vide/invalide sans planter", () => {
    expect(fingerprintWords("")).toBe("");
    expect(fingerprintWords("zz")).toBe("");
  });
});
