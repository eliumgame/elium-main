/**
 * Physical page dimensions in millimetres, portrait orientation. The single
 * source of truth for on-screen page sizing — extend this table (and the
 * `PageFormat` union in ./types) when adding a new format instead of
 * hand-writing width/height elsewhere.
 *
 * `Custom` is the escape hatch: its dimensions live on the document
 * (`PageSettings.customWidthMm` / `customHeightMm`) rather than in this table,
 * so `pageSizeMm` takes the settings object when the format is `Custom`.
 */
import type { PageFormat, PageOrientation, PageSettings } from "./types";

export const PAGE_SIZES_MM: Record<Exclude<PageFormat, "Custom">, { width: number; height: number }> = {
  A3: { width: 297, height: 420 },
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  A6: { width: 105, height: 148 },
  B5: { width: 176, height: 250 },
  Letter: { width: 216, height: 279 },
  Legal: { width: 216, height: 356 },
  Executive: { width: 184, height: 267 },
  Tabloid: { width: 279, height: 432 },
};

/** Labels shown in the page-setup dialog. */
export const PAGE_FORMAT_LABELS: Record<PageFormat, string> = {
  A3: "A3 (297 × 420 mm)",
  A4: "A4 (210 × 297 mm)",
  A5: "A5 (148 × 210 mm)",
  A6: "A6 (105 × 148 mm)",
  B5: "B5 (176 × 250 mm)",
  Letter: "Letter (216 × 279 mm)",
  Legal: "Legal (216 × 356 mm)",
  Executive: "Executive (184 × 267 mm)",
  Tabloid: "Tabloid (279 × 432 mm)",
  Custom: "Personnalisé…",
};

/** Order shown in the dialog: metric family, then the US family, then custom. */
export const PAGE_FORMATS: PageFormat[] = [
  "A3",
  "A4",
  "A5",
  "A6",
  "B5",
  "Letter",
  "Legal",
  "Executive",
  "Tabloid",
  "Custom",
];

export const MIN_PAGE_MM = 50;
export const MAX_PAGE_MM = 1200;

export const DEFAULT_CUSTOM_MM = { width: 210, height: 297 };

const clampMm = (v: unknown, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_PAGE_MM, Math.max(MIN_PAGE_MM, n));
};

/** Portrait dimensions of a format, custom sizes included. */
export function formatSizeMm(
  format: PageFormat,
  custom?: { widthMm?: number; heightMm?: number },
): { width: number; height: number } {
  if (format === "Custom") {
    return {
      width: clampMm(custom?.widthMm, DEFAULT_CUSTOM_MM.width),
      height: clampMm(custom?.heightMm, DEFAULT_CUSTOM_MM.height),
    };
  }
  return PAGE_SIZES_MM[format] ?? PAGE_SIZES_MM.A4;
}

/**
 * Physical page size in mm for a format+orientation pair (width/height swapped
 * for landscape). Pass the whole `PageSettings` (or a section's resolved setup)
 * so a `Custom` format can read its own dimensions.
 */
export function pageSizeMm(
  format: PageFormat,
  orientation: PageOrientation,
  custom?: { widthMm?: number; heightMm?: number },
): { width: number; height: number } {
  const { width, height } = formatSizeMm(format, custom);
  return orientation === "landscape" ? { width: height, height: width } : { width, height };
}

/** Convenience: the size of a document's (or section's) page settings. */
export function pageSizeOf(page: Pick<PageSettings, "format" | "orientation" | "customWidthMm" | "customHeightMm">): {
  width: number;
  height: number;
} {
  return pageSizeMm(page.format, page.orientation, {
    widthMm: page.customWidthMm,
    heightMm: page.customHeightMm,
  });
}
