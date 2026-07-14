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
