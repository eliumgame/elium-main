import { describe, it, expect } from "vitest";
import { createThrottle, type Timers } from "../src/workspace/throttle";

function fakeTimers() {
  let t = 0;
  const q: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const timers: Timers = {
    set(fn, ms) {
      q.push({ at: t + ms, fn, id: ++id });
      return id;
    },
    clear(h) {
      const i = q.findIndex((x) => x.id === h);
      if (i >= 0) q.splice(i, 1);
    },
    now: () => t,
  };
  return {
    timers,
    advance(ms: number) {
      t += ms;
      for (const job of q.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
        q.splice(q.indexOf(job), 1);
        job.fn();
      }
    },
  };
}

describe("createThrottle", () => {
  it("exécute le premier appel tout de suite puis regroupe les suivants", () => {
    const f = fakeTimers();
    const seen: number[] = [];
    const th = createThrottle((n: number) => seen.push(n), 1000, f.timers);
    th(1);
    th(2);
    th(3);
    expect(seen).toEqual([1]);
    f.advance(999);
    expect(seen).toEqual([1]);
    f.advance(1);
    expect(seen).toEqual([1, 3]); // seul le dernier appel compte
  });

  it("flush exécute l'appel en attente immédiatement, une seule fois", () => {
    const f = fakeTimers();
    const seen: number[] = [];
    const th = createThrottle((n: number) => seen.push(n), 1000, f.timers);
    th(1);
    th(2);
    th.flush();
    expect(seen).toEqual([1, 2]);
    f.advance(5000);
    expect(seen).toEqual([1, 2]);
    th.flush();
    expect(seen).toEqual([1, 2]);
  });

  it("cancel abandonne l'appel en attente", () => {
    const f = fakeTimers();
    const seen: number[] = [];
    const th = createThrottle((n: number) => seen.push(n), 1000, f.timers);
    th(1);
    th(2);
    th.cancel();
    f.advance(5000);
    expect(seen).toEqual([1]);
  });

  it("repart immédiatement après un silence plus long que l'intervalle", () => {
    const f = fakeTimers();
    const seen: number[] = [];
    const th = createThrottle((n: number) => seen.push(n), 1000, f.timers);
    th(1);
    f.advance(2500);
    th(2);
    expect(seen).toEqual([1, 2]);
  });
});
