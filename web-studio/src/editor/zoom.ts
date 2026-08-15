/**
 * Editor zoom — pure geometry.
 *
 * The page sheet has a physical width (210mm for A4), which at 100% is ~794 CSS
 * px and simply does not fit a phone. Word solves this with a zoom control plus
 * "fit width" / "whole page"; this module owns the arithmetic so the component
 * only applies the result.
 *
 * The zoom is applied as a CSS `transform: scale()`, deliberately: transforms do
 * not affect layout, so the pagination engine keeps measuring the same intrinsic
 * block heights and its page plan stays correct at any zoom.
 */

/** Zoom steps offered in the UI, as fractions (1 = 100%). */
export const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2] as const;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

export type ZoomMode = "manual" | "fitWidth" | "fitPage";

export interface ZoomInput {
  /** Usable width of the scroll viewport, in CSS px. */
  viewportWidth: number;
  /** Usable height of the scroll viewport, in CSS px. */
  viewportHeight: number;
  /** Page width at 100%, in CSS px. */
  pageWidth: number;
  /** Page height at 100%, in CSS px (one sheet). */
  pageHeight: number;
  /** Padding to leave around the sheet, in CSS px. */
  gutter?: number;
}

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Scale that makes one page exactly as wide as the viewport (minus gutters). */
export function fitWidthZoom(input: ZoomInput): number {
  const gutter = input.gutter ?? 0;
  const usable = input.viewportWidth - gutter * 2;
  if (!(usable > 0) || !(input.pageWidth > 0)) return 1;
  return clampZoom(usable / input.pageWidth);
}

/** Scale that makes one whole page visible (both dimensions fit). */
export function fitPageZoom(input: ZoomInput): number {
  const gutter = input.gutter ?? 0;
  const usableW = input.viewportWidth - gutter * 2;
  const usableH = input.viewportHeight - gutter * 2;
  if (!(usableW > 0) || !(usableH > 0) || !(input.pageWidth > 0) || !(input.pageHeight > 0)) return 1;
  return clampZoom(Math.min(usableW / input.pageWidth, usableH / input.pageHeight));
}

/** The effective zoom for a mode. `manual` keeps the user's value. */
export function resolveZoom(mode: ZoomMode, manual: number, input: ZoomInput): number {
  switch (mode) {
    case "fitWidth":
      return fitWidthZoom(input);
    case "fitPage":
      return fitPageZoom(input);
    case "manual":
    default:
      return clampZoom(manual);
  }
}

/** Next / previous step, used by the +/− buttons and Ctrl+wheel. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const steps = [...ZOOM_STEPS] as number[];
  if (direction > 0) {
    const next = steps.find((s) => s > current + 0.001);
    return clampZoom(next ?? current * 1.25);
  }
  const prev = [...steps].reverse().find((s) => s < current - 0.001);
  return clampZoom(prev ?? current / 1.25);
}

/**
 * Should the editor fit the page to the width on its own?
 *
 * Only when the sheet genuinely cannot fit — a phone or a narrow pane. On a
 * roomy screen the document stays at 100%, which is what a reader expects.
 */
export function shouldAutoFit(input: ZoomInput): boolean {
  const gutter = input.gutter ?? 0;
  return input.viewportWidth - gutter * 2 < input.pageWidth;
}

/** Percentage label ("100 %"), formatted the French way. */
export function zoomLabel(z: number): string {
  return `${Math.round(z * 100)} %`;
}
