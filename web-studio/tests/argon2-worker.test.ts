/**
 * Exercises src/crypto/argon2-worker.ts's ACTUAL message-in/message-out
 * contract — this module runs only inside a real Worker context in
 * production, and the default Vitest (Node) environment has no `Worker`
 * global, so EliumCryptoEngine.deriveMasterKey always takes the main-thread
 * fallback in every other test file. Without this file, the worker's own
 * logic (self.onmessage wiring, error propagation) is never actually run by
 * the test suite.
 *
 * Approach: stub a minimal `self` (the module assigns `self.onmessage` and
 * calls `self.postMessage` at the top level — both exist on a real
 * DedicatedWorkerGlobalScope), import the module for its side effect, then
 * drive `self.onmessage` directly with fake MessageEvents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { argon2id } from "hash-wasm";

type Argon2WorkerRequest = {
  id: number;
  password: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  memorySize: number;
  parallelism: number;
  hashLength: number;
};
type Argon2WorkerResponse = { id: number; hash?: Uint8Array; error?: string };

let postMessage: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  postMessage = vi.fn();
  (globalThis as { self?: unknown }).self = { postMessage };
  vi.resetModules();
  // Side effect: sets self.onmessage.
  await import("../src/crypto/argon2-worker");
});

afterEach(() => {
  delete (globalThis as { self?: unknown }).self;
});

function selfOnMessage(): (ev: { data: Argon2WorkerRequest }) => unknown {
  const s = (globalThis as { self: { onmessage?: unknown } }).self;
  const handler = s.onmessage as ((ev: { data: Argon2WorkerRequest }) => unknown) | undefined;
  if (!handler) throw new Error("argon2-worker did not install self.onmessage");
  return handler;
}

describe("argon2-worker self.onmessage", () => {
  it("responds with {id, hash} matching a direct argon2id call with the same params", async () => {
    const request: Argon2WorkerRequest = {
      id: 7,
      password: new TextEncoder().encode("correct horse battery staple"),
      salt: new Uint8Array(16).fill(3),
      iterations: 2,
      memorySize: 8192, // small on purpose — fast, still exercises the real path
      parallelism: 1,
      hashLength: 32,
    };
    await selfOnMessage()({ data: request });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const response = postMessage.mock.calls[0]![0] as Argon2WorkerResponse;
    expect(response.id).toBe(7);
    expect(response.error).toBeUndefined();
    expect(response.hash).toBeInstanceOf(Uint8Array);

    const expected = await argon2id({
      password: request.password,
      salt: request.salt,
      iterations: request.iterations,
      memorySize: request.memorySize,
      parallelism: request.parallelism,
      hashLength: request.hashLength,
      outputType: "binary",
    });
    expect(response.hash).toEqual(expected);
  });

  it("posts back {id, error} instead of throwing when argon2id rejects", async () => {
    const request: Argon2WorkerRequest = {
      id: 9,
      password: new TextEncoder().encode("x"),
      salt: new Uint8Array(16),
      iterations: 2,
      memorySize: 8192,
      parallelism: 1,
      hashLength: -1, // invalid: forces hash-wasm to reject
    };
    await selfOnMessage()({ data: request });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const response = postMessage.mock.calls[0]![0] as Argon2WorkerResponse;
    expect(response.id).toBe(9);
    expect(response.hash).toBeUndefined();
    expect(typeof response.error).toBe("string");
    expect(response.error!.length).toBeGreaterThan(0);
  });

  it("keeps requests independent — a second message with a different id gets its own response", async () => {
    const base = {
      password: new TextEncoder().encode("p"),
      salt: new Uint8Array(16).fill(1),
      iterations: 2,
      memorySize: 8192,
      parallelism: 1,
      hashLength: 32,
    };
    const handler = selfOnMessage();
    await handler({ data: { id: 1, ...base } });
    await handler({ data: { id: 2, ...base, salt: new Uint8Array(16).fill(2) } });

    expect(postMessage).toHaveBeenCalledTimes(2);
    const r1 = postMessage.mock.calls[0]![0] as Argon2WorkerResponse;
    const r2 = postMessage.mock.calls[1]![0] as Argon2WorkerResponse;
    expect(r1.id).toBe(1);
    expect(r2.id).toBe(2);
    // Different salts must not collide on the same hash.
    expect(r1.hash).not.toEqual(r2.hash);
  });
});
