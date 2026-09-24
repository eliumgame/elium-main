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
 * the virtualised lists only mount what is on (or near) the screen.
 */

export interface ThumbCanvasProps {
  engine: PdfEngine;
  page: Page;
  /** Rotation baked into the picture: the page's own /Rotate + the user's. */
  rotation: number;
  /** CSS size of the thumbnail. */
  width: number;
  height: number;
  /** Lower renders first (e.g. distance to the middle of the visible list). */
  priority?: number;
  className?: string;
}

export default function ThumbCanvas({
  engine,
  page,
  rotation,
  width,
  height,
  priority = 0,
  className,
}: ThumbCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  const pw = Math.max(1, Math.round(width * dpr));
  const ph = Math.max(1, Math.round(height * dpr));
  // Only read when a request is made: re-prioritising a thumbnail already in
  // flight is not worth cancelling its render.
  const priorityRef = useRef(priority);
  priorityRef.current = priority;

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
    const cancel = service.request({ ...req, priority: priorityRef.current }, draw);
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
