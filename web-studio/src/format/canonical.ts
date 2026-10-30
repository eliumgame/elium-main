/**
 * Canonical serialization & hashing helpers.
 *
 * Hashes must be reproducible byte-for-byte across the TypeScript and Python
 * implementations, so we fix a single canonical JSON form:
 *   - object keys sorted lexicographically (recursively)
 *   - no insignificant whitespace
 *   - UTF-8 encoding
 *
 * Python equivalent: json.dumps(obj, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False).encode("utf-8")
 */

const te = new TextEncoder();

/** Deterministic JSON string with recursively sorted object keys. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue; // mirror JSON.stringify dropping undefined
      out[key] = sortDeep(v);
    }
    return out;
  }
  // Rejeter les nombres non finis : JSON.stringify les transforme silencieusement
  // en `null`, ce qui corromprait un hash de sceau/journal sans avertissement — et
  // Python (json.dumps allow_nan=False, canonical.py) les refuse aussi → parité.
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonicalJSON : nombre non fini (NaN/Infinity) — non sérialisable de façon canonique.");
  }
  return value;
}

const HEX_BYTE: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** Hex en minuscules. Table d'octets + assemblage par blocs : un gros update (plusieurs Mo) ne fige pas l'interface. */
export function toHex(bytes: Uint8Array): string {
  const n = bytes.length;
  if (n <= 4096) {
    let s = "";
    for (let i = 0; i < n; i++) s += HEX_BYTE[bytes[i]];
    return s;
  }
  const parts: string[] = [];
  const chunk = new Array<string>(8192);
  for (let i = 0; i < n; i += 8192) {
    const end = Math.min(n, i + 8192);
    chunk.length = end - i;
    for (let j = i; j < end; j++) chunk[j - i] = HEX_BYTE[bytes[j]];
    parts.push(chunk.join(""));
  }
  return parts.join("");
}

/** Hex strict (CLIENT-09, parité Python bytes.fromhex) : `/^[0-9a-fA-F]*$/` et longueur paire.
 *  Avant, un caractère non hexadécimal devenait silencieusement un octet 0. */
export function fromHex(hex: string): Uint8Array {
  const clean = typeof hex === "string" ? hex.trim() : "";
  if (typeof hex !== "string" || clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean))
    throw new Error("Invalid hex string");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? te.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** sha256 over the canonical JSON encoding of `value`. */
export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJSON(value));
}

const ZERO_HASH = "0".repeat(64);
export { ZERO_HASH };

/** Short, collision-resistant id for in-document objects. */
export function randomId(prefix = "id"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${toHex(bytes)}`;
}

/** ISO-8601 timestamp in UTC, second precision (matches the Python helper). */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
