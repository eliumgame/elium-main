/**
 * Named styles (styles nommés) — the model behind Word's Styles gallery.
 *
 * A style is a NAMED bundle of formatting that paragraphs and runs point at,
 * instead of carrying the formatting inline. Change the style, and every
 * paragraph using it follows — the whole point.
 *
 * Two families, as in Word:
 *   - paragraph styles: block type (paragraph / heading level) + paragraph
 *     properties (alignment, spacing, indents, borders…) + character properties
 *   - character styles: character properties only, applied to a run
 *
 * Built-ins live in code; a document may carry its own in
 * `EliumDocumentModel.styles`, so custom styles round-trip inside the `.elium`.
 * Everything here is pure — no TipTap, no DOM — so it is unit-tested and shared
 * by the editor, the gallery preview, the HTML export and the DOCX writer.
 */

export type StyleKind = "paragraph" | "character";

/** Character-level properties a style can set. */
export interface StyleChar {
  fontFamily?: string;
  /** Size in px. */
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  smallCaps?: boolean;
  allCaps?: boolean;
  /** `#rrggbb`. */
  color?: string;
  /** `#rrggbb` highlight/shading behind the text. */
  highlight?: string;
  /** Letter spacing in px. */
  letterSpacing?: number;
}

/** Paragraph-level properties a style can set. */
export interface StylePara {
  align?: "left" | "center" | "right" | "justify";
  /** Space above/below in px. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** Indent level (as the editor's `indent` attribute). */
  indent?: number;
  /** First-line indent in px; negative is a hanging indent. */
  firstLineIndent?: number;
  lineHeight?: string;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  shading?: string;
}

export interface DocStyle {
  id: string;
  name: string;
  kind: StyleKind;
  /** Inherit from another style, then override (Word's `basedOn`). */
  basedOn?: string;
  /** Paragraph styles only: the block this style produces. */
  block?: { type: "paragraph" | "heading"; level?: number };
  char?: StyleChar;
  para?: StylePara;
  /** Built-ins cannot be deleted; they can still be modified. */
  builtIn?: boolean;
  /** Shown in the ribbon gallery (Word calls this the Quick Style list). */
  quick?: boolean;
}

// =========================================================================
// Built-in style set
// =========================================================================

export const BUILTIN_STYLES: DocStyle[] = [
  {
    id: "Normal",
    name: "Normal",
    kind: "paragraph",
    block: { type: "paragraph" },
    builtIn: true,
    quick: true,
  },
  {
    id: "Titre1",
    name: "Titre 1",
    kind: "paragraph",
    basedOn: "Normal",
    block: { type: "heading", level: 1 },
    char: { bold: true, fontSize: 26 },
    para: { spaceBefore: 18, spaceAfter: 8, keepNext: true, keepLines: true },
    builtIn: true,
    quick: true,
  },
  {
    id: "Titre2",
    name: "Titre 2",
    kind: "paragraph",
    basedOn: "Normal",
    block: { type: "heading", level: 2 },
    char: { bold: true, fontSize: 21 },
    para: { spaceBefore: 14, spaceAfter: 6, keepNext: true, keepLines: true },
    builtIn: true,
    quick: true,
  },
  {
    id: "Titre3",
    name: "Titre 3",
    kind: "paragraph",
    basedOn: "Normal",
    block: { type: "heading", level: 3 },
    char: { bold: true, fontSize: 18 },
    para: { spaceBefore: 12, spaceAfter: 4, keepNext: true, keepLines: true },
    builtIn: true,
    quick: true,
  },
  {
    id: "Titre4",
    name: "Titre 4",
    kind: "paragraph",
    basedOn: "Normal",
    block: { type: "heading", level: 4 },
    char: { bold: true, italic: true, fontSize: 16 },
    para: { spaceBefore: 10, spaceAfter: 4, keepNext: true },
    builtIn: true,
  },
  {
    id: "SousTitre",
    name: "Sous-titre",
    kind: "paragraph",
    basedOn: "Normal",
    block: { type: "paragraph" },
    char: { fontSize: 18, color: "#475569" },
    para: { spaceAfter: 12 },
    builtIn: true,
    quick: true,
  },
  {
    id: "Accroche",
    name: "Accroche",
    kind: "paragraph",
    basedOn: "Normal",
    block: { type: "paragraph" },
    char: { fontSize: 17, italic: true, color: "#334155" },
    para: { spaceAfter: 10 },
    builtIn: true,
    quick: true,
  },
  {
    id: "CorpsDeTexte",
    name: "Corps de texte",
    kind: "paragraph",
    basedOn: "Normal",
    block: { type: "paragraph" },
    para: { spaceAfter: 8, lineHeight: "1.6" },
    builtIn: true,
    quick: true,
  },
  {
    id: "SansInterligne",
    name: "Sans interligne",
    kind: "paragraph",
    basedOn: "Normal",
    block: { type: "paragraph" },
    para: { spaceBefore: 0, spaceAfter: 0, lineHeight: "1.3" },
    builtIn: true,
    quick: true,
  },
  {
    id: "Legende",
    name: "Légende",
    kind: "paragraph",
    basedOn: "Normal",
    block: { type: "paragraph" },
    char: { fontSize: 13, italic: true, color: "#64748b" },
    para: { align: "center", spaceAfter: 10 },
    builtIn: true,
    quick: true,
  },
  {
    id: "CitationIntense",
    name: "Citation intense",
    kind: "paragraph",
    basedOn: "Normal",
    block: { type: "paragraph" },
    char: { italic: true, color: "#1d4ed8", fontSize: 17 },
    para: { align: "center", spaceBefore: 14, spaceAfter: 14, indent: 1 },
    builtIn: true,
    quick: true,
  },
  // --- character styles ---
  {
    id: "Emphase",
    name: "Emphase",
    kind: "character",
    char: { italic: true },
    builtIn: true,
    quick: true,
  },
  {
    id: "EmphaseIntense",
    name: "Emphase intense",
    kind: "character",
    char: { bold: true, italic: true, color: "#1d4ed8" },
    builtIn: true,
    quick: true,
  },
  {
    id: "ReferenceIntense",
    name: "Référence intense",
    kind: "character",
    char: { bold: true, smallCaps: true, color: "#1d4ed8" },
    builtIn: true,
    quick: true,
  },
  {
    id: "MotCle",
    name: "Mot-clé",
    kind: "character",
    char: { bold: true, highlight: "#fef08a" },
    builtIn: true,
  },
];

/** Built-ins first, then the document's own, with document overrides winning. */
export function mergeStyles(custom: DocStyle[] | undefined): DocStyle[] {
  const out = new Map<string, DocStyle>();
  for (const s of BUILTIN_STYLES) out.set(s.id, s);
  for (const s of custom ?? []) {
    const base = out.get(s.id);
    // A document may REDEFINE a built-in (Word lets you modify Titre 1).
    out.set(s.id, base ? { ...base, ...s, builtIn: base.builtIn } : s);
  }
  return [...out.values()];
}

export function findStyle(styles: DocStyle[], id: string | null | undefined): DocStyle | null {
  if (!id) return null;
  return styles.find((s) => s.id === id) ?? null;
}

/**
 * Flatten a style through its `basedOn` chain. Cycles are cut (a corrupt or
 * hand-edited document must not hang the editor).
 */
export function resolveStyle(styles: DocStyle[], id: string | null | undefined): DocStyle | null {
  const style = findStyle(styles, id);
  if (!style) return null;
  const chain: DocStyle[] = [];
  const seen = new Set<string>();
  let cur: DocStyle | null = style;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.basedOn ? findStyle(styles, cur.basedOn) : null;
  }
  return chain.reduce<DocStyle>(
    (acc, s) => ({
      ...acc,
      ...s,
      char: { ...acc.char, ...s.char },
      para: { ...acc.para, ...s.para },
      block: s.block ?? acc.block,
    }),
    { id: style.id, name: style.name, kind: style.kind },
  );
}

// =========================================================================
// Rendering
// =========================================================================

const isHex = (v: unknown) => /^#[0-9a-fA-F]{6}$/.test(String(v ?? ""));

/** CSS for a resolved style — used by the gallery preview and the screen. */
export function styleCss(style: DocStyle | null): string {
  if (!style) return "";
  const c = style.char ?? {};
  const p = style.para ?? {};
  const parts: string[] = [];
  if (c.fontFamily) parts.push(`font-family:${c.fontFamily}`);
  if (c.fontSize) parts.push(`font-size:${c.fontSize}px`);
  if (c.bold) parts.push("font-weight:700");
  if (c.italic) parts.push("font-style:italic");
  const lines = [c.underline ? "underline" : "", c.strike ? "line-through" : ""].filter(Boolean);
  if (lines.length) parts.push(`text-decoration-line:${lines.join(" ")}`);
  if (c.smallCaps) parts.push("font-variant-caps:small-caps");
  if (c.allCaps) parts.push("text-transform:uppercase");
  if (isHex(c.color)) parts.push(`color:${c.color}`);
  if (isHex(c.highlight)) parts.push(`background-color:${c.highlight}`);
  if (c.letterSpacing) parts.push(`letter-spacing:${c.letterSpacing}px`);
  if (p.align) parts.push(`text-align:${p.align}`);
  if (p.spaceBefore != null) parts.push(`margin-top:${p.spaceBefore}px`);
  if (p.spaceAfter != null) parts.push(`margin-bottom:${p.spaceAfter}px`);
  if (p.lineHeight) parts.push(`line-height:${p.lineHeight}`);
  if (p.firstLineIndent) parts.push(`text-indent:${p.firstLineIndent}px`);
  if (isHex(p.shading)) parts.push(`background-color:${p.shading}`);
  return parts.join(";");
}

/**
 * The node attributes applying a paragraph style implies. Returned separately
 * from the block type so the caller can set the type first, then the attributes.
 */
export function styleAttrs(style: DocStyle | null): Record<string, unknown> {
  if (!style) return {};
  const p = style.para ?? {};
  const c = style.char ?? {};
  return {
    styleId: style.id,
    ...(p.align ? { textAlign: p.align } : { textAlign: null }),
    ...(p.indent != null ? { indent: p.indent } : {}),
    spaceBefore: p.spaceBefore ?? null,
    spaceAfter: p.spaceAfter ?? null,
    firstLineIndent: p.firstLineIndent ?? null,
    lineHeight: p.lineHeight ?? null,
    keepNext: p.keepNext ?? null,
    keepLines: p.keepLines ?? null,
    pageBreakBefore: p.pageBreakBefore ?? null,
    shading: p.shading ?? null,
    // Character side, carried by the paragraph so empty paragraphs still look
    // right; the marks below are what actually style existing text.
    styleFontSize: c.fontSize ?? null,
  };
}

/** The `textStyle` mark attributes a style's character part implies. */
export function styleTextStyleAttrs(style: DocStyle | null): Record<string, unknown> {
  const c = style?.char ?? {};
  return {
    fontFamily: c.fontFamily ?? null,
    fontSize: c.fontSize ? `${c.fontSize}px` : null,
    color: isHex(c.color) ? c.color : null,
    smallCaps: c.smallCaps ? true : null,
    allCaps: c.allCaps ? true : null,
    letterSpacing: c.letterSpacing ? `${c.letterSpacing}px` : null,
  };
}

/** Marks a style's character part toggles on. */
export function styleMarks(style: DocStyle | null): { bold: boolean; italic: boolean; underline: boolean; strike: boolean; highlight: string | null } {
  const c = style?.char ?? {};
  return {
    bold: c.bold === true,
    italic: c.italic === true,
    underline: c.underline === true,
    strike: c.strike === true,
    highlight: isHex(c.highlight) ? String(c.highlight) : null,
  };
}

// =========================================================================
// DOCX
// =========================================================================

const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const hex6 = (v: unknown): string | null => {
  const c = String(v ?? "").replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null;
};

/** px → twips (1px = 0.75pt = 15 twips). */
const tw = (px: number) => Math.round(px * 15);

/**
 * A real `<w:style>` definition, so Word shows the style in ITS gallery and
 * applying it there reproduces the same look — rather than the formatting being
 * baked into every run.
 */
export function styleToDocxXml(style: DocStyle): string {
  const c = style.char ?? {};
  const p = style.para ?? {};
  const rPr: string[] = [];
  if (c.fontFamily) {
    const fam = c.fontFamily.split(",")[0]!.replace(/['"]/g, "").trim();
    if (fam) rPr.push(`<w:rFonts w:ascii="${xmlEsc(fam)}" w:hAnsi="${xmlEsc(fam)}"/>`);
  }
  if (c.bold) rPr.push("<w:b/>");
  if (c.italic) rPr.push("<w:i/>");
  if (c.underline) rPr.push('<w:u w:val="single"/>');
  if (c.strike) rPr.push("<w:strike/>");
  if (c.smallCaps) rPr.push("<w:smallCaps/>");
  if (c.allCaps) rPr.push("<w:caps/>");
  if (c.letterSpacing) rPr.push(`<w:spacing w:val="${tw(c.letterSpacing)}"/>`);
  const color = hex6(c.color);
  if (color) rPr.push(`<w:color w:val="${color}"/>`);
  const hl = hex6(c.highlight);
  if (hl) rPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hl}"/>`);
  if (c.fontSize) rPr.push(`<w:sz w:val="${Math.round(c.fontSize * 1.5)}"/>`);

  const pPr: string[] = [];
  if (style.kind === "paragraph") {
    if (p.keepNext) pPr.push("<w:keepNext/>");
    if (p.keepLines) pPr.push("<w:keepLines/>");
    if (p.pageBreakBefore) pPr.push("<w:pageBreakBefore/>");
    const shd = hex6(p.shading);
    if (shd) pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${shd}"/>`);
    if (p.spaceBefore != null || p.spaceAfter != null) {
      pPr.push(
        `<w:spacing${p.spaceBefore != null ? ` w:before="${tw(p.spaceBefore)}"` : ""}${p.spaceAfter != null ? ` w:after="${tw(p.spaceAfter)}"` : ""}/>`,
      );
    }
    const indentAttrs: string[] = [];
    if (p.indent) indentAttrs.push(`w:left="${p.indent * 480}"`);
    if (p.firstLineIndent && p.firstLineIndent > 0) indentAttrs.push(`w:firstLine="${tw(p.firstLineIndent)}"`);
    if (p.firstLineIndent && p.firstLineIndent < 0) indentAttrs.push(`w:hanging="${tw(-p.firstLineIndent)}"`);
    if (indentAttrs.length) pPr.push(`<w:ind ${indentAttrs.join(" ")}/>`);
    if (p.align && p.align !== "left") pPr.push(`<w:jc w:val="${p.align === "justify" ? "both" : p.align}"/>`);
    if (style.block?.type === "heading" && style.block.level) {
      pPr.push(`<w:outlineLvl w:val="${Math.max(0, style.block.level - 1)}"/>`);
    }
  }

  // Word recognises heading styles by their NAME ("heading 1"), not their id —
  // and localises the display name itself. Using the canonical name is what
  // makes the outline, the navigation pane and Word's own TOC see them.
  const wordName =
    style.block?.type === "heading" && style.block.level ? `heading ${style.block.level}` : style.name;
  return (
    `<w:style w:type="${style.kind}" w:styleId="${xmlEsc(style.id)}"${style.id === "Normal" ? ' w:default="1"' : ""}>` +
    `<w:name w:val="${xmlEsc(wordName)}"/>` +
    (style.basedOn ? `<w:basedOn w:val="${xmlEsc(style.basedOn)}"/>` : "") +
    (pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : "") +
    (rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : "") +
    `</w:style>`
  );
}

/**
 * The whole `styles.xml` part for a document's effective style set.
 *
 * `extra` takes already-serialised `<w:style>` fragments the writer owns — the
 * footnote/endnote styles come from `format/docx-notes.ts`, and importing them
 * here would point the dependency from `editor/` back into `format/`.
 */
export function stylesXml(styles: DocStyle[], extra = ""): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    styles.map(styleToDocxXml).join("") +
    // The table style the writer references for grids.
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>` +
    extra +
    `</w:styles>`
  );
}

/** A fresh id from a display name, unique against the existing set. */
export function newStyleId(name: string, existing: DocStyle[]): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 40) || "Style";
  const taken = new Set(existing.map((s) => s.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}
