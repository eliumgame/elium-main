/**
 * Captions and the table of figures — pure.
 *
 * A caption is a block attached to a figure, a table or an equation. It stores
 * only its LABEL ("Figure", "Tableau", …) and its text; the NUMBER is derived
 * from document order on every render, per label — so inserting a figure in the
 * middle renumbers everything after it with no bookkeeping, and a caption can
 * never show a stale number (the same principle as the TOC and the footnotes
 * list).
 *
 * The table of figures is likewise derived: it lists the captions of one label
 * (or all of them) with the page each sits on.
 */

import type { ProseMirrorNode } from "../format/types";

/** Labels offered by default; a caption may carry any other string. */
export const CAPTION_LABELS = ["Figure", "Tableau", "Équation"] as const;
export type CaptionLabel = (typeof CAPTION_LABELS)[number] | string;

/** Where the caption sits relative to the object it describes. */
export type CaptionPosition = "above" | "below";

export interface CaptionEntry {
  /** Label as stored ("Figure"). */
  label: string;
  /** 1-based number within its label. */
  number: number;
  /** Caption text, without the "Figure 3 — " prefix. */
  text: string;
  /** Document position of the caption node (-1 when scanning plain JSON). */
  pos: number;
  /** Stable anchor id, when one has been stamped for a renvoi. */
  anchorId: string;
}

const normalizeLabel = (v: unknown): string => String(v ?? "Figure").replace(/\s+/g, " ").trim() || "Figure";

/** The prefix a caption displays, e.g. "Figure 3 — ". */
export function captionPrefix(label: string, number: number, separator = " — "): string {
  return `${label} ${number}${separator}`;
}

type Visit = (type: string, attrs: Record<string, unknown>, text: string, pos: number) => void;
type Walker = (visit: Visit) => void;

/** Shared scan: numbers captions per label, in document order. */
function scanCaptions(walk: Walker): CaptionEntry[] {
  const counters = new Map<string, number>();
  const out: CaptionEntry[] = [];
  walk((type, attrs, text, pos) => {
    if (type !== "caption") return;
    const label = normalizeLabel(attrs.label);
    const n = (counters.get(label) ?? 0) + 1;
    counters.set(label, n);
    out.push({
      label,
      number: n,
      text: text.replace(/\s+/g, " ").trim(),
      pos,
      anchorId: String(attrs.refId ?? "") || "",
    });
  });
  return out;
}

/** Minimal ProseMirror node shape, so this module needs no TipTap import. */
interface PMLike {
  descendants(
    fn: (node: { type: { name: string }; attrs: Record<string, unknown>; textContent: string }, pos: number) => boolean | void,
  ): void;
}

/** Captions of a live document, with real positions. */
export function collectCaptions(doc: PMLike): CaptionEntry[] {
  return scanCaptions((visit) => {
    doc.descendants((node, pos) => {
      visit(node.type.name, node.attrs ?? {}, node.textContent ?? "", pos);
      return true;
    });
  });
}

function jsonText(node: ProseMirrorNode): string {
  if (node.text != null) return node.text;
  return (node.content ?? []).map(jsonText).join("");
}

/** Captions of plain document JSON (positions are -1). */
export function collectCaptionsJson(doc: ProseMirrorNode): CaptionEntry[] {
  return scanCaptions((visit) => {
    const walk = (node: ProseMirrorNode) => {
      visit(node.type, node.attrs ?? {}, jsonText(node), -1);
      (node.content ?? []).forEach(walk);
    };
    (doc.content ?? []).forEach(walk);
  });
}

/** The number a caption at `pos` carries, or null when it is not a caption. */
export function captionNumberAt(entries: CaptionEntry[], pos: number): CaptionEntry | null {
  return entries.find((e) => e.pos === pos) ?? null;
}

/** Distinct labels used by the document, in first-use order. */
export function captionLabels(entries: CaptionEntry[]): string[] {
  const seen: string[] = [];
  for (const e of entries) if (!seen.includes(e.label)) seen.push(e.label);
  return seen;
}

export interface FigureTableRow extends CaptionEntry {
  /** 1-based page, when a resolver could supply one. */
  page: number | null;
}

/**
 * Rows of a table of figures. `label` filters to one family; omit it (or pass
 * "") to list every caption, which is what Word's "Toutes les légendes" does.
 */
export function buildFigureTable(
  entries: CaptionEntry[],
  label: string | null | undefined,
  pageOf: ((pos: number) => number | null) | null,
): FigureTableRow[] {
  const wanted = normalizeLabel(label ?? "") ;
  const filtered = label ? entries.filter((e) => e.label === wanted) : entries;
  return filtered.map((e) => ({ ...e, page: pageOf && e.pos >= 0 ? pageOf(e.pos) : null }));
}

/** A `SEQ` field instruction, which is how Word numbers captions natively. */
export function seqInstr(label: string): string {
  // The identifier cannot contain spaces in a field name; Word uses the label
  // with spaces stripped, which is also what its own captions do.
  return ` SEQ ${label.replace(/\s+/g, "")} \\* ARABIC `;
}

/** The `TOC` instruction for a table of figures of one label. */
export function figureTableInstr(label: string | null | undefined): string {
  // \h hyperlinks the entries, \z hides tab leaders in web view, \c selects the
  // caption family. Without \c, Word would build a heading TOC instead.
  return label ? ` TOC \\h \\z \\c "${label.replace(/"/g, "")}" ` : ` TOC \\h \\z \\c `;
}

/**
 * The minimum a resolved position has to expose for {@link captionInsertPos} —
 * kept structural so the placement rule stays unit-testable without an editor.
 */
export interface ResolvedLike {
  depth: number;
  node(depth: number): { canReplaceWith(from: number, to: number, type: unknown): boolean };
  index(depth: number): number;
  before(depth: number): number;
  after(depth: number): number;
}

/**
 * Where a caption belongs relative to the cursor.
 *
 * Word anchors a caption *beside* the captioned element, never inside it. That
 * matters here because a caption holds inline content only: inserting at the
 * cursor throws away the command whenever the cursor already sits in a caption,
 * a figure or a table cell. So walk out of the current block until reaching a
 * container that actually accepts a caption, and insert at that block's edge —
 * which is also what makes `position: "above"` mean anything.
 *
 * Returns `null` when no ancestor can hold a caption.
 */
export function captionInsertPos($from: ResolvedLike, type: unknown, below: boolean): number | null {
  for (let d = $from.depth; d >= 1; d--) {
    const container = $from.node(d - 1);
    const at = $from.index(d - 1) + (below ? 1 : 0);
    if (container.canReplaceWith(at, at, type)) return below ? $from.after(d) : $from.before(d);
  }
  return null;
}

/**
 * The title of a table of figures, e.g. "Table des tableaux".
 *
 * French pluralisation is not a bare "+s": -eau and -al take -x/-aux, and words
 * already ending in -s/-x/-z are invariable. Getting "tableaus" on screen is the
 * kind of detail that makes a document look machine-made.
 */
export function figureTableTitle(label: string | null | undefined): string {
  // A blank label means "every family", not the default one — so test the raw
  // string, before normalizeLabel substitutes its "Figure" fallback.
  if (!label?.trim()) return "Table des illustrations";
  const lower = normalizeLabel(label).toLowerCase();
  let plural: string;
  if (/(?:s|x|z)$/.test(lower)) plural = lower;
  else if (/(?:eau|eu)$/.test(lower)) plural = `${lower}x`;
  else if (/al$/.test(lower)) plural = `${lower.slice(0, -2)}aux`;
  else plural = `${lower}s`;
  return `Table des ${plural}`;
}
