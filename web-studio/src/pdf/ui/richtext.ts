/**
 * The editing surface of « Modifier le texte »: a paragraph as styled spans.
 *
 * The model is a plain list of `TextSpan`s (what the engine stores and lays out). The editor is
 * a `contenteditable` element whose children are one `<span data-s="…">` per span (the style is
 * kept in the attribute and painted through CSSOM, never an inline `style` attribute: the
 * desktop app's CSP forbids those). Typing happens natively in the browser; every operation that
 * restyles text goes through the pure functions below and the editor is redrawn from the model.
 *
 * Offsets everywhere are CHARACTER offsets in the paragraph's text, a hard line break (`\n`,
 * a `<br>` in the DOM) counting for one.
 */

import type { TextSpan, TextSpanStyle } from "../model/types";
import { fontCss } from "../../ui/fonts";

// ---------------------------------------------------------------------------
// Model (pure)
// ---------------------------------------------------------------------------

/** Style fields the panel can change. */
export type StylePatch = Partial<Omit<TextSpanStyle, "fontResource">>;

const close = (a: number, b: number) => Math.abs(a - b) < 0.005;

export function sameStyle(a: TextSpanStyle, b: TextSpanStyle): boolean {
  return (
    (a.fontResource ?? null) === (b.fontResource ?? null) &&
    (a.fontFamily ?? "") === (b.fontFamily ?? "") &&
    (a.fontName ?? "") === (b.fontName ?? "") &&
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    close(a.fontSize, b.fontSize) &&
    a.color.toLowerCase() === b.color.toLowerCase()
  );
}

/** Same spans (text and style), for « did anything change? ». */
export function sameSpans(a: readonly TextSpan[], b: readonly TextSpan[]): boolean {
  const x = mergeSpans(a as TextSpan[]);
  const y = mergeSpans(b as TextSpan[]);
  return x.length === y.length && x.every((s, i) => s.text === y[i]!.text && sameStyle(s.style, y[i]!.style));
}

export const spansText = (spans: readonly TextSpan[]): string => spans.map((s) => s.text).join("");

/** Empty spans dropped, neighbours of the same style merged. */
export function mergeSpans(spans: readonly TextSpan[]): TextSpan[] {
  const out: TextSpan[] = [];
  for (const s of spans) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last.style, s.style)) last.text += s.text;
    else out.push({ text: s.text, style: { ...s.style } });
  }
  return out;
}

/** The spans cut at `start` and `end`: the parts before, inside and after, in order. */
function cut(
  spans: readonly TextSpan[],
  start: number,
  end: number,
): { before: TextSpan[]; inside: TextSpan[]; after: TextSpan[] } {
  const before: TextSpan[] = [];
  const inside: TextSpan[] = [];
  const after: TextSpan[] = [];
  let at = 0;
  for (const s of spans) {
    const from = at;
    const to = at + s.text.length;
    at = to;
    const piece = (a: number, b: number): TextSpan => ({
      text: s.text.slice(a - from, b - from),
      style: { ...s.style },
    });
    if (to <= start) before.push(piece(from, to));
    else if (from >= end) after.push(piece(from, to));
    else {
      if (from < start) before.push(piece(from, start));
      inside.push(piece(Math.max(from, start), Math.min(to, end)));
      if (to > end) after.push(piece(end, to));
    }
  }
  return { before, inside, after };
}

/**
 * Restyle `[start, end)`. Changing the face (family, bold, italic) drops the page's original font
 * resource for those characters — the engine then sets them in the chosen family; size, colour,
 * underline and strike-through keep it.
 */
export function applyPatch(spans: readonly TextSpan[], start: number, end: number, patch: StylePatch): TextSpan[] {
  if (end <= start) return mergeSpans(spans);
  const { before, inside, after } = cut(spans, start, end);
  const faceChanged = "fontFamily" in patch || "bold" in patch || "italic" in patch;
  // Choosing another family forgets the page font's own name; bold / italic keep the family.
  const dropName = "fontFamily" in patch;
  const styled = inside.map((s) => ({
    text: s.text,
    style: {
      ...s.style,
      ...patch,
      ...(faceChanged ? { fontResource: null } : {}),
      ...(dropName ? { fontName: undefined } : {}),
    } as TextSpanStyle,
  }));
  return mergeSpans([...before, ...styled, ...after]);
}

/** The part of the paragraph in `[start, end)`, as spans. */
export const sliceSpans = (spans: readonly TextSpan[], start: number, end: number): TextSpan[] =>
  cut(spans, start, end).inside;

export function insertAt(spans: readonly TextSpan[], offset: number, text: string, style: TextSpanStyle): TextSpan[] {
  const { before, inside, after } = cut(spans, offset, offset);
  return mergeSpans([...before, ...inside, { text, style }, ...after]);
}

export function deleteRange(spans: readonly TextSpan[], start: number, end: number): TextSpan[] {
  const { before, after } = cut(spans, start, end);
  return mergeSpans([...before, ...after]);
}

/** The style of the character at `offset` (before the caret when it sits between two), else `fallback`. */
export function styleAt(spans: readonly TextSpan[], offset: number, fallback: TextSpanStyle): TextSpanStyle {
  let at = 0;
  let last: TextSpan | undefined;
  for (const s of spans) {
    const to = at + s.text.length;
    if (offset > at && offset <= to) return s.style;
    if (offset === at && !last) return s.style;
    at = to;
    last = s;
  }
  return last ? last.style : fallback;
}

/** What the format panel shows for `[start, end)`: each field's value when it is the same everywhere, else undefined. */
export interface StyleSummary {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  /** Some fields differ inside the selection. */
  mixed: boolean;
}

export function summarise(
  spans: readonly TextSpan[],
  start: number,
  end: number,
  fallback: TextSpanStyle,
): StyleSummary {
  const parts = end > start ? cut(spans, start, end).inside : [{ text: "", style: styleAt(spans, start, fallback) }];
  const list = parts.length ? parts : [{ text: "", style: fallback }];
  const out: StyleSummary = { mixed: false };
  const pick = <K extends keyof StyleSummary>(key: K, get: (s: TextSpanStyle) => StyleSummary[K]) => {
    const first = get(list[0]!.style);
    if (list.every((p) => get(p.style) === first)) out[key] = first;
    else out.mixed = true;
  };
  pick("fontFamily", (s) => s.fontFamily ?? "");
  pick("fontSize", (s) => Math.round(s.fontSize * 100) / 100);
  pick("bold", (s) => !!s.bold);
  pick("italic", (s) => !!s.italic);
  pick("underline", (s) => !!s.underline);
  pick("strike", (s) => !!s.strike);
  pick("color", (s) => s.color.toLowerCase());
  return out;
}

/** The paragraph's own « main » style: the one covering most characters (what a new span inherits). */
export function dominantStyle(spans: readonly TextSpan[], fallback: TextSpanStyle): TextSpanStyle {
  let best: TextSpan | undefined;
  for (const s of spans) if (!best || s.text.length > best.text.length) best = s;
  return best ? best.style : fallback;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const styles = new WeakMap<Element, TextSpanStyle>();

/**
 * The family a PDF font belongs to, from its BaseFont: « Georgia-Bold » → « Georgia »,
 * « ArialMT » → « Arial », « TimesNewRomanPS-BoldMT » → « Times New Roman ». Null when there is none.
 */
export function familyOfFontName(baseFont: string | undefined): string | null {
  if (!baseFont) return null;
  let n = baseFont.replace(/^[A-Z]{6}\+/, "");
  n = n.replace(
    /[-,](Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Roman|Medium|Semibold|Light|Black|It|Bd)\b.*$/i,
    "",
  );
  n = n.replace(/(MT|PS)+$/i, "");
  n = n
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[\u0000-\u001f"'\\]/g, "")
    .trim();
  return n || null;
}

/** CSS font stack of a span: the page font's own family when installed, else the Elium family. */
export function cssFontFamily(st: TextSpanStyle): string {
  const real = familyOfFontName(st.fontName);
  const stack = fontCss(st.fontFamily);
  return real ? `"${real}", ${stack}` : stack;
}

/** Paint one span's style (CSSOM only). `scale` converts points to CSS pixels. */
export function paintStyle(el: HTMLElement, st: TextSpanStyle, scale: number): void {
  const css = el.style;
  css.fontFamily = cssFontFamily(st);
  css.fontSize = `${st.fontSize * scale}px`;
  css.fontWeight = st.bold ? "700" : "400";
  css.fontStyle = st.italic ? "italic" : "normal";
  css.color = st.color;
  css.textDecoration =
    [st.underline ? "underline" : "", st.strike ? "line-through" : ""].filter(Boolean).join(" ") || "none";
}

/** Redraw the editor from `spans`. A text ending in a hard break gets a pad so the empty last line shows. */
export function renderSpans(root: HTMLElement, spans: readonly TextSpan[], scale: number): void {
  root.textContent = "";
  for (const s of spans) {
    if (!s.text) continue;
    const el = document.createElement("span");
    styles.set(el, s.style);
    el.dataset.s = "1";
    paintStyle(el, s.style, scale);
    const lines = s.text.split("\n");
    lines.forEach((line, i) => {
      if (i) el.appendChild(document.createElement("br"));
      if (line) el.appendChild(document.createTextNode(line));
    });
    root.appendChild(el);
  }
  const text = spansText(spans);
  if (text.endsWith("\n")) {
    const pad = document.createElement("br");
    pad.dataset.pad = "1";
    root.appendChild(pad);
  }
}

/** Walk the editor's DOM in order, calling `text` for text and `br` for line breaks. */
function walk(
  root: HTMLElement,
  fallback: TextSpanStyle,
  visit: (kind: "text" | "br", value: string, style: TextSpanStyle) => void,
): void {
  const go = (node: Node, inherited: TextSpanStyle, first: { v: boolean }) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = (child.nodeValue ?? "").replace(/​/g, "");
        if (t) visit("text", t, inherited);
        first.v = false;
      } else if (child instanceof HTMLBRElement) {
        if (!child.dataset.pad) visit("br", "\n", inherited);
        first.v = false;
      } else if (child instanceof HTMLElement) {
        const own = styles.get(child);
        const block = /^(DIV|P)$/.test(child.tagName);
        // A block the browser made on its own (Enter): a hard break before it, unless it opens the text.
        if (block && !first.v) visit("br", "\n", inherited);
        go(child, own ?? inherited, first);
      }
    }
  };
  go(root, fallback, { v: true });
}

/** The editor's content as spans (merged). */
export function readSpans(root: HTMLElement, fallback: TextSpanStyle): TextSpan[] {
  const out: TextSpan[] = [];
  walk(root, fallback, (_kind, value, style) => out.push({ text: value, style }));
  return mergeSpans(out);
}

/** Is the DOM exactly what `renderSpans` would draw (so no redraw is needed)? */
export function isCanonical(root: HTMLElement): boolean {
  let prev: TextSpanStyle | null = null;
  for (const child of Array.from(root.childNodes)) {
    if (child instanceof HTMLBRElement && child.dataset.pad) continue;
    if (!(child instanceof HTMLElement) || child.tagName !== "SPAN" || !styles.has(child)) return false;
    if (!child.firstChild) return false;
    const st = styles.get(child)!;
    if (prev && sameStyle(prev, st)) return false;
    prev = st;
    for (const n of Array.from(child.childNodes)) {
      if (n.nodeType === Node.ELEMENT_NODE && !(n instanceof HTMLBRElement)) return false;
      if (n.nodeType === Node.TEXT_NODE && !(n.nodeValue ?? "").length) return false;
    }
  }
  return true;
}

/** Selection as character offsets inside `root`, or null when it is elsewhere. */
export function selectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  return {
    start: offsetOf(root, range.startContainer, range.startOffset),
    end: offsetOf(root, range.endContainer, range.endOffset),
  };
}

/** Character offset of a DOM point (container, offset) inside `root`. */
export function offsetOf(root: HTMLElement, container: Node, offset: number): number {
  const range = root.ownerDocument.createRange();
  range.setStart(root, 0);
  range.setEnd(container, offset);
  let count = 0;
  const go = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) count += (child.nodeValue ?? "").replace(/\u200b/g, "").length;
      else if (child instanceof HTMLBRElement) count += child.dataset.pad ? 0 : 1;
      else go(child);
    }
  };
  go(range.cloneContents());
  return count;
}

/** Put the selection on `[start, end]` (character offsets). */
export function setSelectionOffsets(root: HTMLElement, start: number, end: number = start): void {
  const doc = root.ownerDocument;
  const sel = doc.getSelection();
  if (!sel) return;
  const point = (target: number): { node: Node; offset: number } => {
    let left = target;
    let last: { node: Node; offset: number } = { node: root, offset: 0 };
    const go = (node: Node): { node: Node; offset: number } | null => {
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i]!;
        if (child.nodeType === Node.TEXT_NODE) {
          const len = (child.nodeValue ?? "").length;
          if (left <= len) return { node: child, offset: left };
          left -= len;
          last = { node: child, offset: len };
        } else if (child instanceof HTMLBRElement) {
          if (child.dataset.pad) continue;
          if (left === 0) return { node, offset: i };
          left -= 1;
          last = { node, offset: i + 1 };
        } else {
          const r = go(child);
          if (r) return r;
        }
      }
      return null;
    };
    return go(root) ?? last;
  };
  const a = point(start);
  const b = end === start ? a : point(end);
  const range = doc.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The character offset under a screen point (the editor must be laid out there), or null. */
export function offsetAtPoint(root: HTMLElement, x: number, y: number): number | null {
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  }
  if (!node || !root.contains(node)) return null;
  return offsetOf(root, node, offset);
}
