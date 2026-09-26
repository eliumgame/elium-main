/**
 * Picture files chosen or dropped by the user, made into page pictures: PNG
 * and JPEG kept as they are, TIFF (every page of it) and the formats a PDF
 * cannot embed (WebP, GIF, BMP…) converted to PNG — each with the page size
 * its resolution gives (a 300 dpi A4 scan is an A4 page).
 */
import { imageKind } from "../ops/organize";
import { imageDpi, isTiff, pictureSize, readTiff, withPngDpi, type RgbaImage } from "../ops/imagefile";

export interface PagePicture {
  /** PNG or JPEG bytes. */
  bytes: Uint8Array;
  /** Data URL of `bytes`. */
  src: string;
  /** Page size in points. */
  size: { w: number; h: number };
}

function dataUrl(bytes: Uint8Array, type: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

async function canvasPng(draw: (c: HTMLCanvasElement) => void, w: number, h: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("image illisible");
  return new Uint8Array(await blob.arrayBuffer());
}

async function rgbaPng(img: RgbaImage): Promise<Uint8Array> {
  return canvasPng(
    (c) => {
      const pixels = new Uint8ClampedArray(img.width * img.height * 4);
      pixels.set(img.rgba.subarray(0, pixels.length));
      const data = new ImageData(pixels, img.width, img.height);
      c.getContext("2d")!.putImageData(data, 0, 0);
    },
    img.width,
    img.height,
  );
}

function pixelSize(bytes: Uint8Array, kind: "png" | "jpg"): { w: number; h: number } | null {
  if (kind === "png") {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  for (let at = 2; at + 9 < bytes.length && bytes[at] === 0xff;) {
    const m = bytes[at + 1]!;
    const len = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    // Start of frame (baseline, progressive…): height then width.
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (bytes[at + 5]! << 8) | bytes[at + 6]!, w: (bytes[at + 7]! << 8) | bytes[at + 8]! };
    }
    at += 2 + len;
  }
  return null;
}

/** The page pictures of one file (several for a multi-page TIFF); empty when unreadable. */
export async function pagePictures(file: Blob): Promise<PagePicture[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = imageKind(bytes);
  if (kind) {
    const px = pixelSize(bytes, kind);
    if (px) {
      return [
        {
          bytes,
          src: dataUrl(bytes, kind === "png" ? "image/png" : "image/jpeg"),
          size: pictureSize(px.w, px.h, imageDpi(bytes)),
        },
      ];
    }
  }
  if (isTiff(bytes)) {
    const out: PagePicture[] = [];
    for (const page of await readTiff(bytes)) {
      let png = await rgbaPng(page);
      if (page.dpi) png = withPngDpi(png, page.dpi.x);
      out.push({ bytes: png, src: dataUrl(png, "image/png"), size: pictureSize(page.width, page.height, page.dpi) });
    }
    return out;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const png = await canvasPng((c) => c.getContext("2d")!.drawImage(bitmap, 0, 0), bitmap.width, bitmap.height);
    const size = pictureSize(bitmap.width, bitmap.height);
    bitmap.close();
    return [{ bytes: png, src: dataUrl(png, "image/png"), size }];
  } catch {
    return [];
  }
}
