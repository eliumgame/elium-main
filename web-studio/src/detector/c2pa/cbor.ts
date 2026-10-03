/**
 * Décodeur / encodeur CBOR minimal (RFC 8949) pour les manifestes C2PA.
 * Couvre ce qu'un manifeste utilise : entiers, octets, texte, tableaux,
 * dictionnaires, étiquettes, booléens, null, flottants. Le décodeur est
 * défensif (profondeur et tailles bornées) et ne lève que `CborError`.
 */

export class CborError extends Error {}

export interface CborTag {
  readonly tag: number;
  readonly value: CborValue;
}
export type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>
  | CborTag;

const MAX_DEPTH = 64;

export function isTag(v: CborValue): v is CborTag {
  return (
    typeof v === "object" &&
    v !== null &&
    !(v instanceof Uint8Array) &&
    !(v instanceof Map) &&
    !Array.isArray(v) &&
    "tag" in v
  );
}

export interface CborDecoded {
  value: CborValue;
  /** Octets consommés. */
  length: number;
}

export function decodeCbor(bytes: Uint8Array, at = 0): CborDecoded {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = at;

  const need = (n: number) => {
    if (pos + n > bytes.length) throw new CborError("CBOR tronqué");
  };
  const argument = (info: number): number | bigint => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return bytes[pos++]!;
    }
    if (info === 25) {
      need(2);
      const v = view.getUint16(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = view.getUint32(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = view.getBigUint64(pos);
      pos += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    throw new CborError("CBOR : longueur indéfinie ou information invalide non prise en charge");
  };
  const lengthOf = (info: number): number => {
    const a = argument(info);
    if (typeof a === "bigint" || a > bytes.length) throw new CborError("CBOR : longueur incohérente");
    return a;
  };

  const read = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw new CborError("CBOR trop profond");
    need(1);
    const head = bytes[pos++]!;
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0:
        return argument(info);
      case 1: {
        const a = argument(info);
        return typeof a === "bigint" ? -1n - a : -1 - a;
      }
      case 2: {
        const n = lengthOf(info);
        need(n);
        const out = bytes.subarray(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        const n = lengthOf(info);
        need(n);
        const out = new TextDecoder("utf-8").decode(bytes.subarray(pos, pos + n));
        pos += n;
        return out;
      }
      case 4: {
        const n = lengthOf(info);
        const arr: CborValue[] = [];
        for (let i = 0; i < n; i++) arr.push(read(depth + 1));
        return arr;
      }
      case 5: {
        const n = lengthOf(info);
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = read(depth + 1);
          map.set(k, read(depth + 1));
        }
        return map;
      }
      case 6: {
        const t = argument(info);
        return { tag: Number(t), value: read(depth + 1) };
      }
      default: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) {
          need(2);
          const h = view.getUint16(pos);
          pos += 2;
          const e = (h >> 10) & 0x1f;
          const f = h & 0x3ff;
          const sign = h & 0x8000 ? -1 : 1;
          if (e === 0) return sign * f * 2 ** -24;
          if (e === 31) return f ? NaN : sign * Infinity;
          return sign * (1 + f / 1024) * 2 ** (e - 15);
        }
        if (info === 26) {
          need(4);
          const v = view.getFloat32(pos);
          pos += 4;
          return v;
        }
        if (info === 27) {
          need(8);
          const v = view.getFloat64(pos);
          pos += 8;
          return v;
        }
        throw new CborError("CBOR : type simple non pris en charge");
      }
    }
  };

  const value = read(0);
  return { value, length: pos - at };
}

// ---- Encodeur (utilisé pour reconstruire Sig_structure et par les tests) ----

function head(major: number, n: number | bigint): number[] {
  const m = major << 5;
  if (typeof n === "bigint") {
    const out = [m | 27];
    for (let i = 7; i >= 0; i--) out.push(Number((n >> BigInt(i * 8)) & 0xffn));
    return out;
  }
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  if (n < 0x100000000) return [m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return head(major, BigInt(n));
}

export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  const push = (b: ArrayLike<number>) => {
    for (let i = 0; i < b.length; i++) out.push(b[i]!);
  };
  const enc = (v: CborValue): void => {
    if (v === null) return void out.push(0xf6);
    if (v === undefined) return void out.push(0xf7);
    if (typeof v === "boolean") return void out.push(v ? 0xf5 : 0xf4);
    if (typeof v === "number") {
      if (!Number.isInteger(v)) {
        const b = new Uint8Array(9);
        b[0] = 0xfb;
        new DataView(b.buffer).setFloat64(1, v);
        return push(b);
      }
      return push(v >= 0 ? head(0, v) : head(1, -1 - v));
    }
    if (typeof v === "bigint") return push(v >= 0n ? head(0, v) : head(1, -1n - v));
    if (typeof v === "string") {
      const b = new TextEncoder().encode(v);
      push(head(3, b.length));
      return push(b);
    }
    if (v instanceof Uint8Array) {
      push(head(2, v.length));
      return push(v);
    }
    if (Array.isArray(v)) {
      push(head(4, v.length));
      return v.forEach(enc);
    }
    if (v instanceof Map) {
      push(head(5, v.size));
      for (const [k, val] of v) {
        enc(k);
        enc(val);
      }
      return;
    }
    push(head(6, v.tag));
    enc(v.value);
  };
  enc(value);
  return Uint8Array.from(out);
}

/** Lecture pratique d'un dictionnaire CBOR à clés texte. */
export function mapGet(v: CborValue | undefined, key: string | number): CborValue | undefined {
  return v instanceof Map ? v.get(key) : undefined;
}
