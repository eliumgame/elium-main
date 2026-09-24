import { useEffect, useRef } from "react";
import type { PdfEngine } from "../core/engine";
import { drawContained, pictureBitmap, thumbnailsFor } from "../core/thumbs";
import type { Page } from "../model/types";

/**
 * One page thumbnail, drawn straight into a `<canvas>` by the shared
 * thumbnail service (`core/thumbs.ts`): no `data:` / `blob:` URL is ever
 * created, so nothing depends on the desktop CSP's `img-src`, and a thumbnail
 * already rendered (by the side panel or the organiser) shows instantly.
 *
 * The request is made when the canvas mounts and cancelled when it unmounts —
 * the virtualised lists only mount what is on (or near) the screen. Its
 * priority is where the canvas is NOW relative to the visible part of its
 * list (asked each time the service picks the next thumbnail): after a scroll
 * the thumbnails on screen are drawn first, then the nearest ones — not the
 * ones that happened to be requested first.
 */

/** Nearest scrolled ancestor: the list the thumbnail lives in. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (overflow === "auto" || overflow === "scroll") return p;
  }
  return null;
}

/**
 * On screen: in [0, 1), top to bottom. Off screen: 1 + its distance to the
 * visible part, in px. Detached: last.
 */
function screenPriority(canvas: HTMLCanvasElement, root: HTMLElement | null): number {
  if (!canvas.isConnected) return Number.MAX_VALUE;
  const r = canvas.getBoundingClientRect();
  const v = root ? root.getBoundingClientRect() : { top: 0, bottom: globalThis.innerHeight || 0 };
  if (r.bottom > v.top && r.top < v.bottom) return (0.999 * Math.max(0, r.top - v.top)) / Math.max(1, v.bottom - v.top);
  return 1 + (r.bottom <= v.top ? v.top - r.bottom : r.top - v.bottom);
}

export interface ThumbCanvasProps {
  engine: PdfEngine;
  page: Page;
  /** Rotation baked into the picture: the page's own /Rotate + the user's. */
  rotation: number;
  /** CSS size of the thumbnail. */
  width: number;
  height: number;
  className?: string;
}

export default function ThumbCanvas({ engine, page, rotation, width, height, className }: ThumbCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  const pw = Math.max(1, Math.round(width * dpr));
  const ph = Math.max(1, Math.round(height * dpr));

  const from = page.from;
  const image = page.image;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let alive = true;
    const draw = (bmp: ImageBitmap) => {
      if (alive && ref.current === canvas) drawContained(canvas, bmp);
    };
    const blank = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };
    if (from == null) {
      blank();
      if (image) void pictureBitmap(image).then(draw, () => {});
      return () => {
        alive = false;
      };
    }
    const service = thumbnailsFor(engine);
    const req = { from, rotation, width: pw };
    const hit = service.peek(req);
    if (hit) {
      draw(hit);
      return () => {
        alive = false;
      };
    }
    blank();
    let root: HTMLElement | null | undefined;
    const priority = () => screenPriority(canvas, (root ??= scrollParent(canvas)));
    const cancel = service.request({ ...req, priority }, draw);
    return () => {
      alive = false;
      cancel();
    };
  }, [engine, from, image, rotation, pw, ph]);

  return (
    <canvas
      ref={ref}
      className={className}
      width={pw}
      height={ph}
      style={{ width, height, display: "block" }}
      aria-hidden
    />
  );
}
