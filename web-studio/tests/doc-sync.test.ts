import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocSync, flushPendingDocChange, setActiveDocSync } from "../src/editor/doc-sync";
import type { ProseMirrorNode } from "../src/format/types";

const node = (n: number) => ({ type: "doc", content: [], n }) as unknown as ProseMirrorNode;

describe("doc-sync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("regroupe une rafale de frappes en une seule remontée", () => {
    let version = 0;
    const read = vi.fn(() => node(version));
    const emit = vi.fn();
    const sync = createDocSync(read, emit, { quietMs: 100, maxWaitMs: 400 });
    for (let i = 0; i < 20; i++) {
      version = i;
      sync.schedule();
      vi.advanceTimersByTime(30);
    }
    expect(emit).toHaveBeenCalledTimes(1); // le délai maximal (400 ms) a joué une fois
    vi.advanceTimersByTime(200);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("flush remonte immédiatement le document le plus récent, une seule fois", () => {
    let version = 1;
    const emit = vi.fn();
    const sync = createDocSync(() => node(version), emit);
    sync.schedule();
    version = 2;
    expect(sync.pending()).toBe(true);
    const doc = sync.flush() as unknown as { n: number };
    expect(doc.n).toBe(2);
    expect(sync.flush()).toBeUndefined();
    vi.advanceTimersByTime(2000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("cancel abandonne la modification en attente", () => {
    const emit = vi.fn();
    const sync = createDocSync(() => node(0), emit);
    sync.schedule();
    sync.cancel();
    vi.advanceTimersByTime(2000);
    expect(emit).not.toHaveBeenCalled();
  });

  it("flushPendingDocChange vide l'instance active", () => {
    const emit = vi.fn();
    const sync = createDocSync(() => node(7), emit);
    const off = setActiveDocSync(sync);
    expect(flushPendingDocChange()).toBeUndefined();
    sync.schedule();
    expect((flushPendingDocChange() as unknown as { n: number }).n).toBe(7);
    off();
    sync.schedule();
    expect(flushPendingDocChange()).toBeUndefined();
  });
});
