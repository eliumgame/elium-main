/**
 * Boîtes JUMBF (ISO 19566-5) et extraction du magasin de manifestes C2PA hors
 * des conteneurs image/vidéo : JPEG (APP11, JPEG XT), PNG (chunk `caBX`),
 * WebP/RIFF (chunk `C2PA`) et MP4/HEIF (boîte `uuid` C2PA). Défensif : toute
 * structure malformée lève `JumbfError` (ou renvoie `undefined` si rien à voir).
 */

export class JumbfError extends Error {}

export type ContainerKind = "jpeg" | "png" | "webp" | "mp4";

export interface JumbfBox {
  type: string;
  /** Offset de l'en-tête (LBox) dans le tampon parent. */
  start: number;
  end: number;
  /** Contenu, sans l'en-tête LBox/TBox. */
  payload: Uint8Array;
}

export interface JumbfNode extends JumbfBox {
  /** Pour une superboîte `jumb` : étiquette lue dans la boîte `jumd`. */
  label?: string;
  children?: JumbfNode[];
}

const MAX_DEPTH = 16;

export function readBoxes(buf: Uint8Array, start = 0, end = buf.length): JumbfBox[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: JumbfBox[] = [];
  let at = start;
  while (at + 8 <= end) {
    let len = view.getUint32(at);
    const type = String.fromCharCode(buf[at + 4]!, buf[at + 5]!, buf[at + 6]!, buf[at + 7]!);
    let header = 8;
    if (len === 1) {
      if (at + 16 > end) throw new JumbfError("boîte JUMBF tronquée");
      const big = view.getBigUint64(at + 8);
      if (big > BigInt(end)) throw new JumbfError("boîte JUMBF trop grande");
      len = Number(big);
      header = 16;
    } else if (len === 0) {
      len = end - at;
    }
    if (len < header || at + len > end) throw new JumbfError("boîte JUMBF incohérente");
    out.push({ type, start: at, end: at + len, payload: buf.subarray(at + header, at + len) });
    at += len;
  }
  return out;
}

function parseNode(box: JumbfBox, depth: number): JumbfNode {
  const node: JumbfNode = { ...box };
  if (box.type === "jumb" && depth < MAX_DEPTH) {
    const kids = readBoxes(box.payload);
    const desc = kids.find((k) => k.type === "jumd");
    if (desc) {
      // UUID (16) + toggles (1) + étiquette UTF-8 terminée par NUL.
      const p = desc.payload;
      let i = 17;
      while (i < p.length && p[i] !== 0) i++;
      if (p.length >= 17) node.label = new TextDecoder().decode(p.subarray(17, i));
    }
    node.children = kids.filter((k) => k.type !== "jumd").map((k) => parseNode(k, depth + 1));
  }
  return node;
}

export function parseJumbf(buf: Uint8Array): JumbfNode[] {
  return readBoxes(buf).map((b) => parseNode(b, 0));
}

// ---- Extraction depuis les conteneurs -------------------------------------

const ascii4 = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

function fromJpeg(bytes: Uint8Array): Uint8Array | undefined {
  const frags = new Map<number, { z: number; data: Uint8Array }[]>();
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    let j = i + 1;
    while (bytes[j] === 0xff && j + 1 < bytes.length) j++;
    const marker = bytes[j]!;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i = j + 1;
      continue;
    }
    if (j + 2 >= bytes.length) break;
    const len = (bytes[j + 1]! << 8) | bytes[j + 2]!;
    if (len < 2 || j + 1 + len > bytes.length) break;
    if (marker === 0xeb && len >= 2 + 8 + 8) {
      const d = bytes.subarray(j + 3, j + 1 + len);
      if (d[0] === 0x4a && d[1] === 0x50) {
        const en = (d[2]! << 8) | d[3]!;
        const z = ((d[4]! << 24) | (d[5]! << 16) | (d[6]! << 8) | d[7]!) >>> 0;
        const list = frags.get(en) ?? [];
        list.push({ z, data: d.subarray(8) });
        frags.set(en, list);
      }
    }
    if (marker === 0xda) break;
    i = j + 1 + len;
  }
  for (const list of frags.values()) {
    list.sort((a, b) => a.z - b.z);
    // Les fragments suivants répètent LBox/TBox (8 octets) du premier.
    const parts = list.map((f, k) => (k === 0 ? f.data : f.data.subarray(8)));
    const first = parts[0]!;
    if (first.length >= 8 && ascii4(first, 4) === "jumb") return concat(parts);
  }
  return undefined;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function fromPng(bytes: Uint8Array): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const type = ascii4(bytes, at + 4);
    if (at + 12 + len > bytes.length) break;
    if (type === "caBX") return bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
  }
  return undefined;
}

function fromWebp(bytes: Uint8Array): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const type = ascii4(bytes, at);
    const len = view.getUint32(at + 4, true);
    if (at + 8 + len > bytes.length) break;
    if (type === "C2PA") return bytes.subarray(at + 8, at + 8 + len);
    at += 8 + len + (len & 1);
  }
  return undefined;
}

/** UUID de la boîte ISO-BMFF portant un manifeste C2PA. */
export const C2PA_BMFF_UUID = Uint8Array.from([
  0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81,
]);

function fromMp4(bytes: Uint8Array): Uint8Array | undefined {
  for (const box of readBoxes(bytes)) {
    if (box.type !== "uuid" || box.payload.length < 16 + 4 + 2) continue;
    if (!C2PA_BMFF_UUID.every((b, k) => box.payload[k] === b)) continue;
    let i = 16 + 4; // UUID + version/flags
    let e = i;
    while (e < box.payload.length && box.payload[e] !== 0) e++;
    const purpose = new TextDecoder().decode(box.payload.subarray(i, e));
    i = e + 1;
    if (purpose === "manifest") i += 8; // décalage vers les boîtes auxiliaires
    if (i < box.payload.length) return box.payload.subarray(i);
  }
  return undefined;
}

export function detectContainer(bytes: Uint8Array): ContainerKind | undefined {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 12 && ascii4(bytes, 0) === "RIFF" && ascii4(bytes, 8) === "WEBP") return "webp";
  if (bytes.length > 12 && ascii4(bytes, 4) === "ftyp") return "mp4";
  return undefined;
}

export interface ExtractedStore {
  container: ContainerKind;
  /** Octets JUMBF du magasin de manifestes. */
  store: Uint8Array;
}

export function extractManifestStore(bytes: Uint8Array): ExtractedStore | undefined {
  const container = detectContainer(bytes);
  if (!container) return undefined;
  const store =
    container === "jpeg"
      ? fromJpeg(bytes)
      : container === "png"
        ? fromPng(bytes)
        : container === "webp"
          ? fromWebp(bytes)
          : fromMp4(bytes);
  return store ? { container, store } : undefined;
}

// ---- Construction (tests et outils) ----------------------------------------

export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

export function descriptionBox(uuid: Uint8Array, label: string): Uint8Array {
  const l = new TextEncoder().encode(label);
  const body = new Uint8Array(17 + l.length + 1);
  body.set(uuid, 0);
  body[16] = 0x03; // requestable + label présente
  body.set(l, 17);
  return box("jumd", body);
}

export function superBox(uuid: Uint8Array, label: string, ...content: Uint8Array[]): Uint8Array {
  return box("jumb", descriptionBox(uuid, label), ...content);
}

export { concat as concatBytes };
