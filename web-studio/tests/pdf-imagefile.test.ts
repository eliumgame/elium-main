import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { zlibSync } from "fflate";
import {
  imageDpi,
  jpegOrientation,
  orientationMatrix,
  pictureSize,
  readTiff,
  withJpegDpi,
  withoutExif,
  withPngDpi,
  writeTiff,
} from "../src/pdf/ops/imagefile";
import { mergeDocuments } from "../src/pdf/ops/organize";

/** Picture files: resolution read and written, TIFF, page size of a scan. */

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A white RGB PNG of `w × h` pixels. */
function png(w: number, h: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(
      [...type].map((c) => c.charCodeAt(0)),
      4,
    );
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array((w * 3 + 1) * h).fill(255);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// A 1×1 baseline JPEG with a JFIF header (density 1:1, no unit).
const JPEG = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  ),
  (c) => c.charCodeAt(0),
);

describe("picture files", () => {
  it("writes and reads the resolution of PNG and JPEG files", () => {
    const p = withPngDpi(png(4, 3), 300);
    expect(imageDpi(p)!.x).toBeCloseTo(300, 0);
    expect(imageDpi(png(4, 3))).toBeNull();
    // The picture still decodes (pHYs placed after IHDR, CRC right).
    expect(imageDpi(withPngDpi(p, 150))!.y).toBeCloseTo(150, 0);
    expect(imageDpi(JPEG)).toBeNull();
    expect(imageDpi(withJpegDpi(JPEG, 200))).toEqual({ x: 200, y: 200 });
  });

  it("TIFF: written with its resolution and read back, page by page", async () => {
    const rgba = new Uint8Array(3 * 2 * 4).fill(200);
    const tif = await writeTiff({ width: 3, height: 2, rgba }, 150);
    expect(imageDpi(tif)).toEqual({ x: 150, y: 150 });
    const [page] = await readTiff(tif);
    expect([page!.width, page!.height]).toEqual([3, 2]);
    expect(page!.dpi!.x).toBeCloseTo(150, 0);
    expect(page!.rgba[0]).toBe(200);
  });

  it("a 300 dpi A4 scan becomes an A4 page, not a 2.5 m one", async () => {
    const size = pictureSize(2480, 3508, { x: 300, y: 300 });
    expect(size.w).toBeCloseTo(595.2, 0);
    expect(size.h).toBeCloseTo(841.9, 0);
    // Unknown resolution: 96 dpi, brought down to A4.
    expect(pictureSize(2480, 3508)).toEqual({ w: 595, h: 842 });
    const merged = await mergeDocuments([{ name: "scan.png", bytes: withPngDpi(png(620, 877), 75) }]);
    const doc = await PDFDocument.load(merged.bytes);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(595.2, 0);
    expect(height).toBeCloseTo(841.9, 0);
  });

  it("reads the EXIF orientation of a phone photo, and draws it upright when combining", async () => {
    // The 1×1 JPEG claiming 40 × 20 pixels (its frame header patched), stored sideways (orientation 6).
    const sof = JPEG.findIndex((b, i) => b === 0xff && JPEG[i + 1] === 0xc0);
    const wide = JPEG.slice();
    wide[sof + 5] = 0;
    wide[sof + 6] = 20;
    wide[sof + 7] = 0;
    wide[sof + 8] = 40;
    const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const app1 = [0xff, 0xe1, 0, body.length + 2, ...body];
    const photo = new Uint8Array([...wide.subarray(0, 2), ...app1, ...wide.subarray(2)]);
    expect(jpegOrientation(photo)).toBe(6);
    expect(jpegOrientation(JPEG)).toBe(1);
    expect(jpegOrientation(withoutExif(photo))).toBe(1);
    expect(withoutExif(photo).length).toBe(wide.length);
    // Turned a quarter clockwise: the stored top-left corner ends top-right.
    const [a, b, c, d, e, f] = orientationMatrix(6, 20, 40);
    expect([a * 0 + c * 1 + e, b * 0 + d * 1 + f]).toEqual([20, 40]);

    const { bytes } = await mergeDocuments([{ name: "photo.jpg", bytes: photo }]);
    const doc = await PDFDocument.load(bytes);
    const { width, height } = doc.getPage(0).getSize();
    expect(height).toBeGreaterThan(width);
  });

  it("refuses a TIFF claiming a huge picture before decoding it", async () => {
    const le = (n: number, b: number) => Array.from({ length: b }, (_, i) => (n >> (8 * i)) & 255);
    const entries = [
      [256, 4, 60000],
      [257, 4, 60000],
      [258, 3, 8],
      [259, 3, 1],
      [262, 3, 1],
      [273, 4, 8 + 2 + 9 * 12 + 4],
      [277, 3, 1],
      [278, 4, 60000],
      [279, 4, 16],
    ];
    const hdr = [0x49, 0x49, 42, 0, ...le(8, 4), ...le(entries.length, 2)];
    for (const [tag, type, val] of entries)
      hdr.push(...le(tag!, 2), ...le(type!, 2), ...le(1, 4), ...(type === 3 ? [...le(val!, 2), 0, 0] : le(val!, 4)));
    hdr.push(0, 0, 0, 0, ...new Array(16).fill(0));
    const t0 = Date.now();
    await expect(readTiff(new Uint8Array(hdr))).rejects.toThrow(/trop grande/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
