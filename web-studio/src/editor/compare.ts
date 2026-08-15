/**
 * Document comparison (comparaison de documents) — pure.
 *
 * Diffs two Elium documents and returns ONE merged document whose differences
 * ride on the existing track-changes marks (`insertion` / `deletion` from
 * `TrackChanges.ts`), so the result opens in the normal review UI: the user walks
 * the changes and accepts or rejects them with the buttons that are already
 * there — no separate comparison viewer to learn.
 *
 * Strategy, mirroring what Word's compare does:
 *   1. block-level diff (LCS over block signatures, which include the block's
 *      full text) — identical blocks are kept untouched;
 *   2. a replaced run of blocks is paired up positionally, and each pair is
 *      refined: containers (lists, tables, quotes, column sections) recurse,
 *      leaf blocks get a WORD-level inline diff that preserves the formatting
 *      marks of each surviving token;
 *   3. unpaired blocks are marked wholly inserted or wholly deleted.
 *
 * Documented limit: structure that no inline mark can describe — page breaks,
 * section breaks, generated blocks (TOC, index, footnotes list) — follows the
 * REVISED document and is reported in `summary.structural` instead of being
 * tracked. Everything textual round-trips exactly: rejecting every change
 * restores the original text, accepting every change yields the revision's.
 */

import type { ProseMirrorNode } from "../format/types";

export interface CompareSummary {
  /** Characters of text present only in the revision. */
  insertions: number;
  /** Characters of text present only in the original. */
  deletions: number;
  blocksAdded: number;
  blocksRemoved: number;
  blocksChanged: number;
  /** Untrackable structural nodes that follow the revised document. */
  structural: number;
}

export interface CompareResult {
  doc: ProseMirrorNode;
  summary: CompareSummary;
}

export interface CompareOptions {
  /** Author stamped on every change mark (shown in the review panel). */
  author?: string;
  /** ISO timestamp stamped on every change mark. */
  ts?: string;
}

type InlineMark = { type: string; attrs?: Record<string, unknown> };

/** Blocks whose children are themselves blocks — a change inside recurses. */
const CONTAINERS = new Set([
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "columnSection",
]);

/** Blocks with no inline text to carry a mark. */
const STRUCTURAL = new Set([
  "pageBreak",
  "sectionBreak",
  "horizontalRule",
  "tableOfContents",
  "footnotesList",
  "endnotesList",
  "indexBlock",
  "tableOfFigures",
  "image",
]);

// =========================================================================
// Generic sequence diff
// =========================================================================

export type DiffOp = { kind: "equal"; a: number; b: number } | { kind: "del"; a: number } | { kind: "ins"; b: number };

/** Above this many DP cells the middle section is treated as a plain replace. */
const DP_CELL_CAP = 4_000_000;

/**
 * LCS diff over two key sequences. Common prefix and suffix are trimmed first
 * (which collapses most real-world documents to a small middle), and the DP is
 * capped so a pathological input degrades to a coarse replace instead of
 * hanging.
 */
export function diffSeq(a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
  }

  for (let i = 0; i < lo; i++) ops.push({ kind: "equal", a: i, b: i });

  const n = hiA - lo;
  const m = hiB - lo;
  if (n === 0 || m === 0 || n * m > DP_CELL_CAP) {
    for (let i = lo; i < hiA; i++) ops.push({ kind: "del", a: i });
    for (let j = lo; j < hiB; j++) ops.push({ kind: "ins", b: j });
  } else {
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          a[lo + i] === b[lo + j]
            ? dp[(i + 1) * w + (j + 1)] + 1
            : Math.max(dp[(i + 1) * w + j]!, dp[i * w + (j + 1)]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[lo + i] === b[lo + j]) {
        ops.push({ kind: "equal", a: lo + i, b: lo + j });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) {
        ops.push({ kind: "del", a: lo + i });
        i++;
      } else {
        ops.push({ kind: "ins", b: lo + j });
        j++;
      }
    }
    while (i < n) ops.push({ kind: "del", a: lo + i++ });
    while (j < m) ops.push({ kind: "ins", b: lo + j++ });
  }

  // The trimmed common suffix.
  for (let i = hiA, j = hiB; i < a.length && j < b.length; i++, j++) ops.push({ kind: "equal", a: i, b: j });
  return ops;
}

// =========================================================================
// Text / signature helpers
// =========================================================================

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Signature of a block's contents. Inline atoms (footnotes, renvois, merge
 * fields, bookmarks, index marks) have no text, so they are represented by their
 * type and attributes — otherwise adding or removing one would be invisible to
 * the block-level diff and the node would be silently dropped.
 */
function contentSig(node: ProseMirrorNode): string {
  if (node.text != null) return node.text;
  const kids = node.content ?? [];
  if (!kids.length) return `\u0000${node.type}:${JSON.stringify(node.attrs ?? {})}`;
  return kids.map(contentSig).join("");
}

/** Signature used for the block-level diff: type, level and full contents. */
function blockSig(node: ProseMirrorNode): string {
  const level = node.attrs?.level != null ? `:${node.attrs.level}` : "";
  return `${node.type}${level}|${normalize((node.content ?? []).map(contentSig).join(""))}`;
}

// =========================================================================
// Inline (word-level) diff
// =========================================================================

interface Token {
  key: string;
  /** Text token. */
  text?: string;
  /** Inline node token (footnote, renvoi, merge field…). */
  node?: ProseMirrorNode;
  marks: InlineMark[];
}

/**
 * Flatten a block's inline content into word tokens. Whitespace is kept as its
 * own token so word boundaries diff cleanly, and each token carries the marks of
 * the run it came from, so surviving formatting is preserved.
 */
function tokenize(content: ProseMirrorNode[] | undefined): Token[] {
  const out: Token[] = [];
  for (const child of content ?? []) {
    if (child.type === "text" && child.text != null) {
      const marks = (child.marks ?? []) as InlineMark[];
      for (const piece of child.text.split(/(\s+)/)) {
        if (piece === "") continue;
        out.push({ key: piece, text: piece, marks });
      }
    } else {
      out.push({
        key: `\u0000${child.type}:${JSON.stringify(child.attrs ?? {})}`,
        node: child,
        marks: (child.marks ?? []) as InlineMark[],
      });
    }
  }
  return out;
}

function withMark(marks: InlineMark[], extra: InlineMark | null): InlineMark[] {
  if (!extra) return marks;
  return [...marks.filter((m) => m.type !== extra.type), extra];
}

/** Turn tokens back into inline content, coalescing runs with identical marks. */
function detokenize(tokens: { token: Token; change: InlineMark | null }[]): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  for (const { token, change } of tokens) {
    const marks = withMark(token.marks, change);
    if (token.node) {
      out.push(marks.length ? { ...token.node, marks } : { ...token.node });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) {
      last.text = (last.text ?? "") + (token.text ?? "");
      continue;
    }
    out.push(marks.length ? { type: "text", text: token.text ?? "", marks } : { type: "text", text: token.text ?? "" });
  }
  return out;
}

// =========================================================================
// Comparison
// =========================================================================

interface Ctx {
  ins: InlineMark;
  del: InlineMark;
  summary: CompareSummary;
}

const isEmptyText = (t: string) => t.trim() === "";

/** Word-level diff of two leaf blocks; returns the merged inline content. */
function diffInline(a: ProseMirrorNode, b: ProseMirrorNode, ctx: Ctx): ProseMirrorNode[] {
  const ta = tokenize(a.content);
  const tb = tokenize(b.content);
  const ops = diffSeq(
    ta.map((t) => t.key),
    tb.map((t) => t.key),
  );
  const merged: { token: Token; change: InlineMark | null }[] = [];
  for (const op of ops) {
    if (op.kind === "equal") {
      // Keep the revision's token, so formatting changes adopt the revision.
      merged.push({ token: tb[op.b]!, change: null });
    } else if (op.kind === "del") {
      const token = ta[op.a]!;
      merged.push({ token, change: ctx.del });
      if (token.text && !isEmptyText(token.text)) ctx.summary.deletions += token.text.length;
      if (token.node) ctx.summary.deletions += 1;
    } else {
      const token = tb[op.b]!;
      merged.push({ token, change: ctx.ins });
      if (token.text && !isEmptyText(token.text)) ctx.summary.insertions += token.text.length;
      if (token.node) ctx.summary.insertions += 1;
    }
  }
  return detokenize(merged);
}

/** Mark every text token of a block as wholly inserted or wholly deleted. */
function markWhole(node: ProseMirrorNode, change: InlineMark, ctx: Ctx): ProseMirrorNode | null {
  if (STRUCTURAL.has(node.type)) {
    ctx.summary.structural += 1;
    // Structural atoms follow the revision: an inserted one is kept, a deleted
    // one is dropped (see the module header — no inline mark can describe it).
    return change.type === "insertion" ? { ...node } : null;
  }
  if (CONTAINERS.has(node.type)) {
    const content = (node.content ?? [])
      .map((child) => markWhole(child, change, ctx))
      .filter((n): n is ProseMirrorNode => n !== null);
    return { ...node, content };
  }
  const tokens = tokenize(node.content).map((token) => ({ token, change }));
  for (const { token } of tokens) {
    const len = token.text && !isEmptyText(token.text) ? token.text.length : token.node ? 1 : 0;
    if (change.type === "insertion") ctx.summary.insertions += len;
    else ctx.summary.deletions += len;
  }
  return { ...node, content: detokenize(tokens) };
}

function attrsDiffer(a: ProseMirrorNode, b: ProseMirrorNode): boolean {
  return JSON.stringify(a.attrs ?? {}) !== JSON.stringify(b.attrs ?? {});
}

/** Recursive block-list diff. Returns the merged block list. */
function diffBlocks(aBlocks: ProseMirrorNode[], bBlocks: ProseMirrorNode[], ctx: Ctx): ProseMirrorNode[] {
  const ops = diffSeq(aBlocks.map(blockSig), bBlocks.map(blockSig));
  const out: ProseMirrorNode[] = [];

  // Group consecutive del/ins into runs so they can be paired and refined.
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.kind === "equal") {
      // Identical text ⇒ keep the revised node (adopts formatting changes).
      out.push(bBlocks[op.b]!);
      i++;
      continue;
    }
    const dels: number[] = [];
    const inss: number[] = [];
    while (i < ops.length && ops[i]!.kind !== "equal") {
      const cur = ops[i]!;
      if (cur.kind === "del") dels.push(cur.a);
      else inss.push(cur.b);
      i++;
    }

    const paired = Math.min(dels.length, inss.length);
    for (let k = 0; k < paired; k++) {
      const a = aBlocks[dels[k]!]!;
      const b = bBlocks[inss[k]!]!;
      if (a.type === b.type && CONTAINERS.has(a.type)) {
        ctx.summary.blocksChanged += 1;
        out.push({ ...b, content: diffBlocks(a.content ?? [], b.content ?? [], ctx) });
      } else if (a.type === b.type && !STRUCTURAL.has(a.type)) {
        ctx.summary.blocksChanged += 1;
        out.push({ ...b, content: diffInline(a, b, ctx) });
      } else {
        const deleted = markWhole(a, ctx.del, ctx);
        if (deleted) out.push(deleted);
        const inserted = markWhole(b, ctx.ins, ctx);
        if (inserted) out.push(inserted);
        ctx.summary.blocksRemoved += 1;
        ctx.summary.blocksAdded += 1;
      }
    }
    for (let k = paired; k < dels.length; k++) {
      const deleted = markWhole(aBlocks[dels[k]!]!, ctx.del, ctx);
      if (deleted) out.push(deleted);
      ctx.summary.blocksRemoved += 1;
    }
    for (let k = paired; k < inss.length; k++) {
      const inserted = markWhole(bBlocks[inss[k]!]!, ctx.ins, ctx);
      if (inserted) out.push(inserted);
      ctx.summary.blocksAdded += 1;
    }
  }

  return out;
}

/**
 * Compare `original` with `revised` and return the merged, tracked document.
 *
 * `original` is the older document (its unique text becomes deletions) and
 * `revised` the newer one (its unique text becomes insertions).
 */
export function compareDocuments(
  original: ProseMirrorNode,
  revised: ProseMirrorNode,
  opts: CompareOptions = {},
): CompareResult {
  const author = opts.author ?? "Comparaison";
  const ts = opts.ts ?? "";
  const ctx: Ctx = {
    ins: { type: "insertion", attrs: { author, ts } },
    del: { type: "deletion", attrs: { author, ts } },
    summary: { insertions: 0, deletions: 0, blocksAdded: 0, blocksRemoved: 0, blocksChanged: 0, structural: 0 },
  };

  const content = diffBlocks(original.content ?? [], revised.content ?? [], ctx);

  // A formatting-only change on an otherwise identical block is adopted from the
  // revision (see diffBlocks); count it so the report is not silent about it.
  const aBlocks = original.content ?? [];
  const bBlocks = revised.content ?? [];
  if (aBlocks.length === bBlocks.length) {
    for (let k = 0; k < aBlocks.length; k++) {
      if (blockSig(aBlocks[k]!) === blockSig(bBlocks[k]!) && attrsDiffer(aBlocks[k]!, bBlocks[k]!)) {
        ctx.summary.blocksChanged += 1;
      }
    }
  }

  return {
    doc: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] },
    summary: ctx.summary,
  };
}

/** Whether a comparison found anything at all. */
export function hasChanges(summary: CompareSummary): boolean {
  return (
    summary.insertions > 0 ||
    summary.deletions > 0 ||
    summary.blocksAdded > 0 ||
    summary.blocksRemoved > 0 ||
    summary.blocksChanged > 0 ||
    summary.structural > 0
  );
}
