/**
 * Morph transition renderer. Interpolates element geometry (position, size,
 * rotation, opacity) between two consecutive slides, so shapes/text smoothly
 * glide and resize from their previous to their next state — the real "Morph"
 * (vs. the old CSS fade approximation). Elements are paired by `morphKey ?? id`
 * (a duplicate-then-nudge workflow pairs them); unmatched elements cross-fade.
 * Renders through the shared SlideCanvas by feeding it interpolated elements, so
 * it reuses the exact shape/text/image rendering.
 */
import { useEffect, useRef, useState } from "react";
import SlideCanvas from "./canvas";
import { elementsOf, type Slide, type SlideElement, type SlideTheme } from "./model";

const keyOf = (e: SlideElement) => e.morphKey ?? e.id;

export default function MorphCanvas({ prev, next, theme, scale, durationMs = 550, onDone }: {
  prev: Slide; next: Slide; theme: SlideTheme; scale: number; durationMs?: number; onDone?: () => void;
}) {
  const [t, setT] = useState(0);
  const doneRef = useRef(onDone); doneRef.current = onDone;

  useEffect(() => {
    let raf = 0; let start = 0;
    const tick = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / durationMs);
      setT(p);
      if (p < 1) raf = requestAnimationFrame(tick);
      else doneRef.current?.();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [durationMs]);

  const prevEls = prev.elements ?? elementsOf(prev);
  const nextEls = next.elements ?? elementsOf(next);
  const prevByKey = new Map(prevEls.map((e) => [keyOf(e), e]));
  const nextByKey = new Map(nextEls.map((e) => [keyOf(e), e]));
  const lerp = (a: number, b: number) => a + (b - a) * t;

  const display: SlideElement[] = [];
  for (const n of nextEls) {
    const p = prevByKey.get(keyOf(n));
    if (p) {
      display.push({
        ...n,
        x: lerp(p.x, n.x), y: lerp(p.y, n.y), w: lerp(p.w, n.w), h: lerp(p.h, n.h),
        rotation: lerp(p.rotation ?? 0, n.rotation ?? 0),
        opacity: lerp(p.opacity ?? 1, n.opacity ?? 1),
      });
    } else {
      display.push({ ...n, opacity: (n.opacity ?? 1) * t }); // fade in
    }
  }
  for (const p of prevEls) {
    if (!nextByKey.has(keyOf(p))) display.push({ ...p, opacity: (p.opacity ?? 1) * (1 - t) }); // fade out
  }

  return <SlideCanvas slide={next} elements={display} theme={theme} scale={scale} />;
}
