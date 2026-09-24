import { describe, expect, it } from "vitest";
import {
  RenderQueue,
  RenderingState,
  ViewBuffer,
  bufferSizeFor,
  chooseNext,
  type QueueView,
} from "../src/pdf/core/viewer/queue";

/** A stand-in for pdf.js' PDFPageView: `draw()` resolves when `finish()` is called. */
function fakeView(id: string, state: number = RenderingState.INITIAL) {
  let finish: () => void = () => {};
  const v: QueueView & { draws: number; resumed: number; finish: () => void } = {
    renderingId: id,
    renderingState: state,
    resume: null,
    detailView: null,
    draws: 0,
    resumed: 0,
    finish: () => finish(),
    draw() {
      v.draws++;
      v.renderingState = RenderingState.RUNNING;
      return new Promise<void>((resolve) => {
        finish = () => {
          v.renderingState = RenderingState.FINISHED;
          resolve();
        };
      });
    },
  };
  return v;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("render queue — priorities (PDFRenderingQueue port)", () => {
  it("renders the visible pages first, most visible first", () => {
    const a = fakeView("a");
    const b = fakeView("b");
    const c = fakeView("c");
    expect(chooseNext([b, a], [c])).toBe(b);
    b.renderingState = RenderingState.FINISHED;
    expect(chooseNext([b, a], [c])).toBe(a);
  });

  it("then the detail (tile) views of visible pages, then the pages ahead", () => {
    const a = fakeView("a", RenderingState.FINISHED);
    const detail = fakeView("detail-a");
    a.detailView = detail;
    const next = fakeView("next");
    expect(chooseNext([a], [next])).toBe(detail);
    // During a zoom gesture only base rasters are refreshed.
    expect(chooseNext([a], [next], true)).toBe(next);
    detail.renderingState = RenderingState.FINISHED;
    expect(chooseNext([a], [next])).toBe(next);
    next.renderingState = RenderingState.FINISHED;
    expect(chooseNext([a], [next])).toBeNull();
  });

  it("draws one view at a time and moves on when it finishes", async () => {
    const a = fakeView("a");
    const b = fakeView("b");
    let visible: QueueView[] = [a, b];
    const q = new RenderQueue(() => chooseNext(visible, []));
    q.schedule();
    await tick();
    expect(a.draws).toBe(1);
    expect(b.draws).toBe(0);
    expect(q.isHighestPriority(a)).toBe(true);
    a.finish();
    await tick();
    await tick();
    expect(b.draws).toBe(1);
    expect(q.isHighestPriority(b)).toBe(true);
    b.finish();
    await tick();
    await tick();
    visible = [];
    q.renderHighestPriority();
    expect(q.isHighestPriority(a)).toBe(false);
    expect(q.isHighestPriority(b)).toBe(false);
  });

  it("lets a paused render resume instead of restarting it", () => {
    const a = fakeView("a", RenderingState.PAUSED);
    a.resume = () => a.resumed++;
    const q = new RenderQueue(() => a);
    q.renderHighestPriority();
    expect(a.resumed).toBe(1);
    expect(a.draws).toBe(0);
  });

  it("tells pdf.js' page views that a viewer drives them", () => {
    const q = new RenderQueue(() => null) as unknown as { hasViewer: () => boolean };
    expect(q.hasViewer()).toBe(true);
  });

  it("stops scheduling once stopped", async () => {
    const a = fakeView("a");
    const q = new RenderQueue(() => a);
    q.stop();
    q.schedule();
    await tick();
    expect(a.draws).toBe(0);
  });
});

describe("rendered-page buffer (PDFPageViewBuffer port)", () => {
  it("evicts the least recently used page past its size", () => {
    const evicted: string[] = [];
    const buf = new ViewBuffer<string>(3, (x) => evicted.push(x));
    for (const x of ["p1", "p2", "p3", "p4"]) buf.push(x);
    expect(evicted).toEqual(["p1"]);
    buf.push("p2"); // touched → most recent
    buf.push("p5");
    expect(evicted).toEqual(["p1", "p3"]);
    expect(buf.length).toBe(3);
  });

  it("never evicts the pages on screen when shrinking", () => {
    const evicted: string[] = [];
    const buf = new ViewBuffer<string>(5, (x) => evicted.push(x));
    for (const x of ["a", "b", "c", "d", "e"]) buf.push(x);
    buf.resize(2, new Set(["a", "b"]));
    expect(evicted.sort()).toEqual(["c", "d", "e"]);
    expect(buf.has("a") && buf.has("b")).toBe(true);
  });

  it("keeps at least 10 pages, more when many are visible", () => {
    expect(bufferSizeFor(1)).toBe(10);
    expect(bufferSizeFor(8)).toBe(17);
  });
});
