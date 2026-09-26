/**
 * Picture files around PDF pages: their resolution (so a 300 dpi scan becomes
 * an A4 page, not a 2.5 m one), TIFF reading and writing (scanners' format,
 * multi-page), and the resolution written into exported PNG / JPEG / TIFF
 * files (so an image editor or a printer shows them at their real size).
 */

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const be16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const be32 = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** Horizontal and vertical resolution in dots per inch, when the file says. */
export function imageDpi(bytes: Uint8Array): { x: number; y: number } | null {
  const sane = (v: { x: number; y: number } | null) =>
    v && v.x >= 20 && v.y >= 20 && v.x <= 10_000 && v.y <= 10_000 ? v : null;
  // PNG: pHYs (pixels per metre, unit 1).
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    for (let at = 8; at + 12 <= bytes.length;) {
      const len = be32(bytes, at);
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      if (type === "pHYs" && len >= 9 && bytes[at + 16] === 1) {
        return sane({ x: be32(bytes, at + 8) * 0.0254, y: be32(bytes, at + 12) * 0.0254 });
      }
      if (type === "IDAT" || type === "IEND") break;
      at += 12 + len;
    }
    return null;
  }
  // JPEG: JFIF density, or EXIF X/YResolution.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff;) {
      const marker = bytes[at + 1]!;
      if (marker === 0xda || marker === 0xd9) break;
      const len = be16(bytes, at + 2);
      const seg = bytes.subarray(at + 4, at + 2 + len);
      if (marker === 0xe0 && String.fromCharCode(...seg.subarray(0, 4)) === "JFIF") {
        const units = seg[7];
        const x = be16(seg, 8);
        const y = be16(seg, 10);
        if (units === 1) return sane({ x, y });
        if (units === 2) return sane({ x: x * 2.54, y: y * 2.54 });
      }
      if (marker === 0xe1 && String.fromCharCode(...seg.subarray(0, 4)) === "Exif") {
        const d = tiffResolution(seg.subarray(6));
        if (d) return sane(d);
      }
      at += 2 + len;
    }
    return null;
  }
  // TIFF.
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d))
    return sane(tiffResolution(bytes));
  return null;
}

/** X/YResolution and ResolutionUnit of a TIFF header's first directory. */
function tiffResolution(t: Uint8Array): { x: number; y: number } | null {
  if (t.length < 8) return null;
  const le = t[0] === 0x49;
  const u16 = (at: number) => (le ? t[at]! | (t[at + 1]! << 8) : be16(t, at));
  const u32 = (at: number) =>
    le ? (t[at]! | (t[at + 1]! << 8) | (t[at + 2]! << 16) | (t[at + 3]! << 24)) >>> 0 : be32(t, at);
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const n = u16(ifd);
  let x = 0;
  let y = 0;
  let unit = 2;
  const rational = (at: number) => {
    const off = u32(at);
    if (off + 8 > t.length) return 0;
    const den = u32(off + 4);
    return den ? u32(off) / den : 0;
  };
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    const tag = u16(e);
    if (tag === 282) x = rational(e + 8);
    else if (tag === 283) y = rational(e + 8);
    else if (tag === 296) unit = u16(e + 8);
  }
  if (!x || !y || unit === 1) return null;
  return unit === 3 ? { x: x * 2.54, y: y * 2.54 } : { x, y };
}

// ---------------------------------------------------------------------------
// EXIF orientation (phones store a photo sideways and say how to turn it)
// ---------------------------------------------------------------------------

/** The EXIF orientation of a JPEG (1 to 8), 1 when it says nothing. */
export function jpegOrientation(bytes: Uint8Array): number {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return 1;
  for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff;) {
    const marker = bytes[at + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const len = be16(bytes, at + 2);
    const seg = bytes.subarray(at + 4, at + 2 + len);
    if (marker === 0xe1 && String.fromCharCode(...seg.subarray(0, 4)) === "Exif") {
      const t = seg.subarray(6);
      if (t.length < 8) return 1;
      const le = t[0] === 0x49;
      const u16 = (i: number) => (le ? t[i]! | (t[i + 1]! << 8) : be16(t, i));
      const ifd = le ? (t[4]! | (t[5]! << 8) | (t[6]! << 16) | (t[7]! << 24)) >>> 0 : be32(t, 4);
      if (ifd + 2 > t.length) return 1;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > t.length) break;
        if (u16(e) === 0x112) {
          const o = u16(e + 8);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    at += 2 + len;
  }
  return 1;
}

/** Does this orientation turn the picture a quarter (width and height swapped)? */
export const orientationSwaps = (o: number) => o >= 5 && o <= 8;

/**
 * The matrix drawing a picture's unit square upright into a `w × h` box
 * (the box already in the upright orientation), for EXIF orientation `o`.
 */
export function orientationMatrix(o: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (o) {
    case 2: return [-w, 0, 0, h, w, 0];
    case 3: return [-w, 0, 0, -h, w, h];
    case 4: return [w, 0, 0, -h, 0, h];
    case 5: return [0, -h, -w, 0, w, h];
    case 6: return [0, -h, w, 0, 0, h];
    case 7: return [0, h, w, 0, 0, 0];
    case 8: return [0, h, -w, 0, w, 0];
    default: return [w, 0, 0, h, 0, 0];
  }
}

/** The JPEG without its EXIF segments (a decoder then shows the pixels as stored, like a PDF viewer). */
export function withoutExif(bytes: Uint8Array): Uint8Array {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return bytes;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  let dropped = false;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const len = be16(bytes, at + 2);
    const isExif = marker === 0xe1 && String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === "Exif";
    if (isExif) dropped = true;
    else parts.push(bytes.subarray(at, at + 2 + len));
    at += 2 + len;
  }
  if (!dropped) return bytes;
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing the resolution into exported files
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const put32 = (b: Uint8Array, at: number, v: number) => {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
};

/** A PNG with a pHYs chunk saying `dpi` (any previous one replaced). */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (!(png[0] === 0x89 && png[1] === 0x50)) return png;
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  put32(chunk, 0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  put32(chunk, 8, ppm);
  put32(chunk, 12, ppm);
  chunk[16] = 1;
  put32(chunk, 17, crc32(chunk.subarray(4, 17)));
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  for (let at = 8; at + 12 <= png.length;) {
    const len = be32(png, at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const whole = png.subarray(at, at + 12 + len);
    if (type !== "pHYs") parts.push(whole);
    if (type === "IHDR") parts.push(chunk);
    at += 12 + len;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A JPEG whose JFIF header says `dpi` (a JFIF header added when there is none). */
export function withJpegDpi(jpg: Uint8Array, dpi: number): Uint8Array {
  if (!(jpg[0] === 0xff && jpg[1] === 0xd8)) return jpg;
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  if (jpg[2] === 0xff && jpg[3] === 0xe0 && String.fromCharCode(...jpg.subarray(6, 10)) === "JFIF") {
    const out = jpg.slice();
    out[13] = 1;
    out[14] = d >> 8;
    out[15] = d & 0xff;
    out[16] = d >> 8;
    out[17] = d & 0xff;
    return out;
  }
  const app0 = new Uint8Array([
    0xff,
    0xe0,
    0,
    16,
    0x4a,
    0x46,
    0x49,
    0x46,
    0,
    1,
    1,
    1,
    d >> 8,
    d & 0xff,
    d >> 8,
    d & 0xff,
    0,
    0,
  ]);
  const out = new Uint8Array(jpg.length + app0.length);
  out.set(jpg.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(jpg.subarray(2), 2 + app0.length);
  return out;
}

// ---------------------------------------------------------------------------
// TIFF
// ---------------------------------------------------------------------------

export function isTiff(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a)
  );
}

export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
  dpi?: { x: number; y: number };
}

/** Largest TIFF page decoded (an A3 scan at 600 dpi is 70 megapixels). */
export const TIFF_MAX_PIXELS = 100_000_000;
const TIFF_MAX_SIDE = 32_000;

/** Every page of a TIFF file, as RGBA pixels (throws on a page too large to decode). */
export async function readTiff(bytes: Uint8Array): Promise<RgbaImage[]> {
  const UTIF = (await import("utif2")).default ?? (await import("utif2"));
  const buf = bytes.slice().buffer;
  const ifds = UTIF.decode(buf);
  const out: RgbaImage[] = [];
  for (const ifd of ifds) {
    // Thumbnails (NewSubfileType 1) are not pages.
    const sub = ifd.t254 as number[] | undefined;
    if (sub && sub[0] === 1) continue;
    // The size is checked before decoding: a few bytes can claim a 60 000 × 60 000 picture.
    const w = (ifd.t256 as number[] | undefined)?.[0] ?? 0;
    const h = (ifd.t257 as number[] | undefined)?.[0] ?? 0;
    if (w > TIFF_MAX_SIDE || h > TIFF_MAX_SIDE || w * h > TIFF_MAX_PIXELS)
      throw new Error(`Image TIFF trop grande (${w} × ${h} pixels).`);
    UTIF.decodeImage(buf, ifd);
    if (!ifd.width || !ifd.height) continue;
    const x = resolutionOf(ifd.t282);
    const y = resolutionOf(ifd.t283) || x;
    const unit = (ifd.t296 as number[] | undefined)?.[0] ?? 2;
    const k = unit === 3 ? 2.54 : 1;
    out.push({
      width: ifd.width,
      height: ifd.height,
      rgba: new Uint8Array(UTIF.toRGBA8(ifd)),
      dpi: x && unit !== 1 ? { x: x * k, y: y * k } : undefined,
    });
  }
  return out;
}

function resolutionOf(v: unknown): number {
  if (!Array.isArray(v) || !v.length) return 0;
  const first = v[0] as unknown;
  if (Array.isArray(first)) return first[1] ? Number(first[0]) / Number(first[1]) : 0;
  return v.length >= 2 && Number(v[1]) ? Number(v[0]) / Number(v[1]) : Number(first) || 0;
}

/** A single-page, uncompressed TIFF of RGBA pixels at `dpi`. */
export async function writeTiff(img: RgbaImage, dpi: number): Promise<Uint8Array> {
  const UTIF = (await import("utif2")).default ?? (await import("utif2"));
  const r = Math.round(dpi);
  const meta = { t282: [[r, 1]], t283: [[r, 1]], t296: [2] } as unknown as Parameters<typeof UTIF.encodeImage>[3];
  return new Uint8Array(UTIF.encodeImage(img.rgba, img.width, img.height, meta));
}

/**
 * The page size (points) of a picture of `w × h` pixels: its real size when
 * the file gives its resolution; otherwise its size at 96 dpi (as a screen
 * shows it), a large one brought down to fit A4 in its orientation.
 */
export function pictureSize(w: number, h: number, dpi?: { x: number; y: number } | null): { w: number; h: number } {
  if (dpi) return { w: Math.max(1, (w * 72) / dpi.x), h: Math.max(1, (h * 72) / dpi.y) };
  let pw = (w * 72) / 96;
  let ph = (h * 72) / 96;
  const [a4w, a4h] = pw > ph ? [842, 595] : [595, 842];
  const k = Math.min(1, a4w / pw, a4h / ph);
  pw = Math.max(1, Math.round(pw * k));
  ph = Math.max(1, Math.round(ph * k));
  return { w: pw, h: ph };
}
