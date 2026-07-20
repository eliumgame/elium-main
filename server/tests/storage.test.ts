/**
 * Blob-storage tests: the shared ByteCounter cap and the S3/MinIO adapter driven
 * against an in-memory bucket (S3Client.send + lib-storage Upload are mocked, so
 * no real S3 endpoint is required — the E2E only ever exercised the `fs` driver).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import { ByteCounter } from "../src/storage/util.js";

const { MOCK_BUCKET } = vi.hoisted(() => ({ MOCK_BUCKET: new Map<string, Buffer>() }));

// Streaming upload: drain the piped Body (the ByteCounter) into the in-memory bucket.
vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    private params: { Key: string; Body: AsyncIterable<Buffer> };
    constructor(opts: { params: { Key: string; Body: AsyncIterable<Buffer> } }) {
      this.params = opts.params;
    }
    async done() {
      const chunks: Buffer[] = [];
      for await (const c of this.params.Body) chunks.push(Buffer.from(c));
      MOCK_BUCKET.set(this.params.Key, Buffer.concat(chunks));
    }
  },
}));

import { S3Client } from "@aws-sdk/client-s3";
import { S3Storage } from "../src/storage/s3.js";

function bodyFor(b: Buffer): Readable {
  const r = Readable.from(b) as Readable & { transformToByteArray?: () => Promise<Uint8Array> };
  r.transformToByteArray = async () => new Uint8Array(b);
  return r;
}

beforeEach(() => {
  MOCK_BUCKET.clear();
  vi.restoreAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async (cmd: any) => {
    const name = cmd.constructor.name;
    const input = cmd.input;
    if (name === "PutObjectCommand") {
      MOCK_BUCKET.set(input.Key, Buffer.from(input.Body));
      return {};
    }
    if (name === "GetObjectCommand") {
      const b = MOCK_BUCKET.get(input.Key);
      if (!b) throw new Error("NoSuchKey");
      return { Body: bodyFor(b) };
    }
    if (name === "DeleteObjectCommand") {
      MOCK_BUCKET.delete(input.Key);
      return {};
    }
    if (name === "HeadObjectCommand") {
      if (!MOCK_BUCKET.has(input.Key)) throw new Error("NotFound");
      return {};
    }
    return {};
  });
});

describe("ByteCounter — shared upload byte-cap", () => {
  it("passes bytes through and tallies the total", async () => {
    const counter = new ByteCounter(100);
    const out: Buffer[] = [];
    counter.on("data", (c: Buffer) => out.push(c));
    await new Promise<void>((res, rej) => {
      counter.on("end", res);
      counter.on("error", rej);
      Readable.from([Buffer.from("abc"), Buffer.from("de")]).pipe(counter);
    });
    expect(Buffer.concat(out).toString()).toBe("abcde");
    expect(counter.total).toBe(5);
  });

  it("aborts when the payload exceeds maxBytes", async () => {
    const counter = new ByteCounter(4);
    counter.resume(); // consume the pass-through side
    const err = await new Promise<Error | null>((res) => {
      counter.on("error", (e: Error) => res(e));
      counter.on("end", () => res(null));
      Readable.from([Buffer.from("abcdef")]).pipe(counter);
    });
    expect(err?.message).toBe("payload_too_large");
  });
});

describe("S3Storage — adapter over an in-memory bucket", () => {
  it("newKey returns a unique 48-char hex key", () => {
    const s = new S3Storage();
    const [k1, k2] = [s.newKey(), s.newKey()];
    expect(k1).toMatch(/^[0-9a-f]{48}$/);
    expect(k1).not.toBe(k2);
  });

  it("put → get → exists → delete round-trip", async () => {
    const s = new S3Storage();
    await s.put("k1", Buffer.from("ciphertext"));
    expect((await s.get("k1")).toString()).toBe("ciphertext");
    expect(await s.exists("k1")).toBe(true);
    await s.delete("k1");
    expect(await s.exists("k1")).toBe(false);
  });

  it("get rejects for a missing key", async () => {
    await expect(new S3Storage().get("nope")).rejects.toThrow();
  });

  it("getStream returns the stored bytes", async () => {
    const s = new S3Storage();
    await s.put("k2", Buffer.from("streamed"));
    const chunks: Buffer[] = [];
    for await (const c of await s.getStream("k2")) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe("streamed");
  });

  it("putStream streams through the counter and returns the byte count", async () => {
    const s = new S3Storage();
    const n = await s.putStream("k3", Readable.from([Buffer.from("hello "), Buffer.from("world")]), 1000);
    expect(n).toBe(11);
    expect((await s.get("k3")).toString()).toBe("hello world");
  });

  it("putStream rejects an over-size payload", async () => {
    const s = new S3Storage();
    await expect(s.putStream("k4", Readable.from([Buffer.from("0123456789")]), 4)).rejects.toThrow();
  });
});

describe("S3Storage.init — bucket bootstrap (parity with fs auto-setup)", () => {
  it("no-ops when the bucket already exists (HeadBucket ok, no create)", async () => {
    // beforeEach's mock returns {} for HeadBucketCommand ⇒ bucket present.
    const spy = vi.spyOn(S3Client.prototype, "send");
    await new S3Storage().init();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmds = spy.mock.calls.map((c: any[]) => c[0].constructor.name);
    expect(cmds).toContain("HeadBucketCommand");
    expect(cmds).not.toContain("CreateBucketCommand");
  });

  it("creates the bucket when missing (HeadBucket fails → CreateBucket)", async () => {
    let created = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (cmd: any) => {
      const name = cmd.constructor.name;
      if (name === "HeadBucketCommand") throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      if (name === "CreateBucketCommand") {
        created = true;
        return {};
      }
      return {};
    });
    await new S3Storage().init();
    expect(created).toBe(true);
  });

  it("treats an already-owned bucket as success (create races)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (cmd: any) => {
      const name = cmd.constructor.name;
      if (name === "HeadBucketCommand") throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      if (name === "CreateBucketCommand") throw Object.assign(new Error("owned"), { name: "BucketAlreadyOwnedByYou" });
      return {};
    });
    await expect(new S3Storage().init()).resolves.toBeUndefined();
  });
});
