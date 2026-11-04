/**
 * Zip / unzip COOPÉRATIFS : `zipSync` et `unzipSync` compressent ou inflatent toute l'archive d'un
 * seul bloc (plusieurs secondes pour des centaines de Mo, interface figée). Ici, la compression passe
 * par `Zip`/`ZipDeflate` en flux et la lecture traite l'archive par lots d'entrées, en rendant la
 * main au navigateur entre deux tranches. Les octets produits sont des archives zip standard.
 */
import { Zip, ZipDeflate, Unzip, UnzipInflate, unzipSync, type UnzipFileInfo } from "fflate";

const SLICE_MS = 10;
const ZIP_SLICE = 128 * 1024;
const UNZIP_STEP = 1024; // deflate expansion per push remains bounded.

const nextTurn = () => new Promise<void>((r) => setTimeout(r, 0));

/** Fabrique un « respire » : rend la main si la tranche courante dépasse `SLICE_MS`. */
export function makeBreather(): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < SLICE_MS) return;
    await nextTurn();
    last = performance.now();
  };
}

/** Archive zip des `files` (niveau de compression `level`), compressée par tranches. */
export async function zipCooperative(
  files: Record<string, Uint8Array>,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
  breathe: () => Promise<void> = makeBreather(),
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else chunks.push(chunk);
  });
  for (const [name, data] of Object.entries(files)) {
    const entry = new ZipDeflate(name, { level });
    zip.add(entry);
    if (data.length === 0) entry.push(data, true);
    for (let at = 0; at < data.length; at += ZIP_SLICE) {
      const end = Math.min(data.length, at + ZIP_SLICE);
      entry.push(data.subarray(at, end), end >= data.length);
      await breathe();
    }
  }
  zip.end();
  if (failure) throw failure;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export interface ZipReadLimits {
  entryBytes: number;
  totalBytes: number;
  entries: number;
}
// Preserve workspace-backup ceilings; office callers pass stricter limits.
const DEFAULT_READ_LIMITS: ZipReadLimits = {
  entryBytes: 256 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  entries: 50_000,
};

function boundedReader(bytes: Uint8Array, filter: (info: UnzipFileInfo) => boolean, limits: ZipReadLimits) {
  const inventory = new Map<string, UnzipFileInfo>();
  const selected = new Set<string>();
  let declared = 0;
  unzipSync(bytes, {
    filter: (f) => {
      if (inventory.has(f.name)) throw new Error("Archive ZIP invalide : entrée dupliquée.");
      if (inventory.size >= limits.entries) throw new Error("Archive ZIP trop volumineuse : trop d'entrées.");
      if (!Number.isSafeInteger(f.originalSize) || f.originalSize < 0 || f.originalSize > limits.entryBytes)
        throw new Error("Archive ZIP : entrée trop volumineuse.");
      declared += f.originalSize;
      if (declared > limits.totalBytes) throw new Error("Archive ZIP : contenu décompressé trop volumineux.");
      inventory.set(f.name, f);
      if (filter(f)) selected.add(f.name);
      return false;
    },
  });
  const out: Record<string, Uint8Array> = Object.create(null);
  const seen = new Set<string>();
  let expanded = 0;
  const unzip = new Unzip((file) => {
    const expected = inventory.get(file.name);
    if (
      !expected ||
      seen.has(file.name) ||
      file.compression !== expected.compression ||
      (file.originalSize != null && file.originalSize !== expected.originalSize) ||
      (file.size != null && file.size !== expected.size)
    )
      throw new Error("Archive ZIP incohérente.");
    seen.add(file.name);
    if (!selected.has(file.name)) {
      file.terminate();
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      size += chunk.length;
      expanded += chunk.length;
      if (size > expected.originalSize || size > limits.entryBytes || expanded > limits.totalBytes)
        throw new Error("Archive ZIP : taille décompressée incorrecte ou trop volumineuse.");
      chunks.push(chunk);
      if (final) {
        if (size !== expected.originalSize) throw new Error("Archive ZIP : taille décompressée incorrecte.");
        const data = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          data.set(c, offset);
          offset += c.length;
        }
        chunks.length = 0;
        out[file.name] = data;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  return {
    push: (at: number) => unzip.push(bytes.subarray(at, at + UNZIP_STEP), at + UNZIP_STEP >= bytes.length),
    result: () => {
      for (const name of selected)
        if (!Object.prototype.hasOwnProperty.call(out, name)) throw new Error("Archive ZIP incomplète.");
      return out;
    },
  };
}

/** Validates the full directory, then bounds actual streamed output as well. */
export function unzipBoundedSync(
  bytes: Uint8Array,
  filter: (info: UnzipFileInfo) => boolean = () => true,
  limits: ZipReadLimits = DEFAULT_READ_LIMITS,
): Record<string, Uint8Array> {
  const reader = boundedReader(bytes, filter, limits);
  for (let at = 0; at < bytes.length; at += UNZIP_STEP) reader.push(at);
  return reader.result();
}

/** Same validation and output limits, yielding between short inflate slices. */
export async function unzipCooperative(
  bytes: Uint8Array,
  filter: (info: UnzipFileInfo) => boolean = () => true,
  breathe: () => Promise<void> = makeBreather(),
  limits: ZipReadLimits = DEFAULT_READ_LIMITS,
): Promise<Record<string, Uint8Array>> {
  const reader = boundedReader(bytes, filter, limits);
  for (let at = 0; at < bytes.length; at += UNZIP_STEP) {
    reader.push(at);
    await breathe();
  }
  return reader.result();
}
