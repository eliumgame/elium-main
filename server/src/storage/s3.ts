/**
 * S3 / MinIO blob storage. Works with any S3-compatible endpoint (set
 * S3_ENDPOINT + S3_FORCE_PATH_STYLE=true for MinIO). Stores only ciphertext.
 * Streaming upload uses the multipart Upload helper so multi-GB blobs never
 * buffer in memory.
 */
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { config } from "../config.js";
import type { BlobStorage } from "./adapter.js";
import { ByteCounter } from "./util.js";

export class S3Storage implements BlobStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const s = config.storage.s3;
    this.bucket = s.bucket;
    this.client = new S3Client({
      endpoint: s.endpoint,
      region: s.region,
      forcePathStyle: s.forcePathStyle,
      credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
    });
  }

  newKey(): string {
    return randomBytes(24).toString("hex");
  }

  /**
   * Ensure the bucket exists so an S3/MinIO deployment needs no manual bucket
   * creation (parity with the `fs` driver, which just makes its directory).
   * Best-effort: if HeadBucket says it is already there we do nothing; if it is
   * missing we try to create it; any failure (e.g. an external S3 that forbids
   * CreateBucket but where the bucket already exists) is swallowed by the
   * caller — writes will still work if the bucket is present.
   */
  async init(): Promise<void> {
    // MinIO may still be booting on a fresh `--profile s3` deploy (the api does
    // not depend on it), so tolerate transient connection errors with a few
    // retries. HeadBucket present ⇒ done; otherwise create it. A create that
    // races another node (bucket already exists) is treated as success.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        return; // exists and reachable
      } catch (headErr) {
        try {
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
          return; // created
        } catch (createErr) {
          const name = (createErr as { name?: string })?.name ?? "";
          if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") return;
          lastErr = createErr ?? headErr;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Initialisation du bucket S3 impossible.");
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }

  async putStream(key: string, stream: Readable, maxBytes: number): Promise<number> {
    const counter = new ByteCounter(maxBytes);
    // Forward source errors so an over-size / broken upload aborts cleanly.
    stream.on("error", (err: unknown) => counter.destroy(err as Error));
    stream.pipe(counter);
    const upload = new Upload({ client: this.client, params: { Bucket: this.bucket, Key: key, Body: counter } });
    await upload.done();
    return counter.total;
  }

  async get(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error("Objet vide.");
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async getStream(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error("Objet vide.");
    return out.Body as unknown as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => {});
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}
