/**
 * Blob storage abstraction. Blobs are ALWAYS AES-256-GCM ciphertext produced by
 * the client — this layer never sees plaintext. Two drivers: `fs` (a
 * LUKS-encrypted volume in prod) and `s3` (MinIO / S3-compatible). Streaming
 * put/get avoid buffering multi-GB blobs in memory.
 */
import type { Readable } from "node:stream";
import { config } from "../config.js";
import { FsStorage } from "./fs.js";
import { S3Storage } from "./s3.js";

export interface BlobStorage {
  /**
   * Prepare the backend so blobs can be written with zero manual setup — the
   * `fs` driver creates its root dir, the `s3` driver ensures its bucket
   * exists. Best-effort and idempotent: called once at startup, failures are
   * logged and never crash the server (a locked-down external S3 may forbid
   * bucket creation but already have the bucket).
   */
  init?(): Promise<void>;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Stream bytes in; returns the number of bytes written. Enforces `maxBytes`. */
  putStream(key: string, stream: Readable, maxBytes: number): Promise<number>;
  /** Stream bytes out (for download). */
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Generate a fresh, unguessable, shard-friendly storage key. */
  newKey(): string;
}

let instance: BlobStorage | null = null;

export function storage(): BlobStorage {
  if (instance) return instance;
  instance = config.storage.driver === "s3" ? new S3Storage() : new FsStorage(config.storage.fsRoot);
  return instance;
}
