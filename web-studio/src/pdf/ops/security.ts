/**
 * The PDF standard security handler: opening protected files, and protecting
 * files with a password.
 *
 * Encryption uses **AES-256 (V5 / R6)** — the revision Acrobat X and later
 * write, and the only one still worth offering. Decryption additionally
 * understands the legacy revisions (RC4 40/128 bit, AES-128) so documents other
 * people protected can be opened and worked on.
 *
 * Everything here operates on a pdf-lib `PDFContext`: strings and stream
 * payloads are the only encrypted parts of a PDF, so walking every indirect
 * object and transforming those two is the whole job.
 */

import { cbc, ecb } from "@noble/ciphers/aes.js";
import { md5 } from "@noble/hashes/legacy.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFInvalidObject,
  PDFName,
  PDFNumber,
  PDFObjectStreamParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import type { PDFDocument, PDFObject } from "pdf-lib";

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** The `/P` permission bits users care about (bit 1 is the lowest). */
export interface Permissions {
  print: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
  fillForms: boolean;
  extractForAccessibility: boolean;
  assemble: boolean;
  printHighRes: boolean;
}

export const ALL_PERMISSIONS: Permissions = {
  print: true,
  modify: true,
  copy: true,
  annotate: true,
  fillForms: true,
  extractForAccessibility: true,
  assemble: true,
  printHighRes: true,
};

const BIT = {
  print: 1 << 2,
  modify: 1 << 3,
  copy: 1 << 4,
  annotate: 1 << 5,
  fillForms: 1 << 8,
  extractForAccessibility: 1 << 9,
  assemble: 1 << 10,
  printHighRes: 1 << 11,
} as const;

export function permissionsToP(p: Permissions): number {
  // ISO 32000 table 22: bits 1-2 shall be 0, bits 7-8 and 13-32 shall be 1;
  // then the permission bits that are granted.
  let v = 0xfffff0c0;
  for (const [key, bit] of Object.entries(BIT)) if (p[key as keyof Permissions]) v |= bit;
  return v | 0;
}

export function pToPermissions(p: number): Permissions {
  const out = {} as Permissions;
  for (const [key, bit] of Object.entries(BIT)) out[key as keyof Permissions] = (p & bit) !== 0;
  return out;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Latin-1 bytes of a password, as revisions 2–4 require. */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Password padded/truncated to the 32 bytes revisions 2–4 hash. */
function padPassword(password: string): Uint8Array {
  const raw = latin1Bytes(password);
  const out = new Uint8Array(32);
  const take = Math.min(32, raw.length);
  out.set(raw.subarray(0, take), 0);
  out.set(PAD.subarray(0, 32 - take), take);
  return out;
}

/** RC4 — needed only to read legacy files. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const ZERO_IV = new Uint8Array(16);

function aesCbcNoPadEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  return cbc(key, iv, { disablePadding: true }).encrypt(data);
}

function aesCbcNoPadDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  return cbc(key, iv, { disablePadding: true }).decrypt(data);
}

/** AES-CBC with a random IV prefix and PKCS#7 padding — the PDF stream format. */
function aesEncryptWithIv(key: Uint8Array, data: Uint8Array): Uint8Array {
  const iv = randomBytes(16);
  return concatBytes(iv, cbc(key, iv).encrypt(data));
}

function aesDecryptWithIv(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length <= 16) return new Uint8Array(0);
  const iv = data.subarray(0, 16);
  const body = data.subarray(16);
  // Some producers omit the final padding block; fall back to raw CBC.
  try {
    return cbc(key, iv).decrypt(body.subarray(0, body.length - (body.length % 16)));
  } catch {
    try {
      return aesCbcNoPadDecrypt(key, iv, body.subarray(0, body.length - (body.length % 16)));
    } catch {
      return new Uint8Array(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/** ISO 32000-2 algorithm 2.B — the iterated hash used by revision 6. */
function hash2B(password: Uint8Array, salt: Uint8Array, userData: Uint8Array): Uint8Array {
  let k: Uint8Array = sha256(concatBytes(password, salt, userData));
  for (let round = 0; ; round++) {
    const block = concatBytes(password, k, userData);
    const k1 = new Uint8Array(block.length * 64);
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length);
    const e = aesCbcNoPadEncrypt(k.subarray(0, 16), k.subarray(16, 32), k1);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    const mod = sum % 3;
    k = mod === 0 ? sha256(e) : mod === 1 ? sha384(e) : sha512(e);
    if (round >= 63 && e[e.length - 1] <= round - 31) break;
  }
  return k.subarray(0, 32);
}

/** Algorithm 2 — the file key for revisions 2 to 4. */
function legacyFileKey(
  password: string,
  o: Uint8Array,
  p: number,
  id0: Uint8Array,
  revision: number,
  lengthBytes: number,
  encryptMetadata: boolean,
): Uint8Array {
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, p, true);
  const parts = [padPassword(password), o.subarray(0, 32), pBytes, id0];
  if (revision >= 4 && !encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  let key: Uint8Array = md5(concatBytes(...parts));
  const n = revision === 2 ? 5 : lengthBytes;
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
  }
  return key.subarray(0, n);
}

/** Per-object key for revisions 2 to 4 (algorithm 1). */
function objectKey(fileKey: Uint8Array, ref: PDFRef, aes: boolean): Uint8Array {
  const extra = new Uint8Array(aes ? 9 : 5);
  extra[0] = ref.objectNumber & 0xff;
  extra[1] = (ref.objectNumber >> 8) & 0xff;
  extra[2] = (ref.objectNumber >> 16) & 0xff;
  extra[3] = ref.generationNumber & 0xff;
  extra[4] = (ref.generationNumber >> 8) & 0xff;
  if (aes) extra.set([0x73, 0x41, 0x6c, 0x54], 5);
  const digest = md5(concatBytes(fileKey, extra));
  return digest.subarray(0, Math.min(fileKey.length + 5, 16));
}

// ---------------------------------------------------------------------------
// Reading an /Encrypt dictionary
// ---------------------------------------------------------------------------

type Cfm = "None" | "V2" | "AESV2" | "AESV3";

interface EncryptInfo {
  v: number;
  r: number;
  lengthBytes: number;
  o: Uint8Array;
  u: Uint8Array;
  oe: Uint8Array | null;
  ue: Uint8Array | null;
  p: number;
  encryptMetadata: boolean;
  streamCfm: Cfm;
  stringCfm: Cfm;
}

function bytesOfString(v: PDFObject | undefined): Uint8Array {
  if (v instanceof PDFHexString) {
    const hex = v.asBytes();
    return hex;
  }
  if (v instanceof PDFString) return latin1Bytes(v.asString());
  return new Uint8Array(0);
}

function readEncryptDict(doc: PDFDocument): { info: EncryptInfo; id0: Uint8Array } | null {
  const encryptRef = doc.context.trailerInfo.Encrypt;
  if (!encryptRef) return null;
  const dict = doc.context.lookup(encryptRef);
  if (!(dict instanceof PDFDict)) return null;

  const num = (k: string, fallback: number) => {
    const v = dict.lookup(PDFName.of(k));
    return v instanceof PDFNumber ? v.asNumber() : fallback;
  };
  const v = num("V", 0);
  const r = num("R", v >= 5 ? 6 : 2);
  const lengthBits = num("Length", 40);
  const emRaw = dict.lookup(PDFName.of("EncryptMetadata"));
  const encryptMetadata = emRaw === undefined ? true : String(emRaw) !== "false";

  let streamCfm: Cfm = v >= 4 ? "None" : "V2";
  let stringCfm: Cfm = v >= 4 ? "None" : "V2";
  if (v >= 4) {
    const cf = dict.lookup(PDFName.of("CF"));
    const readFilter = (nameKey: string): Cfm => {
      const fname = dict.lookup(PDFName.of(nameKey));
      const filterName = fname instanceof PDFName ? fname.asString().replace(/^\//, "") : "Identity";
      if (filterName === "Identity") return "None";
      if (!(cf instanceof PDFDict)) return "None";
      const entry = cf.lookup(PDFName.of(filterName));
      if (!(entry instanceof PDFDict)) return "None";
      const cfm = entry.lookup(PDFName.of("CFM"));
      const method = cfm instanceof PDFName ? cfm.asString().replace(/^\//, "") : "None";
      return (["V2", "AESV2", "AESV3", "None"] as const).includes(method as Cfm) ? (method as Cfm) : "None";
    };
    streamCfm = readFilter("StmF");
    stringCfm = readFilter("StrF");
  }

  const idArr = doc.context.trailerInfo.ID;
  let id0: Uint8Array = new Uint8Array(0);
  if (idArr instanceof PDFArray && idArr.size() > 0) id0 = bytesOfString(idArr.lookup(0));

  return {
    id0,
    info: {
      v,
      r,
      lengthBytes: Math.max(5, Math.floor(lengthBits / 8)),
      o: bytesOfString(dict.lookup(PDFName.of("O"))),
      u: bytesOfString(dict.lookup(PDFName.of("U"))),
      oe: dict.lookup(PDFName.of("OE")) ? bytesOfString(dict.lookup(PDFName.of("OE"))) : null,
      ue: dict.lookup(PDFName.of("UE")) ? bytesOfString(dict.lookup(PDFName.of("UE"))) : null,
      p: num("P", -1) | 0,
      encryptMetadata,
      streamCfm,
      stringCfm,
    },
  };
}

/**
 * An AES-256 password as ISO 32000-2 wants it: SASLprep'd (approximated by
 * NFKC — the same accented password typed on two systems, composed or not,
 * gives the same bytes), UTF-8, 127 bytes at most.
 */
function r6Password(password: string | undefined): Uint8Array {
  return utf8Bytes((password ?? "").normalize("NFKC")).subarray(0, 127);
}

/** Recover the file key from a user or owner password, or null if neither fits. */
function deriveFileKey(info: EncryptInfo, id0: Uint8Array, password: string): Uint8Array | null {
  const role = passwordRole(info, id0, password);
  return role ? role.key : null;
}

/** The file key, and whether `password` is the owner's (full rights) or the user's. */
function passwordRole(
  info: EncryptInfo,
  id0: Uint8Array,
  password: string,
): { key: Uint8Array; owner: boolean } | null {
  if (info.v >= 5) {
    // The normalised form first; the raw one for files written before normalisation.
    for (const pw of [r6Password(password), utf8Bytes(password).subarray(0, 127)]) {
      const hit = r6Role(info, pw);
      if (hit) return hit;
    }
    return null;
  }
  // Latin-1 wants composed accents (« é » as one character): the NFC form
  // first, then the password as typed.
  const forms = [...new Set([password.normalize("NFC"), password])];
  for (const pw of forms) {
    const asOwner = legacyOwnerKey(info, id0, pw);
    if (asOwner) return { key: asOwner, owner: true };
  }
  for (const pw of forms) {
    const asUser = legacyFileKey(pw, info.o, info.p, id0, info.r, info.lengthBytes, info.encryptMetadata);
    if (checkLegacyUser(asUser, info, id0)) return { key: asUser, owner: false };
  }
  return null;
}

function r6Role(info: EncryptInfo, pw: Uint8Array): { key: Uint8Array; owner: boolean } | null {
  {
    const uValidation = info.u.subarray(32, 40);
    const uKeySalt = info.u.subarray(40, 48);
    // Owner first: a password that is both is the owner's.
    const u48 = info.u.subarray(0, 48);
    const oValidation = info.o.subarray(32, 40);
    const oKeySalt = info.o.subarray(40, 48);
    const ownerHash = info.r === 5 ? sha256(concatBytes(pw, oValidation, u48)) : hash2B(pw, oValidation, u48);
    if (equal(ownerHash, info.o.subarray(0, 32)) && info.oe) {
      const ik = info.r === 5 ? sha256(concatBytes(pw, oKeySalt, u48)) : hash2B(pw, oKeySalt, u48);
      return { key: aesCbcNoPadDecrypt(ik, ZERO_IV, info.oe.subarray(0, 32)), owner: true };
    }
    const userHash = info.r === 5 ? sha256(concatBytes(pw, uValidation)) : hash2B(pw, uValidation, new Uint8Array(0));
    if (equal(userHash, info.u.subarray(0, 32)) && info.ue) {
      const ik = info.r === 5 ? sha256(concatBytes(pw, uKeySalt)) : hash2B(pw, uKeySalt, new Uint8Array(0));
      return { key: aesCbcNoPadDecrypt(ik, ZERO_IV, info.ue.subarray(0, 32)), owner: false };
    }
    return null;
  }
}

/** Revisions 2–4, owner path: decrypt /O to recover the user password, then redo algorithm 2. */
function legacyOwnerKey(info: EncryptInfo, id0: Uint8Array, password: string): Uint8Array | null {
  let ownerKey: Uint8Array = md5(padPassword(password));
  if (info.r >= 3) for (let i = 0; i < 50; i++) ownerKey = md5(ownerKey);
  const n = info.r === 2 ? 5 : info.lengthBytes;
  const rcKey = ownerKey.subarray(0, n);
  let userPad: Uint8Array = info.o.subarray(0, 32);
  if (info.r === 2) {
    userPad = rc4(rcKey, userPad);
  } else {
    for (let i = 19; i >= 0; i--) {
      const k = new Uint8Array(rcKey.length);
      for (let j = 0; j < rcKey.length; j++) k[j] = rcKey[j] ^ i;
      userPad = rc4(k, userPad);
    }
  }
  let recovered = "";
  for (let i = 0; i < userPad.length; i++) recovered += String.fromCharCode(userPad[i]);
  const padIndex = indexOfPad(userPad);
  const asOwner = legacyFileKey(
    recovered.slice(0, padIndex < 0 ? 32 : padIndex),
    info.o,
    info.p,
    id0,
    info.r,
    info.lengthBytes,
    info.encryptMetadata,
  );
  return checkLegacyUser(asOwner, info, id0) ? asOwner : null;
}

function indexOfPad(padded: Uint8Array): number {
  outer: for (let i = 0; i <= 32 - 4; i++) {
    for (let k = 0; k < Math.min(8, 32 - i); k++) if (padded[i + k] !== PAD[k]) continue outer;
    return i;
  }
  return -1;
}

/** Algorithms 4/5 — does this key reproduce the stored `/U`? */
function checkLegacyUser(key: Uint8Array, info: EncryptInfo, id0: Uint8Array): boolean {
  if (info.r === 2) return equal(rc4(key, PAD), info.u.subarray(0, 32));
  const digest = md5(concatBytes(PAD, id0));
  let data: Uint8Array = rc4(key, digest);
  for (let i = 1; i <= 19; i++) {
    const k = new Uint8Array(key.length);
    for (let j = 0; j < key.length; j++) k[j] = key[j] ^ i;
    data = rc4(k, data);
  }
  return equal(data.subarray(0, 16), info.u.subarray(0, 16));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Walking the context
// ---------------------------------------------------------------------------

type Transform = (data: Uint8Array, ref: PDFRef) => Uint8Array;

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

// ---------------------------------------------------------------------------
// Repairing object streams that pdf-lib's own parser lost
// ---------------------------------------------------------------------------
//
// pdf-lib's parser decompresses any `/Type /ObjStm` (a compressed object
// stream — dictionaries and other non-stream objects packed together and
// Flate-encoded) *while parsing*, long before this module gets a chance to
// decrypt anything. When the file is encrypted, that stream is still
// ciphertext at that point, so decompression throws; pdf-lib swallows the
// error (we load with `throwOnInvalidObject: false`) and just records the
// object stream as a `PDFInvalidObject` — silently dropping every object that
// was packed inside it. A page, font, or annotation dictionary that lived in
// that object stream simply vanishes, with no error surfaced anywhere.
//
// Fixing this without patching pdf-lib itself: the raw bytes pdf-lib kept for
// each `PDFInvalidObject` are the verbatim slice of the file it failed to
// parse (dict + `stream` + ciphertext + `endstream`). We find the ones that
// are actually object streams, decrypt their ciphertext ourselves with the
// same per-object key/transform used for every other stream, and hand the
// result to pdf-lib's own `PDFObjectStreamParser` — the exact code path a
// normal, unencrypted object stream goes through — so the objects it contains
// are assigned into the context just as if pdf-lib had parsed them correctly
// the first time.
//
// Per ISO 32000-2 §7.6.2, strings nested inside an object stream are *not*
// separately encrypted (the container stream already is), so every object we
// recover this way is added to `plaintextRefs` and must be excluded from the
// generic string-decryption walk below.
//
// If a candidate can't be confidently reconstructed (fields we need are
// missing, or the "decrypted" bytes still don't parse), we do not guess: the
// whole operation fails loudly instead of returning an incomplete document.

function findAscii(hay: Uint8Array, needle: string, from = 0): number {
  const n = needle.length;
  outer: for (let i = from; i <= hay.length - n; i++) {
    for (let j = 0; j < n; j++) if (hay[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOfAscii(hay: Uint8Array, needle: string): number {
  const n = needle.length;
  outer: for (let i = hay.length - n; i >= 0; i--) {
    for (let j = 0; j < n; j++) if (hay[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** Thrown when a file has encrypted compressed object streams we can't safely reconstruct. */
export class UnsupportedEncryptedObjectStreams extends Error {
  constructor() {
    super(
      "Ce PDF utilise des flux d'objets compressés chiffrés que la suppression de protection ne sait pas encore traiter correctement — le fichier de sortie serait incomplet.",
    );
    this.name = "UnsupportedEncryptedObjectStreams";
  }
}

/**
 * Attempt to reconstruct one encrypted `/ObjStm` that pdf-lib's parser dropped.
 * Returns the object numbers it recovered, or `null` if it could not safely do so.
 */
async function repairOneObjectStream(
  doc: PDFDocument,
  ref: PDFRef,
  raw: Uint8Array,
  streamX: Transform,
): Promise<string[] | null> {
  const streamKw = findAscii(raw, "stream");
  if (streamKw === -1) return null;
  const dictText = String.fromCharCode(...raw.subarray(0, streamKw));

  let contentStart = streamKw + "stream".length;
  if (raw[contentStart] === 0x0d && raw[contentStart + 1] === 0x0a) contentStart += 2;
  else if (raw[contentStart] === 0x0a || raw[contentStart] === 0x0d) contentStart += 1;

  const endKw = lastIndexOfAscii(raw, "endstream");
  if (endKw === -1 || endKw < contentStart) return null;

  const nMatch = /\/N\s+(\d+)/.exec(dictText);
  const firstMatch = /\/First\s+(\d+)/.exec(dictText);
  if (!nMatch || !firstMatch) return null;
  const filterMatch = /\/Filter\s*\/(\w+)/.exec(dictText);
  const lengthMatch = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/.exec(dictText);

  let contentEnd = endKw;
  let declared: number | null = null;
  if (lengthMatch) {
    if (lengthMatch[2] !== undefined) {
      const resolved = doc.context.lookup(PDFRef.of(parseInt(lengthMatch[1], 10), parseInt(lengthMatch[2], 10)));
      if (resolved instanceof PDFNumber) declared = resolved.asNumber();
    } else {
      declared = parseInt(lengthMatch[1], 10);
    }
  }
  if (declared !== null) {
    const candidateEnd = contentStart + declared;
    if (candidateEnd >= contentStart && candidateEnd <= endKw) contentEnd = candidateEnd;
  }
  if (contentEnd === endKw) {
    // No trustworthy declared length: fall back to the literal `endstream`
    // marker, trimming a possible separator EOL that isn't part of the data.
    while (contentEnd > contentStart && (raw[contentEnd - 1] === 0x0a || raw[contentEnd - 1] === 0x0d)) contentEnd--;
  }

  const ciphertext = raw.subarray(contentStart, contentEnd);
  if (ciphertext.length === 0) return null;
  const plaintext = streamX(ciphertext, ref);

  const ctx = doc.context;
  const before = new Set(ctx.enumerateIndirectObjects().map(([r]) => String(r)));
  const fixedDict: PDFDict = ctx.obj({
    Type: "ObjStm",
    N: parseInt(nMatch[1], 10),
    First: parseInt(firstMatch[1], 10),
    Filter: filterMatch ? filterMatch[1] : undefined,
    Length: plaintext.length,
  });
  const fixedStream = PDFRawStream.of(fixedDict, plaintext);
  try {
    await PDFObjectStreamParser.forStream(fixedStream).parseIntoContext();
  } catch {
    return null;
  }
  const recovered: string[] = [];
  for (const [r] of ctx.enumerateIndirectObjects()) {
    const tag = String(r);
    if (!before.has(tag)) recovered.push(tag);
  }
  return recovered;
}

/**
 * Find every `PDFInvalidObject` that is actually an encrypted `/ObjStm` pdf-lib's
 * parser gave up on, and repair it in place. Mutates `plaintextRefs` with every
 * object number recovered (their strings must not be decrypted a second time —
 * see the comment above). Throws `UnsupportedEncryptedObjectStreams` if any
 * candidate can't be confidently reconstructed.
 */
async function repairEncryptedObjectStreams(
  doc: PDFDocument,
  streamX: Transform,
  plaintextRefs: Set<string>,
): Promise<void> {
  const ctx = doc.context;
  const candidates: PDFRef[] = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFInvalidObject)) continue;
    const raw = (obj as unknown as { data: Uint8Array }).data;
    const streamKw = findAscii(raw, "stream");
    if (streamKw === -1) continue;
    if (findAscii(raw.subarray(0, streamKw), "/ObjStm") === -1) continue;
    candidates.push(ref);
  }
  if (candidates.length === 0) return;

  for (const ref of candidates) {
    const obj = ctx.lookup(ref);
    if (!(obj instanceof PDFInvalidObject)) continue;
    const raw = (obj as unknown as { data: Uint8Array }).data;
    const recovered = await repairOneObjectStream(doc, ref, raw, streamX);
    if (!recovered) throw new UnsupportedEncryptedObjectStreams();
    ctx.delete(ref);
    for (const tag of recovered) plaintextRefs.add(tag);
  }

  // `PDFDocument`'s constructor resolves and caches `this.catalog` once, at
  // load time: `this.catalog = context.lookup(context.trailerInfo.Root)`. If
  // the /Root catalog itself was packed into one of the object streams we
  // just repaired, that cache is permanently `undefined` from the original
  // (still-encrypted) load — nothing re-derives it automatically. Left
  // stale, `doc.save()` crashes outright (it inspects the page tree via the
  // catalog). Re-sync it now that the context has the real object.
  const docWithCatalog = doc as unknown as { catalog: PDFObject | undefined };
  if (!docWithCatalog.catalog) {
    docWithCatalog.catalog = ctx.lookup(ctx.trailerInfo.Root);
  }
}

// ---------------------------------------------------------------------------
// Security handler: one object that knows a file's key and scheme
// ---------------------------------------------------------------------------

export class WrongPassword extends Error {
  constructor() {
    super("Mot de passe incorrect.");
    this.name = "WrongPassword";
  }
}

/**
 * The key and scheme of one protected file, able to decrypt that file's
 * objects and to encrypt new ones exactly as the file expects — which is what
 * saving a protected document without changing its protection requires:
 * objects appended by an incremental update (or re-written by a full save)
 * are encrypted with the *same* file key, so the same passwords and
 * permissions keep working.
 */
export interface PdfCrypt {
  /** Human label: "AES-256", "AES-128", "RC4-128"… */
  readonly scheme: string;
  readonly permissions: Permissions;
  /** First element of the trailer `/ID` the key is bound to (revisions 2–4 derive the key from it). */
  readonly id0: Uint8Array;
  /** Decrypt every object of `doc` in place (the document this handler was opened from). */
  decryptDocument(doc: PDFDocument): Promise<void>;
  /** Encrypt every object of `doc` in place (last step of a full rewrite), skipping the given refs. */
  encryptDocument(doc: PDFDocument, skip: ReadonlySet<string>): void;
  /** An encrypted COPY of indirect object `ref`, ready to be written; `obj` itself is left untouched. */
  encryptObject(ref: PDFRef, obj: PDFObject): PDFObject;
  /** Register this handler's `/Encrypt` dictionary in `doc` (for a full rewrite) and return its ref. */
  install(doc: PDFDocument): PDFRef;
}

interface CryptParams {
  info: EncryptInfo;
  fileKey: Uint8Array;
  id0: Uint8Array;
  entries: (doc: PDFDocument) => PDFDict;
  scheme: string;
}

function schemeOf(info: EncryptInfo): string {
  return info.v >= 5 ? "AES-256" : info.streamCfm === "AESV2" ? "AES-128" : `RC4-${info.lengthBytes * 8}`;
}

/** True for the streams the standard security handler never encrypts. */
function exemptStream(dict: PDFDict, info: EncryptInfo): boolean {
  const type = dict.lookup(PDFName.of("Type"));
  const name = type instanceof PDFName ? type.asString().replace(/^\//, "") : "";
  // Cross-reference streams are never encrypted; XMP metadata stays readable
  // when the file says so (/EncryptMetadata false).
  return name === "XRef" || (name === "Metadata" && !info.encryptMetadata);
}

/** A signature dictionary's /Contents (the CMS blob) is never encrypted (ISO 32000-2 §7.6.1). */
function isSignatureDict(dict: PDFDict): boolean {
  const type = dict.lookup(PDFName.of("Type"));
  if (type instanceof PDFName && (type.asString() === "/Sig" || type.asString() === "/DocTimeStamp")) return true;
  return dict.has(PDFName.of("ByteRange")) && dict.has(PDFName.of("Contents"));
}

function makeCrypt(p: CryptParams): PdfCrypt {
  const { info, fileKey } = p;
  const pick = (cfm: Cfm): Cfm => (info.v >= 5 ? "AESV3" : cfm === "None" && info.v < 4 ? "V2" : cfm);
  const streamCfm = pick(info.streamCfm);
  const stringCfm = pick(info.stringCfm);

  const decryptWith =
    (cfm: Cfm): Transform =>
    (data, ref) => {
      if (cfm === "None") return data;
      if (cfm === "AESV3") return aesDecryptWithIv(fileKey, data);
      if (cfm === "AESV2") return aesDecryptWithIv(objectKey(fileKey, ref, true), data);
      return rc4(objectKey(fileKey, ref, false), data);
    };
  const encryptWith =
    (cfm: Cfm): Transform =>
    (data, ref) => {
      if (cfm === "None") return data;
      if (cfm === "AESV3") return data.length ? aesEncryptWithIv(fileKey, data) : data;
      if (cfm === "AESV2") return data.length ? aesEncryptWithIv(objectKey(fileKey, ref, true), data) : data;
      return rc4(objectKey(fileKey, ref, false), data);
    };

  const dStream = decryptWith(streamCfm);
  const dString = decryptWith(stringCfm);
  const eStream = encryptWith(streamCfm);
  const eString = encryptWith(stringCfm);

  return {
    scheme: p.scheme,
    permissions: pToPermissions(info.p),
    id0: p.id0,
    async decryptDocument(doc) {
      const skip = new Set<string>();
      const encryptRef = doc.context.trailerInfo.Encrypt;
      if (encryptRef instanceof PDFRef) skip.add(String(encryptRef));
      // pdf-lib's parser decompresses `/ObjStm` object streams while parsing —
      // before we ever get a chance to decrypt them. If this file has any, they
      // are still ciphertext at that point, decompression silently fails, and
      // every object packed inside is dropped without a trace. Recover them here
      // (or fail loudly if we can't) before touching anything else, so `skip`
      // below can exclude their contents from the ordinary string-decryption walk
      // (objects nested in an object stream are never separately encrypted).
      await repairEncryptedObjectStreams(doc, dStream, skip);
      applySplitTransform(doc, dStream, dString, skip, info);
    },
    encryptDocument(doc, skip) {
      applySplitTransform(doc, eStream, eString, skip, info);
    },
    encryptObject(ref, obj) {
      return encryptedCopy(obj, ref, eStream, eString, info);
    },
    install(doc) {
      return doc.context.register(p.entries(doc));
    },
  };
}

/**
 * Open the security handler of a loaded document with `password` (user or
 * owner; "" for files that open without one). Returns null when the file is
 * not encrypted, throws `WrongPassword` when the password fits neither slot.
 */
/** A document protected by certificates (or another handler than passwords): not a wrong password. */
export class UnsupportedSecurityHandler extends Error {
  constructor(readonly handler: string) {
    super(`Document protégé par certificat (${handler}) : ce type de protection n'est pas pris en charge.`);
    this.name = "UnsupportedSecurityHandler";
  }
}

export function openCrypt(doc: PDFDocument, password: string): PdfCrypt | null {
  const handler = encryptHandler(doc);
  if (handler && handler !== "Standard") throw new UnsupportedSecurityHandler(handler);
  const read = readEncryptDict(doc);
  if (!read) return null;
  const { info, id0 } = read;
  const fileKey = deriveFileKey(info, id0, password);
  if (!fileKey) throw new WrongPassword();
  const encryptRef = doc.context.trailerInfo.Encrypt;
  const original = encryptRef ? doc.context.lookup(encryptRef) : undefined;
  return makeCrypt({
    info,
    fileKey,
    id0,
    scheme: schemeOf(info),
    entries: (target) => {
      if (!(original instanceof PDFDict)) throw new Error("Dictionnaire /Encrypt introuvable.");
      return deepCopy(original, target) as PDFDict;
    },
  });
}

/** Deep copy of a direct object (dicts/arrays recursively), refs kept as refs. */
function deepCopy(obj: PDFObject, target: PDFDocument): PDFObject {
  if (obj instanceof PDFDict) {
    const out = PDFDict.withContext(target.context);
    for (const [k, v] of obj.entries()) out.set(k, deepCopy(v, target));
    return out;
  }
  if (obj instanceof PDFArray) {
    const out = PDFArray.withContext(target.context);
    for (let i = 0; i < obj.size(); i++) out.push(deepCopy(obj.get(i), target));
    return out;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Walking objects
// ---------------------------------------------------------------------------

function mapString(obj: PDFObject, ref: PDFRef, x: Transform): PDFObject {
  // `asBytes()` decodes a literal's escape sequences (\( \) \\ \ddd…), which
  // encrypted strings routinely contain; `asString()` would keep them raw.
  if (obj instanceof PDFHexString || obj instanceof PDFString) return PDFHexString.of(toHex(x(obj.asBytes(), ref)));
  return obj;
}

function streamBytes(obj: PDFStream): Uint8Array | null {
  if (obj instanceof PDFRawStream) return obj.contents;
  try {
    return (obj as unknown as { getContents(): Uint8Array }).getContents();
  } catch {
    return null;
  }
}

/** In place: transform every string and stream payload of the document. */
function applySplitTransform(
  doc: PDFDocument,
  streamX: Transform,
  stringX: Transform,
  skip: ReadonlySet<string>,
  info: EncryptInfo,
): void {
  const ctx = doc.context;
  const walk = (obj: PDFObject | undefined, ref: PDFRef, seen: Set<PDFObject>): void => {
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const child = obj.get(i);
        if (child instanceof PDFRef) continue;
        if (child instanceof PDFString || child instanceof PDFHexString) obj.set(i, mapString(child, ref, stringX));
        else walk(child, ref, seen);
      }
      return;
    }
    if (obj instanceof PDFDict) {
      const isSig = isSignatureDict(obj);
      for (const [key, child] of obj.entries()) {
        if (child instanceof PDFRef) continue;
        if (child instanceof PDFString || child instanceof PDFHexString) {
          if (isSig && key.asString() === "/Contents") continue;
          obj.set(key, mapString(child, ref, stringX));
        } else walk(child, ref, seen);
      }
    }
  };

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (skip.has(String(ref))) continue;
    if (obj instanceof PDFStream) {
      const dict = (obj as unknown as { dict: PDFDict }).dict;
      if (exemptStream(dict, info)) continue;
      walk(dict, ref, new Set());
      const raw = streamBytes(obj);
      if (!raw) continue;
      const next = streamX(raw, ref);
      dict.set(PDFName.of("Length"), PDFNumber.of(next.length));
      ctx.assign(ref, PDFRawStream.of(dict, next));
      continue;
    }
    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      ctx.assign(ref, mapString(obj, ref, stringX));
      continue;
    }
    walk(obj, ref, new Set());
  }
}

/** Copy-on-write variant of the walk: an encrypted copy of one indirect object. */
function encryptedCopy(
  obj: PDFObject,
  ref: PDFRef,
  streamX: Transform,
  stringX: Transform,
  info: EncryptInfo,
): PDFObject {
  const copy = (o: PDFObject): PDFObject => {
    if (o instanceof PDFString || o instanceof PDFHexString) return mapString(o, ref, stringX);
    if (o instanceof PDFArray) {
      const out = PDFArray.withContext((o as unknown as { context: PDFDict["context"] }).context);
      for (let i = 0; i < o.size(); i++) out.push(copy(o.get(i)));
      return out;
    }
    if (o instanceof PDFDict) {
      const out = PDFDict.withContext(o.context);
      const isSig = isSignatureDict(o);
      for (const [k, v] of o.entries()) out.set(k, isSig && k.asString() === "/Contents" ? v : copy(v));
      return out;
    }
    return o;
  };
  if (obj instanceof PDFStream) {
    const dict = (obj as unknown as { dict: PDFDict }).dict;
    const raw = streamBytes(obj) ?? new Uint8Array(0);
    const exempt = exemptStream(dict, info);
    const d = exempt ? dict.clone() : (copy(dict) as PDFDict);
    const data = exempt ? raw : streamX(raw, ref);
    d.set(PDFName.of("Length"), PDFNumber.of(data.length));
    return PDFRawStream.of(d, data);
  }
  return copy(obj);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DecryptResult {
  bytes: Uint8Array;
  /** Permissions the original file declared. */
  permissions: Permissions;
  /** Human label of the scheme that was removed. */
  scheme: string;
}

/**
 * Remove a document's protection, returning plaintext bytes pdf-lib can edit.
 * Throws `WrongPassword` when the password does not fit either slot.
 */
export async function removeProtection(bytes: Uint8Array, password: string): Promise<DecryptResult> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const crypt = openCrypt(doc, password);
  if (!crypt) return { bytes, permissions: ALL_PERMISSIONS, scheme: "aucune" };
  await crypt.decryptDocument(doc);
  const encryptRef = doc.context.trailerInfo.Encrypt;
  doc.context.trailerInfo.Encrypt = undefined;
  if (encryptRef instanceof PDFRef) doc.context.delete(encryptRef);

  const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes: out, permissions: crypt.permissions, scheme: crypt.scheme };
}

export interface ProtectOptions {
  /** Password required to open the document. Empty = open freely. */
  userPassword: string;
  /** Password required to change permissions. Defaults to the user password. */
  ownerPassword?: string;
  permissions?: Permissions;
  /** Leave document metadata readable by search indexers. */
  encryptMetadata?: boolean;
}

/**
 * A brand-new AES-256 (revision 6) security handler for `opts` — random file
 * key, /U /UE /O /OE /Perms computed per ISO 32000-2.
 */
export function createCrypt(opts: ProtectOptions): PdfCrypt {
  const permissions = opts.permissions ?? ALL_PERMISSIONS;
  const p = permissionsToP(permissions);
  const encryptMetadata = opts.encryptMetadata !== false;
  const userPw = r6Password(opts.userPassword);
  const ownerPw = r6Password(opts.ownerPassword || opts.userPassword);

  const fileKey = randomBytes(32);
  const uValidationSalt = randomBytes(8);
  const uKeySalt = randomBytes(8);
  const uHash = hash2B(userPw, uValidationSalt, new Uint8Array(0));
  const u = concatBytes(uHash, uValidationSalt, uKeySalt);
  const ue = aesCbcNoPadEncrypt(hash2B(userPw, uKeySalt, new Uint8Array(0)), ZERO_IV, fileKey);

  const oValidationSalt = randomBytes(8);
  const oKeySalt = randomBytes(8);
  const oHash = hash2B(ownerPw, oValidationSalt, u);
  const o = concatBytes(oHash, oValidationSalt, oKeySalt);
  const oe = aesCbcNoPadEncrypt(hash2B(ownerPw, oKeySalt, u), ZERO_IV, fileKey);

  // /Perms: the permission bits, sealed with the file key so a tampered /P is
  // detected by conforming readers.
  const perms = new Uint8Array(16);
  new DataView(perms.buffer).setInt32(0, p, true);
  perms.set([0xff, 0xff, 0xff, 0xff], 4);
  perms[8] = encryptMetadata ? 0x54 : 0x46; // 'T' / 'F'
  perms.set([0x61, 0x64, 0x62], 9); // 'a' 'd' 'b'
  perms.set(randomBytes(4), 12);
  const permsEnc = ecb(fileKey, { disablePadding: true }).encrypt(perms);

  const info: EncryptInfo = {
    v: 5,
    r: 6,
    lengthBytes: 32,
    o,
    u,
    oe,
    ue,
    p,
    encryptMetadata,
    streamCfm: "AESV3",
    stringCfm: "AESV3",
  };
  return makeCrypt({
    info,
    fileKey,
    id0: randomBytes(16),
    scheme: "AES-256",
    entries: (doc) =>
      doc.context.obj({
        Filter: "Standard",
        V: 5,
        R: 6,
        Length: 256,
        CF: { StdCF: { CFM: "AESV3", AuthEvent: "DocOpen", Length: 32 } },
        StmF: "StdCF",
        StrF: "StdCF",
        P: p,
        EncryptMetadata: encryptMetadata,
        O: PDFHexString.of(toHex(o)),
        U: PDFHexString.of(toHex(u)),
        OE: PDFHexString.of(toHex(oe)),
        UE: PDFHexString.of(toHex(ue)),
        Perms: PDFHexString.of(toHex(permsEnc)),
      } as never) as unknown as PDFDict,
  });
}

/** The trailer /ID for a file protected by `crypt`: its bound first element, a fresh second one. */
export function fileIdFor(doc: PDFDocument, crypt: PdfCrypt): PDFArray {
  return doc.context.obj([
    PDFHexString.of(toHex(crypt.id0)),
    PDFHexString.of(toHex(randomBytes(16))),
  ] as never) as unknown as PDFArray;
}

/**
 * Write `doc` in full, encrypted with `crypt` (a new handler from
 * `createCrypt`, or the file's own from `openCrypt`). The document must be
 * plaintext, fully assembled, and carry no `/Encrypt` of its own.
 */
export async function writeEncrypted(doc: PDFDocument, crypt: PdfCrypt): Promise<Uint8Array> {
  // Everything pdf-lib has queued (fonts, images, appearances) must be written
  // into the context BEFORE we encrypt, or it would go out in the clear.
  await doc.flush();
  const ctx = doc.context;
  const encryptRef = crypt.install(doc);
  // A file identifier is mandatory for encrypted documents, and revisions 2–4
  // bind the key to its first element.
  ctx.trailerInfo.ID = fileIdFor(doc, crypt);
  crypt.encryptDocument(doc, new Set([String(encryptRef)]));
  ctx.trailerInfo.Encrypt = encryptRef;
  // Object streams would nest strings inside an already-encrypted stream; the
  // classic layout keeps every object independently encrypted, as V5 expects.
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/**
 * Protect a document with AES-256 (revision 6) and write it out.
 * The document must already be fully assembled — this is the last step.
 */
export async function protectDocument(doc: PDFDocument, opts: ProtectOptions): Promise<Uint8Array> {
  return writeEncrypted(doc, createCrypt(opts));
}

/** Quick probe: is this file password-protected, and with what? */
export async function inspectProtection(
  bytes: Uint8Array,
  /** The password the file was opened with: says whether it holds the owner's rights. */
  password?: string | null,
): Promise<{
  encrypted: boolean;
  scheme: string;
  permissions: Permissions;
  /** The document's restrictions do not apply: not protected, or opened with the owner password. */
  owner: boolean;
  /** Protected by another handler than the password one (certificates: /Adobe.PubSec…). */
  handler?: string;
} | null> {
  try {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    const handler = encryptHandler(doc);
    if (handler && handler !== "Standard") {
      return { encrypted: true, scheme: handler, permissions: pToPermissions(0), owner: false, handler };
    }
    const read = readEncryptDict(doc);
    if (!read) return { encrypted: false, scheme: "aucune", permissions: ALL_PERMISSIONS, owner: true };
    const role = passwordRole(read.info, read.id0, password ?? "");
    return {
      encrypted: true,
      scheme: schemeOf(read.info),
      permissions: pToPermissions(read.info.p),
      owner: !!role?.owner,
    };
  } catch {
    return null;
  }
}

/** The /Filter of the file's /Encrypt (« Standard » for passwords), or null when not protected. */
export function encryptHandler(doc: PDFDocument): string | null {
  const ref = doc.context.trailerInfo.Encrypt;
  const enc = ref ? doc.context.lookup(ref) : undefined;
  if (!(enc instanceof PDFDict)) return null;
  const f = enc.lookup(PDFName.of("Filter"));
  return f instanceof PDFName ? f.asString().replace(/^\//, "") : "Standard";
}

export { decodePDFRawStream };
