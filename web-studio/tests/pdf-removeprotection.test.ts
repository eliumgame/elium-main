import { describe, it, expect } from "vitest";
import { PDFDocument, PDFInvalidObject, PDFHexString } from "pdf-lib";
import { md5 } from "@noble/hashes/legacy.js";
import {
  removeProtection,
  rc4,
  WrongPassword,
  UnsupportedEncryptedObjectStreams,
  ALL_PERMISSIONS,
  permissionsToP,
} from "../src/pdf/ops/security";

/**
 * The tests below build a *real* encrypted PDF whose page tree, fonts, etc.
 * are packed into a compressed object stream (`/Type /ObjStm`) — exactly
 * what pdf-lib itself produces by default, and exactly what tools like
 * Acrobat routinely write for encrypted files. That combination is what
 * `removeProtection` in `../src/pdf/ops/security.ts` used to mishandle: since
 * pdf-lib's own parser decompresses an object stream *while parsing*, before
 * any decryption has happened, the still-encrypted bytes fail to inflate,
 * the failure is swallowed, and every object packed inside silently vanishes.
 *
 * The RC4 (V1/R2, 40-bit) key-derivation algorithm below is a small,
 * self-contained mirror of the one implemented in security.ts, used here
 * only to *construct* the synthetic fixture — security.ts intentionally
 * doesn't export those internal primitives, and `protectDocument()` (the
 * module's own encryption path) never emits object streams in the first
 * place, so a fixture exercising this bug has to be built by hand.
 */

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function pad32(password: string): Uint8Array {
  const raw = new TextEncoder().encode(password);
  const out = new Uint8Array(32);
  const take = Math.min(32, raw.length);
  out.set(raw.subarray(0, take), 0);
  out.set(PAD.subarray(0, 32 - take), take);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return s;
}

/** Algorithm 1 (revision 2, non-AES): the per-object RC4 key. */
function objectKey(fileKey: Uint8Array, objectNumber: number, generationNumber: number): Uint8Array {
  const extra = new Uint8Array(5);
  extra[0] = objectNumber & 0xff;
  extra[1] = (objectNumber >> 8) & 0xff;
  extra[2] = (objectNumber >> 16) & 0xff;
  extra[3] = generationNumber & 0xff;
  extra[4] = (generationNumber >> 8) & 0xff;
  const digest = md5(concatBytes(fileKey, extra));
  return digest.subarray(0, Math.min(fileKey.length + 5, 16));
}

/**
 * Build a small two-page PDF, declare it RC4-40 (V1/R2) encrypted, then
 * actually RC4-encrypt every top-level stream on disk (content streams and
 * the compressed object stream pdf-lib packs the page tree/fonts into) —
 * faithfully reproducing an encrypted, object-stream-using PDF.
 */
async function buildEncryptedFixture(opts: {
  userPassword: string;
  ownerPassword?: string;
  corruptObjStm?: boolean;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page1 = doc.addPage([200, 200]);
  page1.drawText("Hello world", { x: 20, y: 100 });
  const page2 = doc.addPage([200, 200]);
  page2.drawText("Second page", { x: 20, y: 100 });
  await doc.flush();

  const userPw = opts.userPassword;
  const ownerPw = opts.ownerPassword ?? opts.userPassword;
  const id0 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) id0[i] = i + 1;
  const p = permissionsToP(ALL_PERMISSIONS);

  const ownerKey = md5(pad32(ownerPw)).subarray(0, 5);
  const O = rc4(ownerKey, pad32(userPw));

  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, p, true);
  const fileKey = md5(concatBytes(pad32(userPw), O, pBytes, id0)).subarray(0, 5);
  const U = rc4(fileKey, PAD);

  const ctx = doc.context;
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(toHex(id0)), PDFHexString.of(toHex(id0))]);
  const encryptDict = ctx.obj({
    Filter: "Standard",
    V: 1,
    R: 2,
    O: PDFHexString.of(toHex(O)),
    U: PDFHexString.of(toHex(U)),
    P: p,
  });
  const encryptRef = ctx.register(encryptDict);
  ctx.trailerInfo.Encrypt = encryptRef;

  // At this point pdf-lib has no idea any of this means "encrypt the bytes"
  // — it just serializes the document normally, with a /Encrypt dict that
  // happens to be present. We now go through the raw output and actually
  // RC4-encrypt every top-level stream in place (RC4 doesn't change length,
  // so no offsets need to move).
  const out = await doc.save();
  const text = bytesToLatin1(out);
  const objRe = /(\d+)[ \t]+(\d+)[ \t]+obj/g;
  let m: RegExpExecArray | null;
  let sawObjStm = false;
  while ((m = objRe.exec(text))) {
    const objNum = parseInt(m[1], 10);
    const genNum = parseInt(m[2], 10);
    const objStart = m.index;
    const endobjIdx = text.indexOf("endobj", objStart);
    const streamIdx = text.indexOf("stream", objStart);
    if (streamIdx === -1 || (endobjIdx !== -1 && streamIdx > endobjIdx)) continue; // no stream here
    const dictText = text.slice(objStart, streamIdx);
    if (/\/Type\s*\/XRef\b/.test(dictText)) continue; // cross-reference streams are never encrypted
    let contentStart = streamIdx + "stream".length;
    if (out[contentStart] === 0x0d && out[contentStart + 1] === 0x0a) contentStart += 2;
    else if (out[contentStart] === 0x0a || out[contentStart] === 0x0d) contentStart += 1;
    const lengthMatch = /\/Length\s+(\d+)/.exec(dictText);
    if (!lengthMatch) continue;
    const contentEnd = contentStart + parseInt(lengthMatch[1], 10);
    const key = objectKey(fileKey, objNum, genNum);
    const region = out.subarray(contentStart, contentEnd);
    out.set(rc4(key, region), contentStart);
    if (/\/Type\s*\/ObjStm\b/.test(dictText)) {
      sawObjStm = true;
      if (opts.corruptObjStm) {
        // Flip a byte in the middle of the now-encrypted ciphertext: even
        // with the right file key, decryption then yields bytes that will
        // not parse as a valid object stream.
        const mid = contentStart + Math.floor((contentEnd - contentStart) / 2);
        out[mid] ^= 0xff;
      }
    }
  }

  if (!sawObjStm) throw new Error("test setup: fixture has no object stream — it wouldn't exercise the bug");
  return out;
}

describe("removeProtection — encrypted compressed object streams", () => {
  it("sanity check: the fixture reproduces pdf-lib's own object-stream data loss", async () => {
    const bytes = await buildEncryptedFixture({ userPassword: "secret" });
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    const invalid = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFInvalidObject);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it("recovers every object from an encrypted object stream instead of silently dropping them", async () => {
    const bytes = await buildEncryptedFixture({ userPassword: "secret" });
    const result = await removeProtection(bytes, "secret");
    expect(result.scheme).toBe("RC4-40");

    const clean = await PDFDocument.load(result.bytes);
    const stillInvalid = clean.context.enumerateIndirectObjects().some(([, o]) => o instanceof PDFInvalidObject);
    expect(stillInvalid).toBe(false);
    expect(clean.getPageCount()).toBe(2);
    expect(clean.getPage(0).getSize()).toEqual({ width: 200, height: 200 });
    expect(clean.getPage(1).getSize()).toEqual({ width: 200, height: 200 });
  });

  it("still rejects a wrong password before attempting any repair", async () => {
    const bytes = await buildEncryptedFixture({ userPassword: "secret" });
    await expect(removeProtection(bytes, "nope")).rejects.toBeInstanceOf(WrongPassword);
  });

  it("fails loudly instead of returning a corrupted document when the object stream can't be reconstructed", async () => {
    const bytes = await buildEncryptedFixture({ userPassword: "secret", corruptObjStm: true });
    await expect(removeProtection(bytes, "secret")).rejects.toBeInstanceOf(UnsupportedEncryptedObjectStreams);
  });
});
