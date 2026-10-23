/**
 * Zip / unzip COOPÉRATIFS : `zipSync` et `unzipSync` compressent ou inflatent toute l'archive d'un
 * seul bloc (plusieurs secondes pour des centaines de Mo, interface figée). Ici, la compression passe
 * par `Zip`/`ZipDeflate` en flux et la lecture traite l'archive par lots d'entrées, en rendant la
 * main au navigateur entre deux tranches. Les octets produits sont des archives zip standard.
 */
import { Zip, ZipDeflate, unzipSync, type UnzipFileInfo } from "fflate";

const SLICE_MS = 10;
const ZIP_SLICE = 128 * 1024;
/** Taille décompressée maximale traitée entre deux pauses (une entrée plus grosse passe seule). */
const UNZIP_BATCH_BYTES = 8 * 1024 * 1024;

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

/**
 * Lit une archive zip par lots : `filter` décide (comme celui de `unzipSync`) des entrées à extraire et
 * peut lever pour refuser l'archive ; l'extraction se fait lot par lot avec une pause entre deux lots.
 */
export async function unzipCooperative(
  bytes: Uint8Array,
  filter: (info: UnzipFileInfo) => boolean = () => true,
  breathe: () => Promise<void> = makeBreather(),
): Promise<Record<string, Uint8Array>> {
  // 1. Inventaire (aucune décompression) : le filtre de l'appelant s'applique ici, une seule fois par entrée.
  const wanted: { name: string; size: number }[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      if (filter(f)) wanted.push({ name: f.name, size: f.originalSize });
      return false;
    },
  });
  // 2. Extraction par lots d'au plus UNZIP_BATCH_BYTES (octets décompressés).
  const out: Record<string, Uint8Array> = {};
  let i = 0;
  while (i < wanted.length) {
    const names = new Set<string>();
    let size = 0;
    while (i < wanted.length && (names.size === 0 || size + wanted[i]!.size <= UNZIP_BATCH_BYTES)) {
      names.add(wanted[i]!.name);
      size += wanted[i]!.size;
      i++;
    }
    Object.assign(out, unzipSync(bytes, { filter: (f) => names.has(f.name) }));
    await breathe();
  }
  return out;
}
