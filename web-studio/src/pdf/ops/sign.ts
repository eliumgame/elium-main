/**
 * Fill & Sign: producing the signature and initials a user drops onto a page.
 *
 * Three ways in, exactly like Acrobat: draw with the pointer, type a name in a
 * handwriting-style face, or import a picture of a real signature. Imported
 * and photographed signatures go through a background-removal pass so a phone
 * snapshot on white paper lands as clean strokes on the page instead of a grey
 * rectangle.
 *
 * Certificate-based (PAdES/X.509) signing lives in `./pades.ts` (CMS/CAdES over
 * a PKCS#12 signer). This module is only the visual Fill & Sign; Elium also seals
 * documents with its own Ed25519 identity at the `.elium` level.
 */

import type { Pt } from "../core/coords";
import { rectOfPoints } from "../core/coords";

export type SignatureKind = "signature" | "initials";

export interface SavedSignature {
  id: string;
  kind: SignatureKind;
  /** PNG data URL with a transparent background. */
  src: string;
  /** Natural aspect ratio (width / height), for sensible placement. */
  ratio: number;
  createdAt: string;
}

/** Handwriting-ish faces offered by the "type your signature" tab. */
export const SIGNATURE_FONTS: { name: string; css: string; label: string }[] = [
  { name: "Caveat", css: "'Segoe Script', 'Bradley Hand', 'Brush Script MT', cursive", label: "Manuscrite" },
  { name: "Formal", css: "'Palatino Linotype', Palatino, Georgia, serif", label: "Classique" },
  { name: "Elegant", css: "'Snell Roundhand', 'Apple Chancery', 'Lucida Handwriting', cursive", label: "Élégante" },
  { name: "Print", css: "Inter, 'Segoe UI', system-ui, sans-serif", label: "Bâton" },
];

// ---------------------------------------------------------------------------
// Drawn signatures
// ---------------------------------------------------------------------------

/**
 * Rasterise drawn strokes to a trimmed, transparent PNG.
 * `strokes` are in the capture canvas's own pixel space.
 */
export function strokesToPng(
  strokes: readonly Pt[][],
  colour: string,
  width: number,
  padding = 10,
): { src: string; ratio: number } | null {
  const points = strokes.flat();
  if (points.length < 2) return null;
  const bounds = rectOfPoints(points);
  const w = Math.max(1, bounds.w) + padding * 2;
  const h = Math.max(1, bounds.h) + padding * 2;

  const canvas = document.createElement("canvas");
  // Render at 3× so the signature stays crisp when scaled up on a page.
  const scale = 3;
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.translate(padding - bounds.x, padding - bounds.y);
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.2, width);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stroke of strokes) {
    if (stroke.length === 1) {
      ctx.beginPath();
      ctx.arc(stroke[0].x, stroke[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    // Quadratic smoothing through stroke midpoints — the standard trick that
    // turns jittery pointer samples into a natural-looking line.
    for (let i = 1; i < stroke.length - 1; i++) {
      const mid = { x: (stroke[i].x + stroke[i + 1].x) / 2, y: (stroke[i].y + stroke[i + 1].y) / 2 };
      ctx.quadraticCurveTo(stroke[i].x, stroke[i].y, mid.x, mid.y);
    }
    ctx.lineTo(stroke[stroke.length - 1].x, stroke[stroke.length - 1].y);
    ctx.stroke();
  }
  return { src: canvas.toDataURL("image/png"), ratio: w / h };
}

// ---------------------------------------------------------------------------
// Typed signatures
// ---------------------------------------------------------------------------

/** Render typed text in a handwriting face to a transparent PNG. */
export function typedSignatureToPng(text: string, fontCss: string, colour: string): { src: string; ratio: number } | null {
  const body = text.trim();
  if (!body) return null;
  const size = 96;
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) return null;
  measure.font = `${size}px ${fontCss}`;
  const metrics = measure.measureText(body);
  const w = Math.ceil(metrics.width) + 32;
  const h = Math.ceil(size * 1.7);

  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.font = `${size}px ${fontCss}`;
  ctx.fillStyle = colour;
  ctx.textBaseline = "middle";
  ctx.fillText(body, 16, h / 2);
  return { src: canvas.toDataURL("image/png"), ratio: w / h };
}

// ---------------------------------------------------------------------------
// Imported signatures
// ---------------------------------------------------------------------------

/**
 * Turn a photo or scan of a signature into clean strokes on transparency:
 * anything lighter than `threshold` becomes transparent, the remaining ink is
 * recoloured, and the result is trimmed to its bounding box.
 */
export async function cleanImportedSignature(
  src: string,
  opts: { threshold?: number; colour?: string } = {},
): Promise<{ src: string; ratio: number } | null> {
  const threshold = opts.threshold ?? 190;
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = src;
  });
  if (!img) return null;

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);

  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, w, h);
  } catch {
    return { src, ratio: w / h }; // tainted canvas: keep the original
  }

  const px = data.data;
  const ink = opts.colour ? hexToRgb(opts.colour) : null;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let i = 0; i < px.length; i += 4) {
    const luma = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (luma > threshold || px[i + 3] < 24) {
      px[i + 3] = 0;
      continue;
    }
    // Soften the edge so the stroke does not look cut out with scissors.
    const alpha = Math.min(255, Math.round(255 * (1 - luma / threshold) * 1.4 + 40));
    px[i + 3] = alpha;
    if (ink) { px[i] = ink.r; px[i + 1] = ink.g; px[i + 2] = ink.b; }
    const p = i / 4;
    const x = p % w;
    const y = (p / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  ctx.putImageData(data, 0, 0);

  const pad = Math.round(Math.max(w, h) * 0.02);
  const cropW = Math.min(w, maxX - minX + 1 + pad * 2);
  const cropH = Math.min(h, maxY - minY + 1 + pad * 2);
  const out = document.createElement("canvas");
  out.width = cropW;
  out.height = cropH;
  const octx = out.getContext("2d");
  if (!octx) return { src: canvas.toDataURL("image/png"), ratio: w / h };
  octx.drawImage(canvas, Math.max(0, minX - pad), Math.max(0, minY - pad), cropW, cropH, 0, 0, cropW, cropH);
  return { src: out.toDataURL("image/png"), ratio: cropW / cropH };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// ---------------------------------------------------------------------------
// Signature blocks
// ---------------------------------------------------------------------------

/**
 * A visible signature block: the mark plus the "Signé par … le …" caption
 * Acrobat draws under a certified signature. Returned as a PNG so it can be
 * placed like any other stamp.
 */
export function signatureBlockToPng(
  signature: string,
  caption: { name: string; role?: string; date: string; reason?: string; location?: string },
): Promise<{ src: string; ratio: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      const scale = 2;
      const w = 420;
      const h = 150;
      const canvas = document.createElement("canvas");
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }
      ctx.scale(scale, scale);

      ctx.strokeStyle = "#1d4ed8";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      ctx.setLineDash([]);

      const markW = 180;
      const ratio = img.width / img.height || 3;
      const drawH = Math.min(70, markW / ratio);
      const drawW = drawH * ratio;
      ctx.drawImage(img, 16, (h - drawH) / 2, drawW, drawH);

      ctx.fillStyle = "#0f172a";
      ctx.font = "600 13px Inter, system-ui, sans-serif";
      ctx.fillText(caption.name, markW + 28, 36);
      ctx.fillStyle = "#475569";
      ctx.font = "11px Inter, system-ui, sans-serif";
      let y = 56;
      if (caption.role) { ctx.fillText(caption.role, markW + 28, y); y += 16; }
      ctx.fillText(`Signé le ${caption.date}`, markW + 28, y); y += 16;
      if (caption.reason) { ctx.fillText(`Motif : ${caption.reason}`, markW + 28, y); y += 16; }
      if (caption.location) ctx.fillText(`Lieu : ${caption.location}`, markW + 28, y);

      resolve({ src: canvas.toDataURL("image/png"), ratio: w / h });
    };
    img.src = signature;
  });
}
