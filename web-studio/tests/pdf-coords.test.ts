import { describe, it, expect } from "vitest";
import {
  fromPoints, inflate, normRotation, overlapRatio, psToView, quadFromRect, quadToPdfQuadPoints,
  rectFromPoints, rectFromView, rectOfPoints, rectToPdfRect, rectToView, rotatedSize, toPoints,
  viewToPs, type Quad, type Rect, type Size,
} from "../src/pdf/core/coords";

const size: Size = { w: 600, h: 800 };

describe("PDF geometry — rotation round-trips", () => {
  it("maps a point through every rotation and back unchanged", () => {
    const point = { x: 123.5, y: 456.25 };
    for (const rotation of [0, 90, 180, 270] as const) {
      const view = psToView(point, size, rotation);
      const back = viewToPs(view, size, rotation);
      expect(back.x).toBeCloseTo(point.x, 6);
      expect(back.y).toBeCloseTo(point.y, 6);
    }
  });

  it("sends the page's top-left corner to the expected view corner", () => {
    // Rotating the page 90° clockwise puts its top-left at the view's top-right.
    expect(psToView({ x: 0, y: 0 }, size, 90)).toEqual({ x: 800, y: 0 });
    expect(psToView({ x: 0, y: 0 }, size, 180)).toEqual({ x: 600, y: 800 });
    expect(psToView({ x: 0, y: 0 }, size, 270)).toEqual({ x: 0, y: 600 });
  });

  it("swaps the axes for quarter turns", () => {
    expect(rotatedSize(size, 90)).toEqual({ w: 800, h: 600 });
    expect(rotatedSize(size, 180)).toEqual({ w: 600, h: 800 });
  });

  it("round-trips a rectangle through the view for every rotation", () => {
    const rect: Rect = { x: 40, y: 90, w: 220, h: 60 };
    for (const rotation of [0, 90, 180, 270] as const) {
      const back = rectFromView(rectToView(rect, size, rotation), size, rotation);
      expect(back.x).toBeCloseTo(rect.x, 6);
      expect(back.y).toBeCloseTo(rect.y, 6);
      expect(back.w).toBeCloseTo(rect.w, 6);
      expect(back.h).toBeCloseTo(rect.h, 6);
    }
  });

  it("normalises any angle to a quarter turn", () => {
    expect(normRotation(-90)).toBe(270);
    expect(normRotation(450)).toBe(90);
    expect(normRotation(0)).toBe(0);
    expect(normRotation(360)).toBe(0);
  });
});

describe("PDF geometry — PDF space", () => {
  it("flips y when producing a /Rect array", () => {
    const rect: Rect = { x: 10, y: 20, w: 100, h: 50 };
    // Page space y=20 is 20 from the TOP; in PDF space the box spans 730..780.
    expect(rectToPdfRect(rect, 800)).toEqual([10, 730, 110, 780]);
  });

  it("emits /QuadPoints in the spec's upper-left, upper-right, LOWER-LEFT order", () => {
    const quad: Quad = quadFromRect({ x: 10, y: 20, w: 100, h: 40 });
    const pts = quadToPdfQuadPoints(quad, 800);
    expect(pts).toEqual([
      10, 780, // upper-left
      110, 780, // upper-right
      10, 740, // lower-left
      110, 740, // lower-right
    ]);
  });
});

describe("PDF geometry — helpers", () => {
  it("builds a rect from two corners in any drag direction", () => {
    expect(rectFromPoints({ x: 30, y: 40 }, { x: 10, y: 10 })).toEqual({ x: 10, y: 10, w: 20, h: 30 });
  });

  it("bounds a set of points", () => {
    expect(rectOfPoints([{ x: 5, y: 9 }, { x: -3, y: 2 }, { x: 11, y: 4 }])).toEqual({ x: -3, y: 2, w: 14, h: 7 });
  });

  it("measures how much of a box is covered", () => {
    const inner: Rect = { x: 0, y: 0, w: 10, h: 10 };
    expect(overlapRatio(inner, { x: 0, y: 0, w: 5, h: 10 })).toBeCloseTo(0.5, 6);
    expect(overlapRatio(inner, { x: 50, y: 50, w: 5, h: 5 })).toBe(0);
    expect(overlapRatio(inner, { x: -5, y: -5, w: 40, h: 40 })).toBeCloseTo(1, 6);
  });

  it("inflates symmetrically", () => {
    expect(inflate({ x: 10, y: 10, w: 20, h: 20 }, 5)).toEqual({ x: 5, y: 5, w: 30, h: 30 });
  });

  it("converts between points and display units", () => {
    expect(fromPoints(72, "in")).toBeCloseTo(1, 6);
    expect(fromPoints(72, "mm")).toBeCloseTo(25.4, 6);
    expect(toPoints(1, "in")).toBeCloseTo(72, 6);
    expect(toPoints(25.4, "mm")).toBeCloseTo(72, 6);
    expect(toPoints(fromPoints(123.456, "cm"), "cm")).toBeCloseTo(123.456, 6);
  });
});
