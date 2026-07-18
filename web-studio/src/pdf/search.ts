/**
 * Pure helpers for in-reader PDF text search. The heavy lifting (extracting a
 * page's text via pdf.js, positioning the selectable text layer) happens in the
 * view; these functions decide, from already-extracted per-page text, where the
 * matches are — so they are unit-testable without pdf.js or a DOM.
 */

/** A single match: which page (0-based) and the character offset within it. */
export interface PdfMatch {
  page: number;
  index: number;
}

/** All matches of `query` across the per-page texts, in reading order. */
export function findMatches(pageTexts: string[], query: string): PdfMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: PdfMatch[] = [];
  pageTexts.forEach((text, page) => {
    const hay = text.toLowerCase();
    let from = 0;
    for (;;) {
      const i = hay.indexOf(q, from);
      if (i < 0) break;
      out.push({ page, index: i });
      from = i + q.length;
    }
  });
  return out;
}

/** Match count per page (for the sidebar / navigation), plus the total. */
export function matchCountsByPage(pageTexts: string[], query: string): { counts: number[]; total: number } {
  const counts = pageTexts.map(() => 0);
  let total = 0;
  for (const m of findMatches(pageTexts, query)) {
    counts[m.page] = (counts[m.page] ?? 0) + 1;
    total++;
  }
  return { counts, total };
}

/** Does a text span (one text-layer token) contain the query? (coarse highlight) */
export function spanMatches(spanText: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !!q && spanText.toLowerCase().includes(q);
}
