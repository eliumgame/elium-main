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
