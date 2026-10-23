import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkerTask, WorkerLimitError, WorkerTimeoutError } from "./worker-task";

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  posted: unknown[] = [];
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}
const mk = () => new FakeWorker() as unknown as Worker;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const base = { request: 1, inline: (n: number) => n * 2 };

describe("runWorkerTask", () => {
  it("replie en ligne sans Worker (jsdom) et relaie la progression", async () => {
    const seen: number[] = [];
    const out = await runWorkerTask({
      ...base,
      create: mk,
      inline: (n, ctx) => {
        ctx.progress(0.5, "mi-parcours");
        return n * 2;
      },
      onProgress: (p) => seen.push(p.fraction),
    });
    expect(out).toBe(2);
    expect(seen).toEqual([0.5]);
  });

  it("refuse une entrée au-dessus du plafond, avec un message clair", async () => {
    await expect(
      runWorkerTask({ ...base, create: mk, inputBytes: 200 * 1048576, maxInputBytes: 100 * 1048576 }),
    ).rejects.toThrow(WorkerLimitError);
    await expect(
      runWorkerTask({ ...base, create: mk, inputBytes: 5, maxInputBytes: 1, limitMessage: "trop gros" }),
    ).rejects.toThrow("trop gros");
  });

  it("rejette tout de suite si le signal est déjà annulé", async () => {
    const c = new AbortController();
    c.abort();
    await expect(runWorkerTask({ ...base, create: mk, signal: c.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("avec un Worker : résultat, progression, terminate", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const seen: string[] = [];
    const p = runWorkerTask({ ...base, create: mk, onProgress: (x) => seen.push(x.label) });
    const w = FakeWorker.last!;
    expect(w.posted).toHaveLength(0); // rien n'est envoyé avant « prêt »
    w.emit({ type: "ready" });
    expect(w.posted).toHaveLength(1);
    w.emit({ type: "progress", fraction: 0.3, label: "étape" });
    w.emit({ type: "result", value: 42 });
    expect(await p).toBe(42);
    expect(seen).toEqual(["étape"]);
    expect(w.terminated).toBe(true);
  });

  it("annulation : termine le Worker et rejette en AbortError", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const c = new AbortController();
    const p = runWorkerTask({ ...base, create: mk, signal: c.signal });
    const w = FakeWorker.last!;
    c.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(w.terminated).toBe(true);
  });

  it("délai maximal : termine le Worker et rejette en WorkerTimeoutError", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const p = runWorkerTask({ ...base, create: mk, timeoutMs: 5000 });
    const assertion = expect(p).rejects.toThrow(WorkerTimeoutError);
    vi.advanceTimersByTime(5001);
    await assertion;
    expect(FakeWorker.last!.terminated).toBe(true);
  });

  it("erreur du Worker : message et nom conservés", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const p = runWorkerTask({ ...base, create: mk });
    FakeWorker.last!.emit({ type: "ready" });
    FakeWorker.last!.emit({ type: "error", message: "PDF illisible", name: "PdfError" });
    await expect(p).rejects.toMatchObject({ message: "PDF illisible", name: "PdfError" });
  });

  it("Worker qui ne démarre pas (onerror avant tout message) : repli en ligne", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const p = runWorkerTask({ ...base, create: mk });
    FakeWorker.last!.onerror?.({ message: "refusé" } as ErrorEvent);
    expect(await p).toBe(2);
  });

  it("Worker qui ne se déclare jamais prêt : repli en ligne après le délai de démarrage", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const p = runWorkerTask({ ...base, create: mk, startTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toBe(2);
    expect(FakeWorker.last!.terminated).toBe(true);
  });

  it("Worker réutilisé : conservé après succès, déjà prêt, terminé après annulation", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    let kept: Worker | null = null;
    const reuse = { get: () => kept, set: (w: Worker | null) => (kept = w) };
    const p1 = runWorkerTask({ ...base, create: mk, reuse });
    const w = FakeWorker.last!;
    w.emit({ type: "ready" });
    w.emit({ type: "result", value: 1 });
    expect(await p1).toBe(1);
    expect(w.terminated).toBe(false);
    expect(kept).toBe(w as unknown as Worker);
    const p2 = runWorkerTask({ ...base, create: mk, reuse });
    expect(w.posted).toHaveLength(2); // pas d'attente de « prêt » la 2e fois
    w.emit({ type: "result", value: 2 });
    expect(await p2).toBe(2);
    const c = new AbortController();
    const p3 = runWorkerTask({ ...base, create: mk, reuse, signal: c.signal });
    c.abort();
    await expect(p3).rejects.toMatchObject({ name: "AbortError" });
    expect(w.terminated).toBe(true);
    expect(kept).toBeNull();
  });
});
