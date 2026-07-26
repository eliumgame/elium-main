/**
 * Comparing two PDFs — Acrobat's "Compare files".
 *
 * A word-level diff over the extracted text, aligned page by page so the
 * report says "page 4: this sentence was replaced" rather than dumping one
 * enormous diff. The alignment is itself a diff (over per-page text
 * fingerprints), so an inserted or deleted page does not desynchronise
 * everything after it.
 */

export type ChangeKind = "equal" | "insert" | "delete" | "replace";

export interface WordChange {
  kind: ChangeKind;
  /** Words from the left/original document. */
  left: string[];
  /** Words from the right/revised document. */
  right: string[];
  /** Word offset within the page, for highlighting. */
  leftAt: number;
  rightAt: number;
}

export interface PageComparison {
  /** 1-based page in the left document, or null when the page was added. */
  leftPage: number | null;
  /** 1-based page in the right document, or null when the page was removed. */
  rightPage: number | null;
  status: "unchanged" | "modified" | "added" | "removed";
  changes: WordChange[];
  /** 0..1 — how much of the page is identical. */
  similarity: number;
}

export interface ComparisonReport {
  pages: PageComparison[];
  wordsAdded: number;
  wordsRemoved: number;
  pagesAdded: number;
  pagesRemoved: number;
  pagesModified: number;
  /** 0..1 over the whole document. */
  similarity: number;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

export function tokenise(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/**
 * Longest-common-subsequence diff. Falls back to a coarse, linear alignment
 * when the inputs are large enough that the O(n·m) table would be a problem —
 * a 400-page legal comparison must not hang the tab.
 */
export function diffTokens(a: readonly string[], b: readonly string[]): WordChange[] {
  if (a.length * b.length > 4_000_000) return coarseDiff(a, b);

  const n = a.length;
  const m = b.length;
  // Trim the common prefix/suffix first: most pages barely change.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const subA = a.slice(start, endA);
  const subB = b.slice(start, endB);
  const out: WordChange[] = [];
  if (start > 0) out.push({ kind: "equal", left: a.slice(0, start), right: b.slice(0, start), leftAt: 0, rightAt: 0 });

  if (subA.length && subB.length && subA.length * subB.length <= 4_000_000) {
    const table: Uint32Array = new Uint32Array((subA.length + 1) * (subB.length + 1));
    const w = subB.length + 1;
    for (let i = subA.length - 1; i >= 0; i--) {
      for (let j = subB.length - 1; j >= 0; j--) {
        table[i * w + j] = subA[i] === subB[j]
          ? table[(i + 1) * w + (j + 1)] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    let pending: WordChange | null = null;
    const push = (kind: ChangeKind, left: string[], right: string[], li: number, ri: number) => {
      if (pending && pending.kind === kind) {
        pending.left.push(...left);
        pending.right.push(...right);
        return;
      }
      if (pending) out.push(pending);
      pending = { kind, left: [...left], right: [...right], leftAt: start + li, rightAt: start + ri };
    };
    while (i < subA.length && j < subB.length) {
      if (subA[i] === subB[j]) { push("equal", [subA[i]], [subB[j]], i, j); i++; j++; }
      else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) { push("delete", [subA[i]], [], i, j); i++; }
      else { push("insert", [], [subB[j]], i, j); j++; }
    }
    while (i < subA.length) { push("delete", [subA[i]], [], i, j); i++; }
    while (j < subB.length) { push("insert", [], [subB[j]], i, j); j++; }
    if (pending) out.push(pending);
  } else if (subA.length || subB.length) {
    if (subA.length) out.push({ kind: "delete", left: subA, right: [], leftAt: start, rightAt: start });
    if (subB.length) out.push({ kind: "insert", left: [], right: subB, leftAt: start, rightAt: start });
  }

  if (endA < n || endB < m) {
    out.push({ kind: "equal", left: a.slice(endA), right: b.slice(endB), leftAt: endA, rightAt: endB });
  }
  return mergeAdjacent(out);
}

/** Turn a delete immediately followed by an insert into a single replace. */
function mergeAdjacent(changes: readonly WordChange[]): WordChange[] {
  const out: WordChange[] = [];
  for (const c of changes) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === "delete" && c.kind === "insert") {
      out[out.length - 1] = { kind: "replace", left: prev.left, right: c.right, leftAt: prev.leftAt, rightAt: c.rightAt };
      continue;
    }
    if (prev && prev.kind === "insert" && c.kind === "delete") {
      out[out.length - 1] = { kind: "replace", left: c.left, right: prev.right, leftAt: c.leftAt, rightAt: prev.rightAt };
      continue;
    }
    out.push(c);
  }
  return out;
}

function coarseDiff(a: readonly string[], b: readonly string[]): WordChange[] {
  if (a.join(" ") === b.join(" ")) return [{ kind: "equal", left: [...a], right: [...b], leftAt: 0, rightAt: 0 }];
  return [{ kind: "replace", left: [...a], right: [...b], leftAt: 0, rightAt: 0 }];
}

/** Fraction of tokens that are identical. */
export function similarityOf(changes: readonly WordChange[]): number {
  let same = 0;
  let total = 0;
  for (const c of changes) {
    const n = Math.max(c.left.length, c.right.length);
    total += n;
    if (c.kind === "equal") same += n;
  }
  return total ? same / total : 1;
}

/** Cheap fingerprint used to align pages before diffing their words. */
function fingerprint(text: string): string {
  return tokenise(text.toLowerCase()).slice(0, 60).join(" ");
}

function pageSimilarity(a: string, b: string): number {
  const ta = new Set(tokenise(a.toLowerCase()));
  const tb = new Set(tokenise(b.toLowerCase()));
  if (!ta.size && !tb.size) return 1;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(1, ta.size + tb.size - shared);
}

/**
 * Align pages between the two documents, then diff each matched pair.
 * Pages are matched greedily by content similarity, which handles insertions,
 * deletions and reordered sections better than a positional pairing.
 */
export function comparePages(left: readonly string[], right: readonly string[]): ComparisonReport {
  const usedRight = new Set<number>();
  const pairs: [number | null, number | null][] = [];
  let cursor = 0;

  for (let i = 0; i < left.length; i++) {
    const fp = fingerprint(left[i]);
    let best = -1;
    let bestScore = 0;
    // Search forward from the cursor: documents mostly stay in order.
    for (let j = cursor; j < Math.min(right.length, cursor + 12); j++) {
      if (usedRight.has(j)) continue;
      const score = fp === fingerprint(right[j]) ? 1 : pageSimilarity(left[i], right[j]);
      if (score > bestScore) { bestScore = score; best = j; }
    }
    if (best >= 0 && bestScore >= 0.35) {
      for (let j = cursor; j < best; j++) if (!usedRight.has(j)) { pairs.push([null, j]); usedRight.add(j); }
      pairs.push([i, best]);
      usedRight.add(best);
      cursor = best + 1;
    } else {
      pairs.push([i, null]);
    }
  }
  for (let j = 0; j < right.length; j++) if (!usedRight.has(j)) pairs.push([null, j]);

  const pages: PageComparison[] = [];
  let wordsAdded = 0;
  let wordsRemoved = 0;
  let pagesAdded = 0;
  let pagesRemoved = 0;
  let pagesModified = 0;
  let totalSim = 0;

  for (const [l, r] of pairs) {
    if (l === null && r !== null) {
      const words = tokenise(right[r]);
      wordsAdded += words.length;
      pagesAdded++;
      pages.push({
        leftPage: null, rightPage: r + 1, status: "added", similarity: 0,
        changes: [{ kind: "insert", left: [], right: words, leftAt: 0, rightAt: 0 }],
      });
      continue;
    }
    if (r === null && l !== null) {
      const words = tokenise(left[l]);
      wordsRemoved += words.length;
      pagesRemoved++;
      pages.push({
        leftPage: l + 1, rightPage: null, status: "removed", similarity: 0,
        changes: [{ kind: "delete", left: words, right: [], leftAt: 0, rightAt: 0 }],
      });
      continue;
    }
    if (l === null || r === null) continue;
    const changes = diffTokens(tokenise(left[l]), tokenise(right[r]));
    const sim = similarityOf(changes);
    totalSim += sim;
    const modified = changes.some((c) => c.kind !== "equal");
    if (modified) pagesModified++;
    for (const c of changes) {
      if (c.kind === "insert" || c.kind === "replace") wordsAdded += c.right.length;
      if (c.kind === "delete" || c.kind === "replace") wordsRemoved += c.left.length;
    }
    pages.push({
      leftPage: l + 1, rightPage: r + 1,
      status: modified ? "modified" : "unchanged",
      changes, similarity: sim,
    });
  }

  const paired = pages.filter((p) => p.status === "modified" || p.status === "unchanged").length;
  return {
    pages,
    wordsAdded,
    wordsRemoved,
    pagesAdded,
    pagesRemoved,
    pagesModified,
    similarity: paired ? totalSim / paired : pages.length ? 0 : 1,
  };
}
