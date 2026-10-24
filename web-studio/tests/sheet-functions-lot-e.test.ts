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

describe("saisie numérique française", () => {
  const calcOf = (cells: Record<string, string>) => createCalc((r) => cells[r]);
  it("« 12,5 » et « 1 234,5 » sont des nombres", async () => {
    const { parseCellNumber } = await import("../src/sheet/numeric");
    expect(parseCellNumber("12,5")).toBe(12.5);
    expect(parseCellNumber("-0,25")).toBe(-0.25);
    expect(parseCellNumber("1 234,5")).toBe(1234.5);
    expect(parseCellNumber("1 234")).toBe(1234);
    expect(parseCellNumber("12.5")).toBe(12.5);
    expect(parseCellNumber("abc")).toBeNull();
    expect(parseCellNumber("1,2,3")).toBeNull();
    expect(parseCellNumber("01 23 45")).toBeNull();
    expect(parseCellNumber("")).toBeNull();
  });
  it("les formules calculent sur les nombres saisis avec une virgule", () => {
    const c = calcOf({ A1: "12,5", A2: "2", B1: "=A1*A2", B2: "=SUM(A1:A2)" });
    expect(c.valueOf("B1")).toBe(25);
    expect(c.valueOf("B2")).toBe(14.5);
    expect(c.display("A1")).toBe("12,5"); // l'écriture saisie est conservée à l'affichage
  });
  it("le tri compare ces nombres comme des nombres", async () => {
    const { sortRange } = await import("../src/sheet/structural");
    const sheet = { name: "S", rows: 5, cols: 2, cells: { A1: "10,5", A2: "9", A3: "100,25" } };
    const out = sortRange(sheet as never, 0, { c0: 0, r0: 0, c1: 0, r1: 2 }, 1, () => "");
    expect([out.cells.A1, out.cells.A2, out.cells.A3]).toEqual(["9", "10,5", "100,25"]);
  });
});
