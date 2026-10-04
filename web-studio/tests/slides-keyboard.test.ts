import { describe, it, expect } from "vitest";
import { describeElement, keyboardPatch, nextElementId } from "../src/slides/selection";
import type { SlideElement } from "../src/slides/model";

const el = (over: Partial<SlideElement> = {}): SlideElement => ({
  id: "a",
  type: "text",
  x: 10,
  y: 10,
  w: 30,
  h: 20,
  html: "<p>Bonjour <b>monde</b></p>",
  ...over,
});

describe("accès clavier au canevas des diapositives", () => {
  it("déplace d'1 % (5 % avec Maj) et redimensionne avec Alt, borné au canevas", () => {
    expect(keyboardPatch(el(), "ArrowRight", false, false)).toEqual({ x: 11, y: 10 });
    expect(keyboardPatch(el(), "ArrowUp", true, false)).toEqual({ x: 10, y: 5 });
    expect(keyboardPatch(el(), "ArrowDown", false, true)).toEqual({ w: 30, h: 21 });
    expect(keyboardPatch(el({ x: 0 }), "ArrowLeft", false, false)).toEqual({ x: 0, y: 10 });
    expect(keyboardPatch(el({ x: 70 }), "ArrowRight", true, false)).toEqual({ x: 70, y: 10 });
    expect(keyboardPatch(el({ w: 2 }), "ArrowLeft", false, true)).toEqual({ w: 2, h: 20 });
  });
  it("ignore les éléments verrouillés et les autres touches", () => {
    expect(keyboardPatch(el({ locked: true }), "ArrowLeft", false, false)).toBeNull();
    expect(keyboardPatch(el(), "a", false, false)).toBeNull();
  });
  it("Tab parcourt les éléments puis rend la main aux deux extrémités", () => {
    const list = [el({ id: "a" }), el({ id: "b" }), el({ id: "c" })];
    expect(nextElementId(list, undefined, false)).toBe("a");
    expect(nextElementId(list, undefined, true)).toBe("c");
    expect(nextElementId(list, "a", false)).toBe("b");
    expect(nextElementId(list, "c", false)).toBeNull();
    expect(nextElementId(list, "a", true)).toBeNull();
    expect(nextElementId([], undefined, false)).toBeNull();
  });
  it("décrit l'élément pour un lecteur d'écran", () => {
    expect(describeElement(el(), 1, 4)).toBe("Texte 2 sur 4 : Bonjour monde");
    expect(describeElement(el({ type: "table", table: { rows: 2, cols: 3, cells: [] }, locked: true }), 0, 1)).toBe(
      "Tableau 1 sur 1 : 2 lignes, 3 colonnes (verrouillé)",
    );
  });
});
