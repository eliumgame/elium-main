/** Filesystem blob storage. Keys are sharded (ab/cd/rest) to keep dirs small. */
import { mkdir, readFile, writeFile, unlink, access } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { BlobStorage } from "./adapter.js";
import { ByteCounter } from "./util.js";

export class FsStorage implements BlobStorage {
  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  private pathFor(key: string): string {
    // Validation STRICTE (au lieu d'un nettoyage silencieux qui faisait collisionner « a/b » et « ab ») :
    // newKey() produit 48 caractères hexadécimaux ; toute autre forme est refusée.
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new Error("Clé de stockage invalide.");
    return join(this.root, key.slice(0, 2), key.slice(2, 4), key);
  }

  newKey(): string {
    return randomBytes(24).toString("hex");
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async putStream(key: string, stream: Readable, maxBytes: number): Promise<number> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    const counter = new ByteCounter(maxBytes);
    try {
      await pipeline(stream, counter, createWriteStream(p));
    } catch (err) {
      await unlink(p).catch(() => {});
      throw err;
    }
    return counter.total;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async getStream(key: string): Promise<Readable> {
    return createReadStream(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch {
      /* already gone */
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}
