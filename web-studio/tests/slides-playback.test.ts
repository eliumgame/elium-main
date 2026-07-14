import { describe, it, expect } from "vitest";
import { revealAt, maxStep } from "../src/slides/playback";
import type { SlideElement, SlideAnim } from "../src/slides/model";

const el = (id: string): SlideElement => ({ id, type: "text", x: 0, y: 0, w: 10, h: 10 });

describe("slides playback engine", () => {
  const els = [el("a"), el("b"), el("c"), el("d")];
  const anims: SlideAnim[] = [
    { elementId: "b", effect: "fade", order: 0 }, // with the slide
    { elementId: "c", effect: "zoom", order: 1 }, // 1st click
    { elementId: "d", effect: "spin", order: 2 }, // 2nd click
    // "a" has no animation → always visible
  ];

  it("maxStep is the highest order", () => {
    expect(maxStep(anims)).toBe(2);
    expect(maxStep([])).toBe(0);
    expect(maxStep(undefined)).toBe(0);
  });

  it("step 0: with-slide element enters, later ones hidden, unanimated always visible", () => {
    const r = revealAt(els, anims, 0);
    expect(r.hidden.has("a")).toBe(false); // no anim → visible
    expect(r.entering.has("b")).toBe(true); // order 0 enters now
    expect(r.hidden.has("c")).toBe(true);   // order 1 still hidden
    expect(r.hidden.has("d")).toBe(true);   // order 2 still hidden
  });

  it("step 1: c enters, d still hidden, b now just visible", () => {
    const r = revealAt(els, anims, 1);
    expect(r.entering.has("c")).toBe(true);
    expect(r.hidden.has("d")).toBe(true);
    expect(r.hidden.has("b")).toBe(false);   // already revealed
    expect(r.entering.has("b")).toBe(false); // not entering anymore
  });

  it("step 2 (last): everything visible, d entering", () => {
    const r = revealAt(els, anims, 2);
    expect(r.hidden.size).toBe(0);
    expect(r.entering.has("d")).toBe(true);
  });

  it("no animations → nothing hidden at step 0", () => {
    const r = revealAt(els, [], 0);
    expect(r.hidden.size).toBe(0);
    expect(r.entering.size).toBe(0);
  });
});
