/**
 * Exercises EliumCryptoEngine.deriveMasterKey's Worker-DELEGATION logic in
 * src/crypto/elium-crypto.ts — the singleton lifecycle, request/response
 * id-matching, crash → fallback behavior, and concurrent-call isolation.
 * (The Worker's own computation is covered separately by
 * tests/argon2-worker.test.ts; the main-thread fallback's byte-correctness
 * is covered by tests/crypto.test.ts. This file is the only one that ever
 * makes `typeof Worker !== "undefined"` true, so without it the entire
 * Worker branch of deriveMasterKey is dead code as far as the test suite
 * can tell — every other test exercises only the fallback.)
 *
 * `vi.resetModules()` + a fresh dynamic import per test gives each test its
 * own copy of elium-crypto.ts's module-level Worker singleton, so tests
 * don't leak state into each other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface WorkerRequest {
  id: number;
  password: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  memorySize: number;
  parallelism: number;
  hashLength: number;
}

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn((_req: WorkerRequest) => {});
  terminate = vi.fn();
  constructor(
    public url: URL,
    public opts: unknown,
  ) {
    MockWorker.instances.push(this);
  }
  /** Test helper: simulate the worker resolving a given request id. */
  respond(id: number, hash: Uint8Array) {
    this.onmessage?.({ data: { id, hash } });
  }
  respondError(id: number, error: string) {
    this.onmessage?.({ data: { id, error } });
  }
  crash() {
    this.onerror?.();
  }
}

async function freshEngine() {
  vi.resetModules();
  const mod = await import("../src/crypto/elium-crypto");
  return mod.EliumCryptoEngine;
}

const SALT = new Uint8Array(16).fill(5);

beforeEach(() => {
  MockWorker.instances.length = 0;
  (globalThis as { Worker?: unknown }).Worker = MockWorker;
});

afterEach(() => {
  delete (globalThis as { Worker?: unknown }).Worker;
});

describe("deriveMasterKey — Worker delegation", () => {
  it("constructs one Worker, posts the request, and resolves with the message's hash", async () => {
    const Engine = await freshEngine();
    const fakeHash = new Uint8Array(32).fill(9);
    const promise = Engine.deriveMasterKey("pw", SALT, 2, 8192, 1);

    expect(MockWorker.instances).toHaveLength(1);
    const worker = MockWorker.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const req = worker.postMessage.mock.calls[0]![0] as WorkerRequest;
    expect(req.iterations).toBe(2);
    expect(req.memorySize).toBe(8192);
    expect(req.salt).toBe(SALT); // same salt instance — never mutated/detached (no transfer list)

    worker.respond(req.id, fakeHash);
    await expect(promise).resolves.toEqual(fakeHash);
  });

  it("reuses the same Worker singleton across multiple derivations", async () => {
    const Engine = await freshEngine();
    const p1 = Engine.deriveMasterKey("pw1", SALT, 2, 8192, 1);
    MockWorker.instances[0]!.respond(MockWorker.instances[0]!.postMessage.mock.calls[0]![0].id, new Uint8Array(32));
    await p1;

    const p2 = Engine.deriveMasterKey("pw2", SALT, 2, 8192, 1);
    expect(MockWorker.instances).toHaveLength(1); // still just one Worker constructed
    MockWorker.instances[0]!.respond(MockWorker.instances[0]!.postMessage.mock.calls[1]![0].id, new Uint8Array(32));
    await p2;
  });

  it("keeps two concurrent requests isolated by id — no cross-resolution", async () => {
    const Engine = await freshEngine();
    const hashA = new Uint8Array(32).fill(1);
    const hashB = new Uint8Array(32).fill(2);

    const pA = Engine.deriveMasterKey("pwA", SALT, 2, 8192, 1);
    const pB = Engine.deriveMasterKey("pwB", SALT, 2, 8192, 1);
    const worker = MockWorker.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    const [reqA, reqB] = worker.postMessage.mock.calls.map((c) => c[0] as WorkerRequest);
    expect(reqA.id).not.toBe(reqB.id);

    // Resolve out of order (B first) — each caller must still get ITS OWN hash.
    worker.respond(reqB.id, hashB);
    worker.respond(reqA.id, hashA);
    await expect(pA).resolves.toEqual(hashA);
    await expect(pB).resolves.toEqual(hashB);
  });

  it("falls back to the direct main-thread computation when the Worker crashes", async () => {
    const Engine = await freshEngine();
    const promise = Engine.deriveMasterKey("pw", SALT, 2, 8192, 1);
    const worker = MockWorker.instances[0]!;

    worker.crash(); // onerror fires before any response — simulates a Worker that never starts

    // Must NOT reject: falls through to the real argon2id() call on the main thread.
    const result = await promise;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
    expect(worker.terminate).toHaveBeenCalled(); // the dead singleton is torn down
  });

  it("recreates a fresh Worker after a crash instead of hanging on the dead one", async () => {
    const Engine = await freshEngine();
    const p1 = Engine.deriveMasterKey("pw1", SALT, 2, 8192, 1);
    MockWorker.instances[0]!.crash();
    await p1; // falls back, as above

    const p2 = Engine.deriveMasterKey("pw2", SALT, 2, 8192, 1);
    expect(MockWorker.instances).toHaveLength(2); // a NEW Worker was constructed, not reused
    MockWorker.instances[1]!.respond(MockWorker.instances[1]!.postMessage.mock.calls[0]![0].id, new Uint8Array(32));
    await expect(p2).resolves.toBeInstanceOf(Uint8Array);
  });

  it("falls back when the worker posts back an explicit {id, error}", async () => {
    const Engine = await freshEngine();
    const promise = Engine.deriveMasterKey("pw", SALT, 2, 8192, 1);
    const worker = MockWorker.instances[0]!;
    const req = worker.postMessage.mock.calls[0]![0] as WorkerRequest;
    worker.respondError(req.id, "boom");

    const result = await promise; // still resolves — fallback, not a rejection
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });
});
