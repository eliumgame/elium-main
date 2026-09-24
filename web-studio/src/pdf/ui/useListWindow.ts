import { useLayoutEffect, useReducer, useRef, useState, type RefObject } from "react";
import { rowRange, type RowStack } from "../core/viewer/virtual";

type Range = { first: number; last: number } | null;

const sameRange = (a: Range, b: Range) => a === b || (!!a && !!b && a.first === b.first && a.last === b.last);

export interface ListWindowOptions {
  /** Extra height mounted above and below the visible part, px. */
  overscan: number;
  /** Distance from the scroll container's top to the rows' origin (its padding), px. */
  offset?: number;
  /** Called on every scroll event (before the band is re-derived at the next frame). */
  onScroll?: () => void;
  /** Size assumed until the container is measured. */
  initial: { width: number; height: number };
}

/**
 * Windowing of a scrolled list of rows (the thumbnail pane, the organiser
 * grid): the container's size, and the band of rows to mount (`band`, given
 * the row stack — which may itself depend on the width).
 *
 * The scroll position lives in a ref, NOT in state: the caller re-renders only
 * when the band of mounted rows (or the size) actually changes — a few times
 * per screenful scrolled, instead of on every scroll frame, which re-rendered
 * every mounted cell each frame.
 */
export function useListWindow(
  ref: RefObject<HTMLElement | null>,
  opts: ListWindowOptions,
): { width: number; height: number; band: (stack: RowStack) => Range } {
  const [size, setSize] = useState(opts.initial);
  const top = useRef(0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const shown = useRef<Range>(null);
  const latest = useRef<{ stack: RowStack | null; opts: ListWindowOptions }>({ stack: null, opts });
  latest.current.opts = opts;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      top.current = el.scrollTop;
      setSize((v) =>
        v.width === el.clientWidth && v.height === el.clientHeight
          ? v
          : { width: el.clientWidth, height: el.clientHeight },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    let frame = 0;
    const onScroll = () => {
      latest.current.opts.onScroll?.();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        top.current = el.scrollTop;
        const { stack: s, opts: o } = latest.current;
        if (!s) return;
        const from = top.current - (o.offset ?? 0);
        if (!sameRange(rowRange(s, from, from + el.clientHeight, o.overscan), shown.current)) rerender();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [ref]);

  /** The rows to mount, for the list's current row stack (call once per render). */
  const band = (stack: RowStack): Range => {
    latest.current.stack = stack;
    const from = top.current - (opts.offset ?? 0);
    const range = rowRange(stack, from, from + size.height, opts.overscan);
    shown.current = range;
    return range;
  };
  return { width: size.width, height: size.height, band };
}
