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
  PDFName,
  PDFNumber,
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
  // All reserved high bits set, then clear the ones that are denied.
  let v = -1 & ~0b111100; // bits 1-2 and 7-8 are reserved-0 in revision 3+
  v |= 0xfffff000;
  for (const [key, bit] of Object.entries(BIT)) {
    if (p[key as keyof Permissions]) v |= bit;
    else v &= ~bit;
  }
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

/** Recover the file key from a user or owner password, or null if neither fits. */
function deriveFileKey(info: EncryptInfo, id0: Uint8Array, password: string): Uint8Array | null {
  if (info.v >= 5) {
    const pw = utf8Bytes(password).subarray(0, 127);
    const uValidation = info.u.subarray(32, 40);
    const uKeySalt = info.u.subarray(40, 48);
    const userHash = info.r === 5 ? sha256(concatBytes(pw, uValidation)) : hash2B(pw, uValidation, new Uint8Array(0));
    if (equal(userHash, info.u.subarray(0, 32)) && info.ue) {
      const ik = info.r === 5 ? sha256(concatBytes(pw, uKeySalt)) : hash2B(pw, uKeySalt, new Uint8Array(0));
      return aesCbcNoPadDecrypt(ik, ZERO_IV, info.ue.subarray(0, 32));
    }
    const u48 = info.u.subarray(0, 48);
    const oValidation = info.o.subarray(32, 40);
    const oKeySalt = info.o.subarray(40, 48);
    const ownerHash = info.r === 5 ? sha256(concatBytes(pw, oValidation, u48)) : hash2B(pw, oValidation, u48);
    if (equal(ownerHash, info.o.subarray(0, 32)) && info.oe) {
      const ik = info.r === 5 ? sha256(concatBytes(pw, oKeySalt, u48)) : hash2B(pw, oKeySalt, u48);
      return aesCbcNoPadDecrypt(ik, ZERO_IV, info.oe.subarray(0, 32));
    }
    return null;
  }

  // Revisions 2–4: try the password as user, then as owner.
  const asUser = legacyFileKey(password, info.o, info.p, id0, info.r, info.lengthBytes, info.encryptMetadata);
  if (checkLegacyUser(asUser, info, id0)) return asUser;

  // Owner path: decrypt /O to recover the user password, then redo algorithm 2.
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
// Public API
// ---------------------------------------------------------------------------

export class WrongPassword extends Error {
  constructor() {
    super("Mot de passe incorrect.");
    this.name = "WrongPassword";
  }
}

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
  const read = readEncryptDict(doc);
  if (!read) {
    return { bytes, permissions: ALL_PERMISSIONS, scheme: "aucune" };
  }
  const { info, id0 } = read;
  const fileKey = deriveFileKey(info, id0, password);
  if (!fileKey) throw new WrongPassword();

  const encryptRef = doc.context.trailerInfo.Encrypt;
  const skip = new Set<string>();
  if (encryptRef instanceof PDFRef) skip.add(String(encryptRef));

  const decryptWith =
    (cfm: Cfm): Transform =>
    (data, ref) => {
      if (cfm === "None") return data;
      if (cfm === "AESV3") return aesDecryptWithIv(fileKey, data);
      if (cfm === "AESV2") return aesDecryptWithIv(objectKey(fileKey, ref, true), data);
      return rc4(objectKey(fileKey, ref, false), data);
    };

  const streamX = decryptWith(info.v >= 5 ? "AESV3" : info.streamCfm === "None" && info.v < 4 ? "V2" : info.streamCfm);
  const stringX = decryptWith(info.v >= 5 ? "AESV3" : info.stringCfm === "None" && info.v < 4 ? "V2" : info.stringCfm);

  applySplitTransform(doc, streamX, stringX, skip);

  doc.context.trailerInfo.Encrypt = undefined;
  if (encryptRef instanceof PDFRef) doc.context.delete(encryptRef);

  const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return {
    bytes: out,
    permissions: pToPermissions(info.p),
    scheme: info.v >= 5 ? "AES-256" : info.streamCfm === "AESV2" ? "AES-128" : `RC4-${info.lengthBytes * 8}`,
  };
}

/** Same walk as `transformAll` but with separate handling for streams vs strings. */
function applySplitTransform(
  doc: PDFDocument,
  streamX: Transform,
  stringX: Transform,
  skip: ReadonlySet<string>,
): void {
  const ctx = doc.context;
  const mapString = (obj: PDFObject, ref: PDFRef): PDFObject => {
    if (obj instanceof PDFHexString) return PDFHexString.of(toHex(stringX(obj.asBytes(), ref)));
    if (obj instanceof PDFString) return PDFHexString.of(toHex(stringX(latin1Bytes(obj.asString()), ref)));
    return obj;
  };
  const walk = (obj: PDFObject | undefined, ref: PDFRef, seen: Set<PDFObject>): void => {
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const child = obj.get(i);
        if (child instanceof PDFRef) continue;
        if (child instanceof PDFString || child instanceof PDFHexString) obj.set(i, mapString(child, ref));
        else walk(child, ref, seen);
      }
      return;
    }
    if (obj instanceof PDFDict) {
      for (const [key, child] of obj.entries()) {
        if (child instanceof PDFRef) continue;
        if (child instanceof PDFString || child instanceof PDFHexString) obj.set(key, mapString(child, ref));
        else walk(child, ref, seen);
      }
    }
  };

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (skip.has(String(ref))) continue;
    if (obj instanceof PDFStream) {
      const dict = (obj as unknown as { dict: PDFDict }).dict;
      const type = dict.lookup(PDFName.of("Type"));
      // Cross-reference streams are never encrypted.
      if (type instanceof PDFName && type.asString().replace(/^\//, "") === "XRef") continue;
      walk(dict, ref, new Set());
      let raw: Uint8Array | null = null;
      if (obj instanceof PDFRawStream) raw = obj.contents;
      else {
        try {
          raw = (obj as unknown as { getContents(): Uint8Array }).getContents();
        } catch {
          raw = null;
        }
      }
      if (!raw) continue;
      const next = streamX(raw, ref);
      dict.set(PDFName.of("Length"), PDFNumber.of(next.length));
      ctx.assign(ref, PDFRawStream.of(dict, next));
      continue;
    }
    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      ctx.assign(ref, mapString(obj, ref));
      continue;
    }
    walk(obj, ref, new Set());
  }
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
 * Protect a document with AES-256 (revision 6) and write it out.
 * The document must already be fully assembled — this is the last step.
 */
export async function protectDocument(doc: PDFDocument, opts: ProtectOptions): Promise<Uint8Array> {
  const permissions = opts.permissions ?? ALL_PERMISSIONS;
  const p = permissionsToP(permissions);
  const encryptMetadata = opts.encryptMetadata !== false;
  const userPw = utf8Bytes(opts.userPassword).subarray(0, 127);
  const ownerPw = utf8Bytes(opts.ownerPassword || opts.userPassword).subarray(0, 127);

  // Everything pdf-lib has queued (fonts, images, appearances) must be written
  // into the context BEFORE we encrypt, or it would go out in the clear.
  await doc.flush();

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

  const ctx = doc.context;
  const encryptDict = ctx.obj({
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
  } as never);
  const encryptRef = ctx.register(encryptDict);

  // A file identifier is mandatory for encrypted documents.
  if (!(ctx.trailerInfo.ID instanceof PDFArray)) {
    const id = PDFHexString.of(toHex(randomBytes(16)));
    ctx.trailerInfo.ID = ctx.obj([id, id] as never);
  }

  const skip = new Set<string>([String(encryptRef)]);
  const xform: Transform = (data) => (data.length ? aesEncryptWithIv(fileKey, data) : data);
  applySplitTransform(doc, xform, xform, skip);

  ctx.trailerInfo.Encrypt = encryptRef;
  // Object streams would nest strings inside an already-encrypted stream; the
  // classic layout keeps every object independently encrypted, as V5 expects.
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/** Quick probe: is this file password-protected, and with what? */
export async function inspectProtection(
  bytes: Uint8Array,
): Promise<{ encrypted: boolean; scheme: string; permissions: Permissions } | null> {
  try {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    const read = readEncryptDict(doc);
    if (!read) return { encrypted: false, scheme: "aucune", permissions: ALL_PERMISSIONS };
    return {
      encrypted: true,
      scheme:
        read.info.v >= 5 ? "AES-256" : read.info.streamCfm === "AESV2" ? "AES-128" : `RC4-${read.info.lengthBytes * 8}`,
      permissions: pToPermissions(read.info.p),
    };
  } catch {
    return null;
  }
}

export { decodePDFRawStream };
