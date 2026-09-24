import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfEngine } from "../src/pdf/core/engine";
import { SCROLL_QUIET_MS, ThumbnailService } from "../src/pdf/core/thumbs";

/**
 * The thumbnail service must never compete with the page view (relecture F1) :
 * nothing starts while the view has pages to draw or a scroll runs, a render
 * in progress pauses at its next chunk, and a page the view already drew is
 * copied from its raster instead of being drawn again.
 */

interface FakeTask {
  promise: Promise<void>;
  cancel: () => void;
  onContinue: ((cont: () => void) => void) | null;
  /** pdf.js asks `onContinue` before each chunk; the render ends after `chunks` of them. */
  step: () => void;
  chunksRun: number;
}

function fakeEngine() {
  const tasks: FakeTask[] = [];
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => {
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      promise.catch(() => {});
      const task: FakeTask = {
        promise,
        cancel: () => reject(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" })),
        onContinue: null,
        chunksRun: 0,
        step: () => {
          const go = () => {
            task.chunksRun++;
            if (task.chunksRun >= 2) resolve();
          };
          if (task.onContinue) task.onContinue(go);
          else go();
        },
      };
      tasks.push(task);
      return task;
    },
  };
  const engine = {
    page: vi.fn(async () => page),
    releasePageResources: vi.fn(),
    raw: {},
  } as unknown as PdfEngine;
  return { engine, tasks };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const bitmap = (w: number, h: number) => ({ width: w, height: h, close: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  const ctx = { fillStyle: "", fillRect: () => {} };
  vi.stubGlobal("document", {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (src: { width: number; height: number }, opts?: { resizeWidth?: number; resizeHeight?: number }) =>
      bitmap(opts?.resizeWidth ?? src.width, opts?.resizeHeight ?? src.height),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ThumbnailService — waits for the page view", () => {
  it("starts nothing while the page view has pages to draw, then renders", async () => {
    const { engine, tasks } = fakeEngine();
    const s = new ThumbnailService(engine);
    s.setMainBusy(true);
    const got = vi.fn();
    s.request({ from: 3, rotation: 0, width: 120, priority: 0 }, got);
    await flush();
    expect(engine.page).not.toHaveBeenCalled();
    s.setMainBusy(false);
    await flush();
    expect(tasks).toHaveLength(1);
    tasks[0].step();
    tasks[0].step();
    await flush();
    expect(got).toHaveBeenCalledTimes(1);
    expect(engine.releasePageResources).toHaveBeenCalledWith(3);
  });

  it("waits for a scroll to have been quiet for SCROLL_QUIET_MS", async () => {
    const { engine, tasks } = fakeEngine();
    const s = new ThumbnailService(engine);
    s.noteScroll();
    s.request({ from: 0, rotation: 0, width: 120, priority: 0 }, () => {});
    await flush();
    vi.advanceTimersByTime(SCROLL_QUIET_MS / 2);
    s.noteScroll(); // still scrolling
    vi.advanceTimersByTime(SCROLL_QUIET_MS - 10);
    await flush();
    expect(tasks).toHaveLength(0);
    vi.advanceTimersByTime(20);
    await flush();
    expect(tasks).toHaveLength(1);
  });

  it("pauses a render in progress at its next chunk and resumes it once idle", async () => {
    const { engine, tasks } = fakeEngine();
    const s = new ThumbnailService(engine);
    const got = vi.fn();
    s.request({ from: 1, rotation: 0, width: 120, priority: 0 }, got);
    await flush();
    expect(tasks).toHaveLength(1);
    tasks[0].step(); // first chunk runs
    expect(tasks[0].chunksRun).toBe(1);
    s.setMainBusy(true);
    tasks[0].step(); // asked to continue while held: parked
    expect(tasks[0].chunksRun).toBe(1);
    s.setMainBusy(false);
    expect(tasks[0].chunksRun).toBe(2);
    await flush();
    expect(got).toHaveBeenCalledTimes(1);
  });

  it("copies a page the view has drawn instead of drawing it (offer and source)", async () => {
    const { engine, tasks } = fakeEngine();
    const s = new ThumbnailService(engine);
    s.setMainBusy(true);
    const got = vi.fn();
    s.request({ from: 2, rotation: 90, width: 120, priority: 0 }, got);
    await flush();
    const raster = { width: 1200, height: 900 } as HTMLCanvasElement;
    s.offer(2, 0, raster); // wrong rotation: not this thumbnail
    await flush();
    expect(got).not.toHaveBeenCalled();
    s.offer(2, 90, raster);
    await flush();
    expect(got).toHaveBeenCalledTimes(1);
    expect(got.mock.calls[0][0]).toMatchObject({ width: 120, height: 90 });
    expect(tasks).toHaveLength(0);

    // Requested later, once idle: taken from the attached source.
    s.attachSource((from, rotation) => (from === 5 && rotation === 0 ? raster : null));
    s.setMainBusy(false);
    const got2 = vi.fn();
    s.request({ from: 5, rotation: 0, width: 100, priority: 0 }, got2);
    await flush();
    expect(got2).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(0);
    expect(engine.page).not.toHaveBeenCalled();
  });

  it("never upscales a smaller raster", async () => {
    const { engine } = fakeEngine();
    const s = new ThumbnailService(engine);
    s.setMainBusy(true);
    const got = vi.fn();
    s.request({ from: 0, rotation: 0, width: 400, priority: 0 }, got);
    await flush();
    s.offer(0, 0, { width: 200, height: 260 } as HTMLCanvasElement);
    await flush();
    expect(got).not.toHaveBeenCalled();
  });

  it("asks function priorities again at each pick: what is visible now is drawn first", async () => {
    const { engine, tasks } = fakeEngine();
    const s = new ThumbnailService(engine);
    s.setMainBusy(true);
    // Requested in list order while a scroll runs; by the time the view is
    // idle the list has moved and page 7 is the one on screen.
    const where = new Map([
      [5, 3],
      [6, 2],
      [7, 1],
    ]);
    for (const from of [5, 6, 7]) {
      s.request({ from, rotation: 0, width: 120, priority: () => where.get(from)! }, () => {});
    }
    await flush();
    s.setMainBusy(false);
    await flush();
    expect(engine.page).toHaveBeenLastCalledWith(7);
    // Page 6 scrolls out of view while page 7 draws: page 5 comes next.
    where.set(6, 50);
    tasks[0].step();
    tasks[0].step();
    await flush();
    expect(engine.page).toHaveBeenLastCalledWith(5);
    // A second requester of the same page with a more urgent priority wins.
    const job = s.request({ from: 9, rotation: 0, width: 120, priority: 100 }, () => {});
    s.request({ from: 9, rotation: 0, width: 120, priority: () => 0 }, () => {});
    tasks[1].step();
    tasks[1].step();
    await flush();
    expect(engine.page).toHaveBeenLastCalledWith(9);
    job();
  });

  it("whenIdle runs once the hold lifts, or after maxWait at the latest", async () => {
    const { engine } = fakeEngine();
    const s = new ThumbnailService(engine);
    const a = vi.fn();
    s.setMainBusy(true);
    s.whenIdle(a, 300);
    await flush();
    expect(a).not.toHaveBeenCalled();
    s.setMainBusy(false);
    expect(a).toHaveBeenCalledTimes(1);

    const b = vi.fn();
    s.setMainBusy(true);
    s.whenIdle(b, 300);
    await flush();
    vi.advanceTimersByTime(301);
    expect(b).toHaveBeenCalledTimes(1);
    s.setMainBusy(false);
    expect(b).toHaveBeenCalledTimes(1);

    // Decided after the current task's microtasks: a view that becomes busy
    // in the same turn (a jump) still defers it.
    const c = vi.fn();
    s.whenIdle(c, 300);
    s.setMainBusy(true);
    await flush();
    expect(c).not.toHaveBeenCalled();
    s.setMainBusy(false);
    expect(c).toHaveBeenCalledTimes(1);
  });
});
