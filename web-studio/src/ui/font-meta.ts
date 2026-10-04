/**
 * Lecture minimale des métadonnées d'un fichier de police (TTF / OTF / TTC) :
 * on ne veut que le NOM à afficher dans les sélecteurs, pas décoder les glyphes.
 * Pur (aucun accès DOM) pour être testable sous Node.
 */

export type FontKind = "ttf" | "otf" | "woff" | "woff2";

export const MAX_FONT_BYTES = 25 * 1024 * 1024;

export interface FontMeta {
  kind: FontKind;
  /** Nom complet (ex. « Roboto Bold ») si lisible dans le fichier. */
  fullName?: string;
  family?: string;
  subfamily?: string;
}

const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/** Type réel du fichier d'après sa signature (jamais d'après l'extension). */
export function sniffFontKind(b: Uint8Array): FontKind | null {
  if (b.length < 12) return null;
  const t = tag(b, 0);
  if (t === "wOFF") return "woff";
  if (t === "wOF2") return "woff2";
  if (t === "OTTO") return "otf";
  if (t === "true" || t === "ttcf" || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)) return "ttf";
  return null;
}

function decode(bytes: Uint8Array, utf16: boolean): string {
  if (!utf16) return Array.from(bytes, (c) => String.fromCharCode(c)).join("");
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  return out;
}

/** Noms (nameID → texte) de la table `name` d'un TTF/OTF/TTC, ou undefined. */
function readNameTable(b: Uint8Array): Map<number, string> | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let base = 0;
  if (tag(b, 0) === "ttcf") base = dv.getUint32(12); // première police de la collection
  if (base + 12 > b.length) return undefined;
  const numTables = dv.getUint16(base + 4);
  let nameOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > b.length) return undefined;
    if (tag(b, rec) === "name") {
      nameOff = dv.getUint32(rec + 8);
      break;
    }
  }
  if (nameOff < 0 || nameOff + 6 > b.length) return undefined;
  const count = dv.getUint16(nameOff + 2);
  const strings = nameOff + dv.getUint16(nameOff + 4);
  const best = new Map<number, { score: number; text: string }>();
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    if (r + 12 > b.length) break;
    const platform = dv.getUint16(r);
    const lang = dv.getUint16(r + 4);
    const id = dv.getUint16(r + 6);
    const len = dv.getUint16(r + 8);
    const off = strings + dv.getUint16(r + 10);
    if (off + len > b.length) continue;
    const utf16 = platform === 0 || platform === 3;
    if (!utf16 && platform !== 1) continue;
    const text = decode(b.subarray(off, off + len), utf16).trim();
    if (!text) continue;
    // Préférence : Windows anglais US > Windows autre > Unicode > Mac.
    const score = platform === 3 ? (lang === 0x409 ? 4 : 3) : platform === 0 ? 2 : 1;
    const prev = best.get(id);
    if (!prev || score > prev.score) best.set(id, { score, text });
  }
  return new Map([...best].map(([k, v]) => [k, v.text]));
}

export function readFontMeta(bytes: Uint8Array): FontMeta | null {
  const kind = sniffFontKind(bytes);
  if (!kind) return null;
  if (kind === "woff" || kind === "woff2") return { kind }; // tables compressées : nom depuis le fichier
  let names: Map<number, string> | undefined;
  try {
    names = readNameTable(bytes);
  } catch {
    names = undefined;
  }
  return {
    kind,
    fullName: names?.get(4),
    family: names?.get(16) ?? names?.get(1),
    subfamily: names?.get(17) ?? names?.get(2),
  };
}

/**
 * Nom affiché / clé de la police dans l'application : sans guillemets ni
 * virgules (il finit dans une pile CSS), borné, jamais vide.
 */
export function cleanFontName(raw: string): string {
  const name = raw.replace(/["'`\\;{}<>]/g, "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  return name.slice(0, 64) || "Police importée";
}

/** Nom à utiliser pour un fichier : celui de la police si lisible, sinon le nom du fichier. */
export function fontDisplayName(meta: FontMeta | null, filename: string): string {
  const fromFile = filename.replace(/\.(ttf|otf|ttc|woff2?)$/i, "").replace(/[_]+/g, " ");
  const fromFont = meta?.fullName ?? (meta?.family ? [meta.family, meta.subfamily].filter(Boolean).join(" ") : undefined);
  return cleanFontName(fromFont ?? fromFile);
}
