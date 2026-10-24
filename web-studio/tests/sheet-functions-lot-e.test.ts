import { describe, expect, it } from "vitest";
import { createCalc } from "../src/sheet/formula";

const val = (f: string) => createCalc((r) => (r === "A1" ? f : undefined)).valueOf("A1");

describe("fonctions ajoutées après le balayage navigateur", () => {
  it("VALUE convertit un texte en nombre (virgule française comprise)", () => {
    expect(val('=VALUE("12")+1')).toBe(13);
    expect(val('=VALUE("3,5")')).toBe(3.5);
    expect(val('=VALUE("abc")')).toEqual({ error: "#VALUE" });
  });
  it("REPT répète un texte, avec plafond", () => {
    expect(val('=REPT("ab",3)')).toBe("ababab");
    expect(val('=REPT("x",-1)')).toEqual({ error: "#VALUE" });
    expect(val('=REPT("xxxxxxxxxx",1000000)')).toEqual({ error: "#VALUE" });
  });
  it("SWITCH choisit selon la valeur, avec valeur par défaut", () => {
    expect(val('=SWITCH(2,1,"a",2,"b")')).toBe("b");
    expect(val('=SWITCH(9,1,"a",2,"b","autre")')).toBe("autre");
    expect(val('=SWITCH(9,1,"a",2,"b")')).toEqual({ error: "#N/A" });
  });
  it("FLOOR / CEILING acceptent un multiple", () => {
    expect(val("=FLOOR(7,2)")).toBe(6);
    expect(val("=CEILING(7,2)")).toBe(8);
    expect(val("=CEILING(7.2)")).toBe(8);
    expect(val("=FLOOR(7.8)")).toBe(7);
  });
});
