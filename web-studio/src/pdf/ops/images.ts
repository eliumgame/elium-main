/**
 * Image embedding for export.
 *
 * pdf-lib only speaks PNG and JPEG, but users paste WebP, GIF, SVG and whatever
 * their screenshot tool produced. Anything else is transcoded through a canvas
 * first, so "insert image" simply works. Embeds are cached per document because
 * the same signature or stamp is usually placed on many pages.
 */

import type { PDFDocument, PDFImage } from "pdf-lib";

const PNG = "image/png";

/** Split a data URL into its mime type and bytes. */
export function parseDataUrl(src: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
  if (!m) return null;
  const mime = (m[1] || "application/octet-stream").toLowerCase();
  const body = m[3] ?? "";
  if (m[2]) {
    try {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { mime, bytes };
    } catch {
      return null;
    }
  }
  const text = decodeURIComponent(body);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return { mime, bytes };
}

/** Natural pixel size of a data-URL image. */
export function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
    img.onerror = () => reject(new Error("image illisible"));
    img.src = src;
  });
}

/** Re-encode any browser-decodable image as a PNG data URL. */
export async function toPngDataUrl(src: string, maxSide = 4096): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("image illisible"));
    el.src = src;
  });
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / Math.max(w, h, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas indisponible");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(PNG);
}

/** Embeds images into one output document, de-duplicating identical sources. */
export class ImageBank {
  private cache = new Map<string, Promise<PDFImage | null>>();

  constructor(private readonly doc: PDFDocument) {}

  /** Embed a data URL; resolves to null when the picture cannot be read. */
  get(src: string): Promise<PDFImage | null> {
    let hit = this.cache.get(src);
    if (!hit) {
      hit = this.embed(src).catch(() => null);
      this.cache.set(src, hit);
    }
    return hit;
  }

  private async embed(src: string): Promise<PDFImage | null> {
    const parsed = parseDataUrl(src);
    if (parsed?.mime === "image/png") return this.doc.embedPng(parsed.bytes);
    if (parsed?.mime === "image/jpeg" || parsed?.mime === "image/jpg") {
      try {
        return await this.doc.embedJpg(parsed.bytes);
      } catch {
        // Some "JPEG"s are progressive or CMYK; go through the canvas instead.
      }
    }
    const png = await toPngDataUrl(src);
    const asPng = parseDataUrl(png);
    return asPng ? this.doc.embedPng(asPng.bytes) : null;
  }
}
