import { describe, it, expect } from "vitest";
import { createCalc, isError } from "../src/sheet/formula";

function calc(cells: Record<string, string>) {
  return createCalc(
    (r) => cells[r],
    undefined,
    undefined,
    () => Object.keys(cells),
  );
}
const v = (cells: Record<string, string>, ref: string) => calc(cells).valueOf(ref);
const d = (cells: Record<string, string>, ref: string) => calc(cells).display(ref);

describe("opérateurs & ^ % et plages en position scalaire", () => {
  it("concatène, élève à la puissance, pourcentage", () => {
    expect(v({ A1: '="a"&1&TRUE' }, "A1")).toBe("a1TRUE");
    expect(v({ A1: "=2^3^2" }, "A1")).toBe(64); // gauche-à-droite comme Excel : (2^3)^2
    expect(v({ A1: "=-2^2" }, "A1")).toBe(4);
    expect(v({ A1: "=50%" }, "A1")).toBe(0.5);
  });
  it("SUMPRODUCT et SUM d'un produit de plages", () => {
    const c = { A1: "1", A2: "2", A3: "3", B1: "4", B2: "5", B3: "6", C1: "=SUMPRODUCT(A1:A3,B1:B3)", C2: "=SUM(A1:A3*B1:B3)" };
    expect(v(c, "C1")).toBe(32);
    expect(v(c, "C2")).toBe(32);
  });
});

describe("LET / LAMBDA", () => {
  it("LET lie des noms séquentiellement", () => {
    expect(v({ A1: "=LET(x,2,y,x*3,x+y)" }, "A1")).toBe(8);
  });
  it("LAMBDA appelée immédiatement et via LET", () => {
    expect(v({ A1: "=LAMBDA(x,y,x*y)(3,4)" }, "A1")).toBe(12);
    expect(v({ A1: "=LET(f,LAMBDA(n,n+1),f(f(1)))" }, "A1")).toBe(3);
  });
  it("une lambda capture son environnement", () => {
    expect(v({ A1: "=LET(k,10,f,LAMBDA(n,n+k),LET(k,99,f(1)))" }, "A1")).toBe(11);
  });
  it("une lambda non appelée donne #CALC, une variable inconnue #NAME", () => {
    expect(v({ A1: "=LAMBDA(x,x)" }, "A1")).toEqual({ error: "#CALC" });
    expect(v({ A1: "=foo+1" }, "A1")).toEqual({ error: "#NAME" });
  });
});

describe("débordement (spill)", () => {
  it("SEQUENCE déborde sur les cellules voisines", () => {
    const c = { A1: "=SEQUENCE(3,2)" };
    expect(d(c, "A1")).toBe("1");
    expect(d(c, "B1")).toBe("2");
    expect(d(c, "A3")).toBe("5");
    expect(d(c, "B3")).toBe("6");
    expect(d(c, "C1")).toBe("");
  });
  it("#SPILL! quand une cellule de destination est occupée", () => {
    const c = { A1: "=SEQUENCE(3)", A2: "x" };
    expect(v(c, "A1")).toEqual({ error: "#SPILL!" });
    expect(d(c, "A3")).toBe(""); // rien n'a débordé
  });
  it("une cellule ordinaire peut référencer une cellule débordée et l'opérateur #", () => {
    const c = { A1: "=SEQUENCE(4)", C1: "=A3*10", C2: "=SUM(A1#)" };
    expect(v(c, "C1")).toBe(30);
    expect(v(c, "C2")).toBe(10);
  });
  it("A1:A3*2 déborde", () => {
    const c = { A1: "1", A2: "2", A3: "3", B1: "=A1:A3*2" };
    expect([d(c, "B1"), d(c, "B2"), d(c, "B3")]).toEqual(["2", "4", "6"]);
  });
  it("sans énumérateur de cellules, seule la première valeur est rendue (pas de débordement)", () => {
    const c = createCalc((r) => ({ A1: "=SEQUENCE(3)" })[r as "A1"]);
    expect(c.valueOf("A1")).toBe(1);
  });
});

describe("fonctions tableau", () => {
  const data = { A1: "b", A2: "a", A3: "c", A4: "a", B1: "2", B2: "1", B3: "3", B4: "4" };
  it("SORT / SORTBY / UNIQUE", () => {
    const c = { ...data, D1: "=SORT(A1:A4)", F1: "=UNIQUE(A1:A4)", H1: "=SORTBY(A1:A4,B1:B4,-1)" };
    expect([d(c, "D1"), d(c, "D2"), d(c, "D3"), d(c, "D4")]).toEqual(["a", "a", "b", "c"]);
    expect([d(c, "F1"), d(c, "F2"), d(c, "F3"), d(c, "F4")]).toEqual(["b", "a", "c", ""]);
    expect([d(c, "H1"), d(c, "H2"), d(c, "H3"), d(c, "H4")]).toEqual(["a", "c", "b", "a"]);
  });
  it("FILTER avec condition et valeur par défaut", () => {
    const c = { ...data, D1: '=FILTER(A1:B4,B1:B4>1)', G1: '=FILTER(A1:A4,B1:B4>9,"rien")' };
    expect([d(c, "D1"), d(c, "E1"), d(c, "D2"), d(c, "E2"), d(c, "D3"), d(c, "E3")]).toEqual(["b", "2", "c", "3", "a", "4"]);
    expect(d(c, "G1")).toBe("rien");
    expect(v({ ...data, D1: "=FILTER(A1:A4,B1:B4>9)" }, "D1")).toEqual({ error: "#CALC" });
  });
  it("TRANSPOSE, TAKE, DROP, CHOOSECOLS, CHOOSEROWS", () => {
    const m = { A1: "1", B1: "2", C1: "3", A2: "4", B2: "5", C2: "6" };
    expect([d({ ...m, E1: "=TRANSPOSE(A1:C2)" }, "F3")]).toEqual(["6"]);
    expect(d({ ...m, E1: "=TAKE(A1:C2,1,2)" }, "F1")).toBe("2");
    expect(d({ ...m, E1: "=TAKE(A1:C2,1,2)" }, "G1")).toBe("");
    expect(d({ ...m, E1: "=TAKE(A1:C2,-1)" }, "G1")).toBe("6");
    expect(d({ ...m, E1: "=DROP(A1:C2,1,1)" }, "F1")).toBe("6");
    expect(d({ ...m, E1: "=CHOOSECOLS(A1:C2,3,1)" }, "E2")).toBe("6");
    expect(d({ ...m, E1: "=CHOOSEROWS(A1:C2,-1)" }, "E1")).toBe("4");
  });
  it("VSTACK / HSTACK complètent par #N/A", () => {
    const c = { A1: "1", A2: "2", B1: "9", D1: "=VSTACK(A1:A2,B1)", F1: "=HSTACK(A1:A2,B1)" };
    expect([d(c, "D1"), d(c, "D2"), d(c, "D3")]).toEqual(["1", "2", "9"]);
    expect([d(c, "F1"), d(c, "G1"), d(c, "F2"), d(c, "G2")]).toEqual(["1", "9", "2", "#N/A"]);
  });
  it("TEXTSPLIT sépare en colonnes et lignes", () => {
    const c = { A1: '=TEXTSPLIT("a,b;c,d",",",";")' };
    expect([d(c, "A1"), d(c, "B1"), d(c, "A2"), d(c, "B2")]).toEqual(["a", "b", "c", "d"]);
    expect(d({ A1: '=TEXTSPLIT("1-2-3","-")' }, "C1")).toBe("3");
  });
  it("WRAPROWS / TOCOL / EXPAND", () => {
    const c = { A1: "=WRAPROWS(SEQUENCE(5),2,0)" };
    expect([d(c, "A1"), d(c, "B1"), d(c, "A3"), d(c, "B3")]).toEqual(["1", "2", "5", "0"]);
    expect(d({ A1: "=TOCOL(SEQUENCE(2,2))" }, "A4")).toBe("4");
    expect(d({ A1: "=EXPAND(SEQUENCE(1,1),2,2,\"x\")" }, "B2")).toBe("x");
  });
  it("XMATCH : exact, approché et dernier-vers-premier", () => {
    const c = { A1: "10", A2: "20", A3: "30", A4: "20" };
    expect(v({ ...c, C1: "=XMATCH(20,A1:A4)" }, "C1")).toBe(2);
    expect(v({ ...c, C1: "=XMATCH(20,A1:A4,0,-1)" }, "C1")).toBe(4);
    expect(v({ ...c, C1: "=XMATCH(25,A1:A3,-1)" }, "C1")).toBe(2);
    expect(v({ ...c, C1: "=XMATCH(25,A1:A3,1)" }, "C1")).toBe(3);
    expect(v({ ...c, C1: "=XMATCH(99,A1:A3)" }, "C1")).toEqual({ error: "#N/A" });
  });
  it("RANDARRAY respecte la forme et les bornes", () => {
    const c = { A1: "=RANDARRAY(2,3,5,6,TRUE)" };
    for (const r of ["A1", "C1", "A2", "C2"]) {
      const x = v(c, r);
      expect(typeof x === "number" && x >= 5 && x <= 6).toBe(true);
    }
    expect(d(c, "D1")).toBe("");
  });
});

describe("fonctions d'ordre supérieur", () => {
  it("MAP applique une lambda élément par élément", () => {
    const c = { A1: "=MAP(SEQUENCE(3),LAMBDA(x,x*x))" };
    expect([d(c, "A1"), d(c, "A2"), d(c, "A3")]).toEqual(["1", "4", "9"]);
  });
  it("MAP sur deux tableaux", () => {
    const c = { A1: "=MAP(SEQUENCE(2),SEQUENCE(2,1,10),LAMBDA(a,b,a+b))" };
    expect([d(c, "A1"), d(c, "A2")]).toEqual(["11", "13"]);
  });
  it("REDUCE et SCAN", () => {
    expect(v({ A1: "=REDUCE(0,SEQUENCE(4),LAMBDA(a,x,a+x))" }, "A1")).toBe(10);
    expect(v({ A1: "=REDUCE(SEQUENCE(4),LAMBDA(a,x,a*x))" }, "A1")).toBe(24);
    const c = { A1: "=SCAN(0,SEQUENCE(4),LAMBDA(a,x,a+x))" };
    expect([d(c, "A1"), d(c, "A2"), d(c, "A3"), d(c, "A4")]).toEqual(["1", "3", "6", "10"]);
  });
  it("BYROW / BYCOL / MAKEARRAY, avec fonction native passée en valeur", () => {
    const m = { A1: "1", B1: "2", A2: "3", B2: "4" };
    const r = { ...m, D1: "=BYROW(A1:B2,LAMBDA(r,SUM(r)))", F1: "=BYCOL(A1:B2,SUM)" };
    expect([d(r, "D1"), d(r, "D2")]).toEqual(["3", "7"]);
    expect([d(r, "F1"), d(r, "G1")]).toEqual(["4", "6"]);
    const mk = { A1: "=MAKEARRAY(2,2,LAMBDA(i,j,i*10+j))" };
    expect([d(mk, "A1"), d(mk, "B1"), d(mk, "A2"), d(mk, "B2")]).toEqual(["11", "12", "21", "22"]);
  });
  it("REDUCE avec VSTACK accumule un tableau", () => {
    const c = { A1: "=REDUCE(0,SEQUENCE(2),LAMBDA(a,x,VSTACK(a,x)))" };
    expect([d(c, "A1"), d(c, "A2"), d(c, "A3")]).toEqual(["0", "1", "2"]);
  });
  it("IF et fonctions élémentaires sont vectorisées, IFERROR remplace par élément", () => {
    const c = { A1: "1", A2: "5", B1: '=IF(A1:A2>2,"grand","petit")', D1: "=IFERROR(1/(A1:A2-1),-1)" };
    expect([d(c, "B1"), d(c, "B2")]).toEqual(["petit", "grand"]);
    expect([d(c, "D1"), d(c, "D2")]).toEqual(["-1", "0.25"]);
  });
  it("une erreur d'élément n'écrase pas les voisins", () => {
    const c = { A1: "=MAP(SEQUENCE(3,1,-1),LAMBDA(x,1/x))" };
    expect([d(c, "A1"), d(c, "A2"), d(c, "A3")]).toEqual(["-1", "#DIV/0", "1"]);
  });
  it("garde-fou : récursion/taille démesurée donne une erreur, pas un gel", () => {
    expect(isError(v({ A1: "=SEQUENCE(100000,100)" }, "A1"))).toBe(true);
  });
});
