import { describe, it, expect } from "vitest";
import { revealAt, maxStep, planAnimations } from "../src/slides/playback";
import type { SlideElement, SlideAnim } from "../src/slides/model";

const el = (id: string): SlideElement => ({ id, type: "text", x: 0, y: 0, w: 10, h: 10 });
const stepOf = (anims: SlideAnim[], id: string) => planAnimations(anims).find((p) => p.elementId === id)!.clickStep;
const delayOf = (anims: SlideAnim[], id: string) => planAnimations(anims).find((p) => p.elementId === id)!.delayMs;

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

describe("animation triggers (onClick / withPrevious / afterPrevious)", () => {
  const els = [el("a"), el("b"), el("c"), el("d")];

  it("onClick is the default: each animation consumes its own click", () => {
    const anims: SlideAnim[] = [
      { elementId: "a", effect: "fade", order: 1 },
      { elementId: "b", effect: "fade", order: 2 },
      { elementId: "c", effect: "fade", order: 3 },
    ];
    expect(maxStep(anims)).toBe(3);
    expect([stepOf(anims, "a"), stepOf(anims, "b"), stepOf(anims, "c")]).toEqual([1, 2, 3]);
  });

  it("withPrevious shares the previous animation's click (no extra click)", () => {
    const anims: SlideAnim[] = [
      { elementId: "a", effect: "fade", order: 1 },
      { elementId: "b", effect: "fade", order: 2, trigger: "withPrevious" },
      { elementId: "c", effect: "fade", order: 3, trigger: "onClick" },
    ];
    // a & b reveal on click 1 together; c needs a second click.
    expect(stepOf(anims, "a")).toBe(1);
    expect(stepOf(anims, "b")).toBe(1);
    expect(stepOf(anims, "c")).toBe(2);
    expect(maxStep(anims)).toBe(2);

    const r = revealAt(els, anims, 1);
    expect(r.entering.has("a")).toBe(true);
    expect(r.entering.has("b")).toBe(true); // same click as a
    expect(r.hidden.has("c")).toBe(true);
  });

  it("afterPrevious shares the click but starts once the previous one finished", () => {
    const anims: SlideAnim[] = [
      { elementId: "a", effect: "fade", order: 1, durationMs: 400 },
      { elementId: "b", effect: "fade", order: 2, trigger: "afterPrevious", durationMs: 300 },
      { elementId: "c", effect: "fade", order: 3, trigger: "afterPrevious", delayMs: 100 },
    ];
    // All three on the same click (no onClick after the first).
    expect(maxStep(anims)).toBe(1);
    expect([stepOf(anims, "a"), stepOf(anims, "b"), stepOf(anims, "c")]).toEqual([1, 1, 1]);
    // Sequential delays accumulate: a@0, b@400 (after a's 400ms), c@700+100.
    expect(delayOf(anims, "a")).toBe(0);
    expect(delayOf(anims, "b")).toBe(400);
    expect(delayOf(anims, "c")).toBe(800);

    // The entering anim carries the resolved delay so the canvas staggers them.
    const r = revealAt(els, anims, 1);
    expect(r.entering.get("b")!.delayMs).toBe(400);
    expect(r.entering.get("c")!.delayMs).toBe(800);
  });

  it("withPrevious keeps its own delay and does not push the step clock backwards", () => {
    const anims: SlideAnim[] = [
      { elementId: "a", effect: "fade", order: 1, durationMs: 500 },
      { elementId: "b", effect: "fade", order: 2, trigger: "withPrevious", delayMs: 150 },
      { elementId: "c", effect: "fade", order: 3, trigger: "afterPrevious" },
    ];
    // b starts alongside a (+150ms of its own delay). c (afterPrevious) waits for
    // the LATEST end of the step: max(a end 500, b end 150+500=650) = 650.
    expect(delayOf(anims, "b")).toBe(150);
    expect(delayOf(anims, "c")).toBe(650);
    expect(maxStep(anims)).toBe(1);
  });

  it("a leading order-0 with-slide animation still enters at step 0", () => {
    const anims: SlideAnim[] = [
      { elementId: "a", effect: "fade", order: 0 },
      { elementId: "b", effect: "fade", order: 1, trigger: "withPrevious" },
    ];
    // order 0 = with the slide (step 0); withPrevious joins that same step.
    expect(stepOf(anims, "a")).toBe(0);
    expect(stepOf(anims, "b")).toBe(0);
    expect(maxStep(anims)).toBe(0);
    const r = revealAt(els, anims, 0);
    expect(r.entering.has("a")).toBe(true);
    expect(r.entering.has("b")).toBe(true);
  });
});
