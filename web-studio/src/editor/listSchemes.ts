/**
 * Multilevel list schemes (listes multiniveaux) — the Word "Liste à plusieurs
 * niveaux" gallery, expressed as ONE data table that drives all three surfaces:
 *
 *   - the screen + exported HTML/PDF, via generated CSS counters (`schemesCss`)
 *   - Markdown / plain-text export, via `markerText`
 *   - DOCX export, via `abstractNumXml` (real `numbering.xml` levels, so Word
 *     re-numbers the list itself instead of receiving frozen literals)
 *
 * A scheme is stored as a `listScheme` attribute on the OUTERMOST list node; the
 * generated CSS and the exporters both inherit it through descendant lists, so a
 * sublist created with Tab automatically picks up the right level format without
 * any attribute plumbing.
 *
 * Everything here is pure (no DOM, no TipTap) so it is unit-testable.
 */

/** Numbering formats, named as WordprocessingML names them (`w:numFmt`). */
export type NumFmt =
  | "decimal"
  | "decimalZero"
  | "lowerLetter"
  | "upperLetter"
  | "lowerRoman"
  | "upperRoman"
  | "bullet";

export interface ListLevel {
  fmt: NumFmt;
  /**
   * Word `lvlText`: literal text with `%n` placeholders, where `%n` is the
   * counter of level n (1-based). e.g. `"%1.%2"` → "2.3"; a bullet level is a
   * plain glyph such as `"•"`.
   */
  text: string;
  /**
   * Word's `w:isLgl` ("legal numbering"): placeholders referring to the levels
   * ABOVE this one render in Arabic numerals whatever their own format is — how
   * "Article III." is followed by "Section 3.01" and not "Section III.01". Only
   * the level's own placeholder keeps its format.
   *
   * Exported as `<w:isLgl/>`; Word applies it to the whole level text, so it may
   * drop this level's own zero padding ("Section 3.1"). That is one digit of
   * divergence against getting the parent numeral plainly wrong.
   */
  legalRefs?: boolean;
}

export interface ListScheme {
  id: string;
  label: string;
  /** Which list node type the scheme applies to. */
  kind: "ordered" | "bullet";
  /** First three levels rendered as text, for the gallery preview. */
  preview: [string, string, string];
  levels: ListLevel[];
}

/** How many nesting depths the generated CSS covers (deeper reuses the last). */
export const MAX_CSS_DEPTH = 6;

export const LIST_SCHEMES: ListScheme[] = [
  {
    id: "outline",
    label: "1. / 1.1 / 1.1.1",
    kind: "ordered",
    preview: ["1.", "1.1", "1.1.1"],
    levels: [
      { fmt: "decimal", text: "%1." },
      { fmt: "decimal", text: "%1.%2" },
      { fmt: "decimal", text: "%1.%2.%3" },
      { fmt: "decimal", text: "%1.%2.%3.%4" },
      { fmt: "decimal", text: "%1.%2.%3.%4.%5" },
    ],
  },
  {
    id: "cascade",
    label: "1. / a. / i.",
    kind: "ordered",
    preview: ["1.", "a.", "i."],
    levels: [
      { fmt: "decimal", text: "%1." },
      { fmt: "lowerLetter", text: "%2." },
      { fmt: "lowerRoman", text: "%3." },
      { fmt: "decimal", text: "(%4)" },
      { fmt: "lowerLetter", text: "(%5)" },
    ],
  },
  {
    id: "roman",
    label: "I. / A. / 1.",
    kind: "ordered",
    preview: ["I.", "A.", "1."],
    levels: [
      { fmt: "upperRoman", text: "%1." },
      { fmt: "upperLetter", text: "%2." },
      { fmt: "decimal", text: "%3." },
      { fmt: "lowerLetter", text: "%4." },
      { fmt: "lowerRoman", text: "%5." },
    ],
  },
  {
    id: "legal",
    label: "Article I. / Section 1.01 / (a)",
    kind: "ordered",
    preview: ["Article I.", "Section 1.01", "(a)"],
    levels: [
      { fmt: "upperRoman", text: "Article %1." },
      { fmt: "decimalZero", text: "Section %1.%2", legalRefs: true },
      { fmt: "lowerLetter", text: "(%3)", legalRefs: true },
      { fmt: "lowerRoman", text: "(%4)", legalRefs: true },
      { fmt: "decimal", text: "%5)", legalRefs: true },
    ],
  },
  {
    id: "chapter",
    label: "Chapitre 1 / 1.1 / a)",
    kind: "ordered",
    preview: ["Chapitre 1", "1.1", "a)"],
    levels: [
      { fmt: "decimal", text: "Chapitre %1" },
      { fmt: "decimal", text: "%1.%2" },
      { fmt: "lowerLetter", text: "%3)" },
      { fmt: "lowerRoman", text: "%4)" },
      { fmt: "decimal", text: "(%5)" },
    ],
  },
  {
    id: "bullets",
    label: "• / ◦ / ▪",
    kind: "bullet",
    preview: ["•", "◦", "▪"],
    levels: [
      { fmt: "bullet", text: "•" },
      { fmt: "bullet", text: "◦" },
      { fmt: "bullet", text: "▪" },
      { fmt: "bullet", text: "–" },
      { fmt: "bullet", text: "·" },
    ],
  },
  {
    id: "arrows",
    label: "➤ / – / ·",
    kind: "bullet",
    preview: ["➤", "–", "·"],
    levels: [
      { fmt: "bullet", text: "➤" },
      { fmt: "bullet", text: "–" },
      { fmt: "bullet", text: "·" },
      { fmt: "bullet", text: "◦" },
      { fmt: "bullet", text: "▪" },
    ],
  },
];

const BY_ID = new Map(LIST_SCHEMES.map((s) => [s.id, s]));

/** Look a scheme up by id; unknown / empty ids give `null` (= native markers). */
export function schemeById(id: unknown): ListScheme | null {
  return typeof id === "string" && id ? BY_ID.get(id) ?? null : null;
}

/** The level definition for a 0-based nesting depth (deeper reuses the last). */
export function levelAt(scheme: ListScheme, depth: number): ListLevel {
  const i = Math.max(0, Math.min(scheme.levels.length - 1, depth));
  return scheme.levels[i]!;
}

// =========================================================================
// Numeral formatting (shared by markerText and any caller needing literals)
// =========================================================================

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function toRoman(n: number): string {
  if (n <= 0) return String(n);
  let v = Math.floor(n);
  let out = "";
  for (const [value, sym] of ROMAN) {
    while (v >= value) {
      out += sym;
      v -= value;
    }
  }
  return out;
}

/** Spreadsheet-style letters so the 27th item is "aa", not a wrapped "a". */
function toLetters(n: number): string {
  if (n <= 0) return String(n);
  let v = Math.floor(n);
  let out = "";
  while (v > 0) {
    const rem = (v - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    v = Math.floor((v - 1) / 26);
  }
  return out;
}

/** Render one counter value in the given format. */
export function formatNumeral(value: number, fmt: NumFmt): string {
  switch (fmt) {
    case "decimal": return String(value);
    case "decimalZero": return value < 10 ? `0${value}` : String(value);
    case "lowerLetter": return toLetters(value);
    case "upperLetter": return toLetters(value).toUpperCase();
    case "lowerRoman": return toRoman(value);
    case "upperRoman": return toRoman(value).toUpperCase();
    case "bullet": return "";
  }
}

/**
 * The marker a list item shows, given the scheme, its 0-based depth and the
 * live counter stack (`counters[i]` = the 1-based index at depth i).
 *
 * Used by the Markdown / plain-text exporters, which have no CSS to lean on.
 */
export function markerText(scheme: ListScheme, depth: number, counters: number[]): string {
  const level = levelAt(scheme, depth);
  if (level.fmt === "bullet") return level.text;
  return level.text.replace(/%(\d)/g, (_, d: string) => {
    const idx = Number(d) - 1;
    const value = counters[idx] ?? 1;
    return formatNumeral(value, refFmt(scheme, depth, idx));
  });
}

/** The format a `%n` placeholder uses inside the level at `depth`. */
function refFmt(scheme: ListScheme, depth: number, refIndex: number): NumFmt {
  const level = levelAt(scheme, depth);
  if (level.legalRefs && refIndex < depth) return "decimal";
  return levelAt(scheme, refIndex).fmt;
}

// =========================================================================
// CSS generation (screen + exported HTML/PDF share this exact string)
// =========================================================================

const CSS_FMT: Record<NumFmt, string> = {
  decimal: "decimal",
  decimalZero: "decimal-leading-zero",
  lowerLetter: "lower-alpha",
  upperLetter: "upper-alpha",
  lowerRoman: "lower-roman",
  upperRoman: "upper-roman",
  bullet: "none",
};

const counterName = (scheme: ListScheme, level1: number) => `elx-${scheme.id}-${level1}`;

function cssQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Turn a `lvlText` template into a CSS `content` value: literal runs become
 * quoted strings, `%n` becomes `counter(<name>, <format>)`.
 */
function contentValue(scheme: ListScheme, depth: number): string {
  const level = levelAt(scheme, depth);
  if (level.fmt === "bullet") return cssQuote(level.text);
  const parts: string[] = [];
  let literal = "";
  const flush = () => {
    if (literal) {
      parts.push(cssQuote(literal));
      literal = "";
    }
  };
  for (let i = 0; i < level.text.length; i++) {
    const ch = level.text[i]!;
    const next = level.text[i + 1];
    if (ch === "%" && next && next >= "1" && next <= "9") {
      flush();
      const idx = Number(next) - 1;
      parts.push(`counter(${counterName(scheme, idx + 1)}, ${CSS_FMT[refFmt(scheme, depth, idx)]})`);
      i++;
    } else {
      literal += ch;
    }
  }
  flush();
  return parts.length ? parts.join(" ") : '""';
}

/**
 * CSS implementing every scheme, for nesting depths 0..MAX_CSS_DEPTH-1.
 *
 * Markers are drawn with `::before` inside a two-column grid so a long marker
 * ("Article VIII.") never overlaps the text and nested content lines up under
 * it — a real hanging indent rather than an absolute overlay.
 *
 * `scope` prefixes every selector (".elium-prose" in the editor, "" for the
 * standalone HTML export).
 */
export function schemesCss(scope = ".elium-prose"): string {
  const p = scope ? `${scope} ` : "";
  const out: string[] = [];
  for (const scheme of LIST_SCHEMES) {
    const tag = scheme.kind === "ordered" ? "ol" : "ul";
    for (let depth = 0; depth < MAX_CSS_DEPTH; depth++) {
      // depth 0 = the list carrying the attribute; deeper = descendant lists of
      // the same kind, which inherit the scheme (Tab-created sublists included).
      const sel = `${p}${tag}[data-list-scheme="${scheme.id}"]${` ${tag}`.repeat(depth)}`;
      const name = counterName(scheme, depth + 1);
      out.push(
        `${sel}{counter-reset:${name};list-style:none;padding-left:0;margin-left:0}`,
        `${sel}>li{counter-increment:${name};display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:.55em;align-items:baseline}`,
        `${sel}>li::before{content:${contentValue(scheme, depth)};grid-column:1;grid-row:1;white-space:nowrap;font-variant-numeric:tabular-nums}`,
        `${sel}>li>*{grid-column:2}`,
      );
    }
    // Nested lists start one step further right, like Word's level indents.
    out.push(`${p}${tag}[data-list-scheme="${scheme.id}"] ${tag}{margin-top:.25em;padding-left:1.1em}`);
  }
  return out.join("\n");
}

// =========================================================================
// DOCX numbering.xml generation
// =========================================================================

const DOCX_FMT: Record<NumFmt, string> = {
  decimal: "decimal",
  decimalZero: "decimalZero",
  lowerLetter: "lowerLetter",
  upperLetter: "upperLetter",
  lowerRoman: "lowerRoman",
  upperRoman: "upperRoman",
  bullet: "bullet",
};

const xmlAttrEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** How many levels a DOCX abstractNum declares (Word's own lists declare 9). */
const DOCX_LEVELS = 9;

/**
 * A full `<w:abstractNum>` for a scheme: 9 levels with real `numFmt`/`lvlText`
 * and growing hanging indents, so Word owns the numbering and renumbers as the
 * user edits — the point of exporting a *scheme* rather than baked-in text.
 */
export function abstractNumXml(scheme: ListScheme, abstractNumId: number): string {
  const levels: string[] = [];
  for (let d = 0; d < DOCX_LEVELS; d++) {
    const level = levelAt(scheme, d);
    const left = 720 * (d + 1);
    const bulletFont =
      level.fmt === "bullet" ? '<w:rPr><w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:hint="default"/></w:rPr>' : "";
    levels.push(
      `<w:lvl w:ilvl="${d}">` +
        `<w:start w:val="1"/>` +
        `<w:numFmt w:val="${DOCX_FMT[level.fmt]}"/>` +
        (level.legalRefs && d > 0 ? "<w:isLgl/>" : "") +
        `<w:lvlText w:val="${xmlAttrEsc(level.text)}"/>` +
        `<w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr>` +
        bulletFont +
        `</w:lvl>`,
    );
  }
  return (
    `<w:abstractNum w:abstractNumId="${abstractNumId}">` +
    `<w:multiLevelType w:val="${scheme.kind === "bullet" ? "hybridMultilevel" : "multilevel"}"/>` +
    levels.join("") +
    `</w:abstractNum>`
  );
}

/**
 * Recover a scheme id from a DOCX abstractNum's per-level formats + texts, so a
 * multilevel list authored in Word comes back as the matching Elium scheme
 * instead of a plain list. Matching is on the first three levels (what the
 * gallery previews), normalised for whitespace.
 */
export function matchSchemeId(levels: { fmt: string; text: string }[]): string | null {
  if (!levels.length) return null;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  for (const scheme of LIST_SCHEMES) {
    const n = Math.min(3, levels.length, scheme.levels.length);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const mine = levelAt(scheme, i);
      const theirs = levels[i]!;
      if (DOCX_FMT[mine.fmt] !== theirs.fmt || norm(mine.text) !== norm(theirs.text)) {
        ok = false;
        break;
      }
    }
    if (ok) return scheme.id;
  }
  return null;
}
