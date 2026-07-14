/**
 * Physical page dimensions in millimetres, portrait orientation. The single
 * source of truth for on-screen page sizing — extend this table (and the
 * `PageFormat` union in ./types) when adding a new format instead of
 * hand-writing width/height elsewhere.
 */
import type { PageFormat, PageOrientation } from "./types";

export const PAGE_SIZES_MM: Record<PageFormat, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  Letter: { width: 216, height: 279 },
};

/** Physical page size in mm for a format+orientation pair (width/height swapped for landscape). */
export function pageSizeMm(format: PageFormat, orientation: PageOrientation): { width: number; height: number } {
  const { width, height } = PAGE_SIZES_MM[format];
  return orientation === "landscape" ? { width: height, height: width } : { width, height };
}
