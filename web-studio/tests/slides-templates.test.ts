import { describe, it, expect } from "vitest";
import { SLIDE_TEMPLATES, GRADIENT_PRESETS, SOLID_PRESETS, gradientCss } from "../src/slides/templates";

describe("SLIDE_TEMPLATES (template application logic)", () => {
  it("has a unique id per template, matching the layout ids the editor offers", () => {
    const ids = SLIDE_TEMPLATES.map((tpl) => tpl.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("title");
    expect(ids).toContain("title-content");
    expect(ids).toContain("blank");
  });

  it("every non-blank template builds at least one element with a fresh id each call", () => {
    for (const tpl of SLIDE_TEMPLATES) {
      const a = tpl.build();
      const b = tpl.build();
      if (tpl.id === "blank") {
        expect(a).toEqual([]);
        continue;
      }
      expect(a.length).toBeGreaterThan(0);
      // Two separate insertions of the same template must not collide on element id
      // (each insertSlide/duplicateSlide would otherwise silently merge/overwrite elements).
      const idsA = a.map((e) => e.id);
      const idsB = b.map((e) => e.id);
      expect(new Set(idsA).size).toBe(idsA.length);
      expect(idsA.some((id) => idsB.includes(id))).toBe(false);
    }
  });

  it("defaults rotation to 0 and opacity to 1 on every built element", () => {
    for (const tpl of SLIDE_TEMPLATES) {
      for (const el of tpl.build()) {
        expect(el.rotation).toBe(0);
        expect(el.opacity).toBe(1);
      }
    }
  });

  it("keeps every built element's geometry within the 0-100% canvas", () => {
    for (const tpl of SLIDE_TEMPLATES) {
      for (const el of tpl.build()) {
        expect(el.x).toBeGreaterThanOrEqual(0);
        expect(el.y).toBeGreaterThanOrEqual(0);
        expect(el.x + el.w).toBeLessThanOrEqual(100);
        expect(el.y + el.h).toBeLessThanOrEqual(100);
      }
    }
  });

  it("only declares a background as a hex colour or a CSS gradient() function", () => {
    for (const tpl of SLIDE_TEMPLATES) {
      if (tpl.background === undefined) continue;
      expect(tpl.background).toMatch(/^(#[0-9a-f]{3,8}|linear-gradient\(.+\))$/i);
    }
  });

  it("the 'compare' template pairs up matching shape/label/detail elements for both columns", () => {
    const compare = SLIDE_TEMPLATES.find((t) => t.id === "compare")!;
    const els = compare.build();
    const shapes = els.filter((e) => e.type === "shape");
    expect(shapes).toHaveLength(2);
    const texts = els.filter((e) => e.type === "text");
    expect(texts.length).toBeGreaterThanOrEqual(4); // title + 2 option labels + 2 detail blocks
  });
});

describe("background presets", () => {
  it("GRADIENT_PRESETS and SOLID_PRESETS are non-empty and well-formed", () => {
    expect(GRADIENT_PRESETS.length).toBeGreaterThan(0);
    for (const g of GRADIENT_PRESETS) expect(g).toMatch(/^linear-gradient\(/);
    expect(SOLID_PRESETS.length).toBeGreaterThan(0);
    for (const c of SOLID_PRESETS) expect(c).toMatch(/^#[0-9a-f]{3,8}$/i);
  });

  it("gradientCss builds a linear-gradient from two colours and an angle", () => {
    expect(gradientCss("#111111", "#222222", 45)).toBe("linear-gradient(45deg, #111111, #222222)");
    expect(gradientCss("red", "blue", 0)).toBe("linear-gradient(0deg, red, blue)");
  });
});
