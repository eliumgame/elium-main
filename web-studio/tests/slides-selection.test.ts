import { describe, it, expect } from "vitest";
import {
  unitIds, expandGroups, selectionAfterClick, marqueeHits, resizeGeometry, cloneElements,
} from "../src/slides/selection";
import type { SlideElement } from "../src/slides/model";

const el = (id: string, x: number, y: number, w = 10, h = 10, groupId?: string): SlideElement =>
  ({ id, type: "shape", x, y, w, h, ...(groupId ? { groupId } : {}) });

const els: SlideElement[] = [
  el("a", 0, 0),
  el("b", 20, 0, 10, 10, "g1"),
  el("c", 40, 0, 10, 10, "g1"),
  el("d", 60, 0),
];

describe("unitIds / expandGroups", () => {
  it("returns the whole group for a grouped element, else just itself", () => {
    expect(unitIds(els, "b").sort()).toEqual(["b", "c"]);
    expect(unitIds(els, "a")).toEqual(["a"]);
    expect(unitIds(els, "zzz")).toEqual([]);
  });
  it("expandGroups pulls each selected element's whole group in", () => {
    expect(expandGroups(els, ["a", "b"]).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("selectionAfterClick", () => {
  it("plain click selects just that unit (whole group for a grouped element)", () => {
    expect(selectionAfterClick(els, [], "a", false)).toEqual(["a"]);
    expect(selectionAfterClick(els, ["d"], "b", false).sort()).toEqual(["b", "c"]);
  });
  it("plain click on an already-selected element keeps the multi-selection (for group drag)", () => {
    expect(selectionAfterClick(els, ["a", "d"], "a", false)).toEqual(["a", "d"]);
  });
  it("additive click toggles the unit in and out", () => {
    expect(selectionAfterClick(els, ["a"], "d", true).sort()).toEqual(["a", "d"]);
    expect(selectionAfterClick(els, ["a", "d"], "d", true)).toEqual(["a"]);
  });
  it("additive click toggles a whole group as one unit", () => {
    expect(selectionAfterClick(els, ["a"], "b", true).sort()).toEqual(["a", "b", "c"]);
    expect(selectionAfterClick(els, ["a", "b", "c"], "c", true)).toEqual(["a"]);
  });
});

describe("marqueeHits", () => {
  it("selects elements whose box intersects the marquee", () => {
    // A rect covering x 0..35 catches a (0) and b (20) but not c (40) or d (60).
    expect(marqueeHits(els, { x: -2, y: -2, w: 37, h: 20 }).sort()).toEqual(["a", "b"]);
  });
  it("normalizes a marquee dragged up-left (negative w/h)", () => {
    expect(marqueeHits(els, { x: 35, y: 20, w: -37, h: -22 }).sort()).toEqual(["a", "b"]);
  });
  it("empty marquee selects nothing", () => {
    expect(marqueeHits(els, { x: 90, y: 90, w: 5, h: 5 })).toEqual([]);
  });
});

describe("resizeGeometry", () => {
  const o = { x: 10, y: 10, w: 20, h: 10 };
  it("grows the east/south edges", () => {
    expect(resizeGeometry(o, "se", 10, 5, false)).toEqual({ x: 10, y: 10, w: 30, h: 15 });
  });
  it("moves the west/north edges inward and keeps the far edge fixed", () => {
    const r = resizeGeometry(o, "nw", 5, 2, false);
    expect(r.x).toBe(15);
    expect(r.y).toBe(12);
    expect(r.w).toBe(15); // 20 - 5
    expect(r.h).toBe(8); // 10 - 2
  });
  it("proportional corner resize keeps the aspect ratio (w/h = 2)", () => {
    const r = resizeGeometry(o, "se", 20, 0, true); // width 20→40; height follows ratio
    expect(r.w).toBe(40);
    expect(r.h).toBe(20); // 40 / (20/10)
  });
  it("clamps so an element never leaves the slide or collapses", () => {
    const r = resizeGeometry({ x: 0, y: 0, w: 10, h: 10 }, "e", 999, 0, false);
    expect(r.w).toBeLessThanOrEqual(100);
    const min = resizeGeometry(o, "e", -999, 0, false);
    expect(min.w).toBeGreaterThanOrEqual(3);
  });
});

describe("cloneElements", () => {
  it("clones with fresh ids, an offset, and remapped group tags", () => {
    let n = 0;
    const mkId = () => `new${n++}`;
    const copies = cloneElements([els[1]!, els[2]!], mkId, 5, 5); // b,c (group g1)
    // fresh, distinct ids — not the originals
    expect(new Set(copies.map((c) => c.id)).size).toBe(2);
    expect(copies.map((c) => c.id)).not.toContain("b");
    expect(copies.map((c) => c.id)).not.toContain("c");
    expect(copies[0]!.x).toBe(25);
    expect(copies[0]!.y).toBe(5);
    // both copies share ONE new group id, distinct from the original "g1"
    expect(copies[0]!.groupId).toBe(copies[1]!.groupId);
    expect(copies[0]!.groupId).not.toBe("g1");
  });
  it("drops morphKey on a copy and clamps into the slide", () => {
    const src: SlideElement = { id: "x", type: "text", x: 96, y: 96, w: 10, h: 10, morphKey: "m1" };
    const [c] = cloneElements([src], () => "n", 5, 5);
    expect(c!.morphKey).toBeUndefined();
    expect(c!.x).toBeLessThanOrEqual(97);
  });
});
