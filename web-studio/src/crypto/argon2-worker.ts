/**
 * Argon2id key-derivation Worker.
 *
 * Offloads the CPU-bound Argon2id computation performed by
 * `EliumCryptoEngine.deriveMasterKey` (./elium-crypto.ts) off the main
 * thread — that call is `async` but the WASM computation itself is
 * synchronous CPU work, so without this Worker it blocks rendering and
 * input for its full duration (~1.3s at the current write parameters).
 *
 * This module MUST produce byte-for-byte the same hash as a direct
 * `argon2id(...)` call on the main thread — same library, same inputs, only
 * the execution context differs. `outputType: "binary"` returns the exact
 * same underlying hash bytes as `outputType: "hex"` (hash-wasm's `hex`/
 * `binary`/`encoded` output modes are only different final encodings of the
 * same computed digest — see hash-wasm's `argon2Internal`), so this is
 * equivalent to `fromHex(await argon2id({ ..., outputType: "hex" }))` as
 * used on the main thread.
 *
 * Message protocol (both directions rely on plain structured-clone copies —
 * deliberately NO transfer list: the payloads are tiny — a password, a
 * 16-byte salt, a 32-byte hash — so the copy cost is negligible next to the
 * ~1.3s Argon2 computation, and skipping transfer avoids detaching any
 * buffer the caller might still be holding, e.g. `elium-crypto.ts` reads
 * `salt` again right after awaiting the derivation to write it into the
 * file header):
 *   → { id, password, salt, iterations, memorySize, parallelism, hashLength }
 *   ← { id, hash } on success, or { id, error } on failure.
 */
import { argon2id } from "hash-wasm";

interface Argon2WorkerRequest {
  id: number;
  password: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  memorySize: number;
  parallelism: number;
  hashLength: number;
}

interface Argon2WorkerResponse {
  id: number;
  hash?: Uint8Array;
  error?: string;
}

self.onmessage = async (ev: MessageEvent<Argon2WorkerRequest>) => {
  const { id, password, salt, iterations, memorySize, parallelism, hashLength } = ev.data;
  const response: Argon2WorkerResponse = { id };
  try {
    response.hash = await argon2id({
      password,
      salt,
      iterations,
      memorySize,
      parallelism,
      hashLength,
      outputType: "binary",
    });
  } catch (err) {
    response.error = err instanceof Error ? err.message : String(err);
  }
  self.postMessage(response);
};
