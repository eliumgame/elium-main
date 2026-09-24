import { describe, expect, it } from "vitest";
import {
  LAYOUT_DEFAULTS,
  FIT_MARGIN_X,
  buildRows,
  captureAnchor,
  clampScroll,
  computeLayout,
  fitScale,
  isPlaced,
  mostVisiblePage,
  rangeInBand,
  resolveAnchor,
  scrollTopForPage,
  visiblePages,
  type PageBox,
} from "../src/pdf/core/viewer/layout";

const A4: PageBox = { w: 595, h: 842 };
const { gap, padTop, padBottom, spreadGap } = LAYOUT_DEFAULTS;

describe("layout — continuous", () => {
  it("stacks rows as prefix sums, centred in the viewport", () => {
    const boxes = [A4, { w: 842, h: 595 }, A4];
    const l = computeLayout(boxes, { mode: "continuous", cover: false, scale: 1, viewportWidth: 1200 });
    expect(Array.from(l.y)).toEqual([padTop, padTop + 842 + gap, padTop + 842 + gap + 595 + gap]);
    expect(l.x[0]).toBeCloseTo((1200 - 595) / 2);
    expect(l.x[1]).toBeCloseTo((1200 - 842) / 2);
    expect(l.contentHeight).toBe(padTop + 842 + gap + 595 + gap + 842 + padBottom);
    expect(l.contentWidth).toBe(1200);
  });

  it("scales every box and widens the content (not the viewport) for a page wider than it", () => {
    const l = computeLayout([A4, { w: 1191, h: 842 }], {
      mode: "continuous",
      cover: false,
      scale: 2,
      viewportWidth: 1000,
    });
    expect(l.w[1]).toBe(2382);
    expect(l.contentWidth).toBe(2382 + 2 * LAYOUT_DEFAULTS.padX);
    expect(l.x[1]).toBeCloseTo(LAYOUT_DEFAULTS.padX);
  });
});

describe("layout — two-up", () => {
  it("groups spreads with and without a cover", () => {
    expect(buildRows(5, "facingContinuous", false)).toEqual([
      [0, 2],
      [2, 4],
      [4, 5],
    ]);
    expect(buildRows(5, "facingContinuous", true)).toEqual([
      [0, 1],
      [1, 3],
      [3, 5],
    ]);
    expect(buildRows(3, "continuous", true)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("aligns every spread on one spine; the cover sits right of it", () => {
    const boxes = [A4, A4, A4, A4];
    const l = computeLayout(boxes, { mode: "facingContinuous", cover: true, scale: 1, viewportWidth: 1400 });
    const spine = l.contentWidth / 2;
    expect(l.x[0]).toBeCloseTo(spine + spreadGap / 2); // cover: right page
    expect(l.x[1] + l.w[1]).toBeCloseTo(spine - spreadGap / 2); // page 2: left
    expect(l.x[2]).toBeCloseTo(spine + spreadGap / 2); // page 3: right
    expect(l.y[1]).toBe(l.y[2]);
    expect(l.rowOf[3]).toBe(2);
  });

  it("puts a lone last page on the left without a cover", () => {
    const l = computeLayout([A4, A4, A4], { mode: "facingContinuous", cover: false, scale: 1, viewportWidth: 1400 });
    const spine = l.contentWidth / 2;
    expect(l.x[2] + l.w[2]).toBeCloseTo(spine - spreadGap / 2);
  });

  it("vertically centres pages of unequal height in a spread", () => {
    const l = computeLayout([A4, { w: 595, h: 400 }], {
      mode: "facingContinuous",
      cover: false,
      scale: 1,
      viewportWidth: 1400,
    });
    expect(l.rows[0].height).toBe(842);
    expect(l.y[1]).toBe(padTop + (842 - 400) / 2);
  });
});

describe("layout — paged modes", () => {
  it("single: only the shown row is placed, at the top", () => {
    const boxes = [A4, { w: 842, h: 595 }, A4];
    const l = computeLayout(boxes, { mode: "single", cover: false, scale: 1, viewportWidth: 1200, row: 1 });
    expect(isPlaced(l, 0)).toBe(false);
    expect(isPlaced(l, 1)).toBe(true);
    expect(isPlaced(l, 2)).toBe(false);
    expect(l.y[1]).toBe(padTop);
    expect(l.contentHeight).toBe(padTop + 595 + padBottom);
    expect(rangeInBand(l, 0, 5000)).toEqual({ first: 1, last: 1 });
  });

  it("facing: shows one spread; the row index is clamped", () => {
    const l = computeLayout([A4, A4, A4, A4, A4], {
      mode: "facing",
      cover: true,
      scale: 1,
      viewportWidth: 1400,
      row: 99,
    });
    expect(l.shownRow).toBe(2);
    expect([3, 4].every((i) => isPlaced(l, i))).toBe(true);
    expect([0, 1, 2].some((i) => isPlaced(l, i))).toBe(false);
  });
});

describe("layout — visible range (binary search)", () => {
  const many = Array.from({ length: 1000 }, () => A4);
  const l = computeLayout(many, { mode: "continuous", cover: false, scale: 1, viewportWidth: 1200 });
  const pitch = 842 + gap;

  it("finds the rows intersecting a band anywhere in a 1000-page document", () => {
    const top = padTop + 700 * pitch + 10;
    expect(rangeInBand(l, top, top + 900)).toEqual({ first: 700, last: 701 });
    expect(rangeInBand(l, 0, 10)).toEqual({ first: 0, last: 0 });
  });

  it("keeps the nearest row for a band past the end", () => {
    expect(rangeInBand(l, l.contentHeight + 5000, l.contentHeight + 6000)).toEqual({ first: 999, last: 999 });
  });

  it("reports visible pages most-visible first, with the tile area", () => {
    const top = padTop + 10 * pitch + 600; // page 10 bottom 242px, page 11 top
    const vis = visiblePages(l, { top, left: 0, width: 1200, height: 900 });
    expect(vis.map((v) => v.index)).toEqual([11, 10]);
    expect(vis[1].visibleArea).toEqual({ minX: 0, minY: 600, maxX: 595, maxY: 842 });
    expect(mostVisiblePage(l, { top, left: 0, width: 1200, height: 900 })).toBe(11);
  });

  it("marks a fully visible page with a null visibleArea", () => {
    const vis = visiblePages(l, { top: 0, left: 0, width: 1200, height: 2000 });
    expect(vis.find((v) => v.index === 0)?.visibleArea).toBeNull();
    expect(vis.find((v) => v.index === 0)?.percent).toBe(100);
  });
});

describe("layout — anchoring", () => {
  const boxes = Array.from({ length: 20 }, () => A4);
  const base = { mode: "continuous" as const, cover: false, viewportWidth: 1200 };
  const viewport = { width: 1200, height: 900 };

  it("keeps the point under the cursor fixed across a zoom", () => {
    const before = computeLayout(boxes, { ...base, scale: 1 });
    const scroll = { top: 5 * (842 + gap) + 300, left: 0 };
    const anchor = captureAnchor(before, scroll, 700, 400);
    // ×3 so the new scroll position needs no clamping on either axis.
    const after = computeLayout(boxes, { ...base, scale: 3 });
    const next = resolveAnchor(after, anchor, viewport);
    // Same document point (page + offset in points) under the same viewport pixel.
    const back = captureAnchor(after, next, 700, 400);
    expect(back.index).toBe(anchor.index);
    expect(back.px).toBeCloseTo(anchor.px, 6);
    expect(back.py).toBeCloseTo(anchor.py, 6);
  });

  it("does not move the page being read when a page above changes size", () => {
    const before = computeLayout(boxes, { ...base, scale: 1 });
    const scroll = { top: before.y[8] + 120, left: 0 };
    const anchor = captureAnchor(before, scroll, 0, 0);
    expect(anchor.index).toBe(8);
    const grown = boxes.map((b, i) => (i === 3 ? { w: 842, h: 1191 } : b)); // estimate → real A3
    const after = computeLayout(grown, { ...base, scale: 1 });
    const next = resolveAnchor(after, anchor, viewport);
    expect(next.top - after.y[8]).toBeCloseTo(120, 6);
  });

  it("clamps to the scrollable range", () => {
    expect(clampScroll(-5, 1000, 400)).toBe(0);
    expect(clampScroll(900, 1000, 400)).toBe(600);
    expect(clampScroll(50, 300, 400)).toBe(0);
  });

  it("scrolls a page (and a destination inside it) to the top", () => {
    const l = computeLayout(boxes, { ...base, scale: 1.5 });
    expect(scrollTopForPage(l, 4)).toBeCloseTo(l.y[4] - 16);
    expect(scrollTopForPage(l, 4, 100)).toBeCloseTo(l.y[4] + 150 - 16);
    expect(scrollTopForPage(l, 0, 0, 100)).toBe(0);
  });
});

describe("fitScale — the 'Largeur' zoom", () => {
  // mixed-geometry.pdf from the test corpus: A4, landscape, /Rotate 90/180/270,
  // an offset CropBox and an A3 page (sizes below are view-oriented).
  const mixed: PageBox[] = [
    { w: 595, h: 842 },
    { w: 842, h: 595 },
    { w: 792, h: 612 },
    { w: 595, h: 842 },
    { w: 380, h: 545 },
    { w: 842, h: 1191 },
    { w: 595, h: 842 },
  ];

  it("fits the current page's width to the viewport, not to the content", () => {
    const viewport = { width: 1106, height: 713 };
    const s = fitScale("fitWidth", mixed[0], viewport);
    expect(s).toBeCloseTo((1106 - FIT_MARGIN_X) / 595, 6);
    // At that zoom the A3 page is wider than the viewport — the CONTENT widens…
    const l = computeLayout(mixed, { mode: "continuous", cover: false, scale: s, viewportWidth: viewport.width });
    expect(l.contentWidth).toBeGreaterThan(viewport.width);
    // …but fitting again with the same viewport is a fixed point: no runaway to 1000 %.
    expect(fitScale("fitWidth", mixed[0], viewport)).toBe(s);
    expect(s).toBeLessThan(2);
  });

  it("uses the rotated width of a rotated page, and two pages in a spread", () => {
    const viewport = { width: 1106, height: 713 };
    expect(fitScale("fitWidth", mixed[2], viewport)).toBeCloseTo((1106 - FIT_MARGIN_X) / 792, 6);
    expect(fitScale("fitWidth", mixed[0], viewport, { twoUp: true })).toBeCloseTo(
      (1106 - FIT_MARGIN_X) / (2 * 595 + spreadGap),
      6,
    );
  });

  it("fits the whole page by the tighter dimension", () => {
    const s = fitScale("fitPage", mixed[5], { width: 1106, height: 713 });
    expect(s * 1191).toBeLessThanOrEqual(713);
    expect(s * 842).toBeLessThanOrEqual(1106);
  });
});
