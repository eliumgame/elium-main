/**
 * Font embedding for export. Resolves a family name + bold/italic to an
 * embedded `PDFFont`, caching per output document.
 *
 * Imported .ttf/.otf fonts are embedded (and subset) so any Unicode text
 * survives; the built-in families map to the 14 standard PDF fonts, which are
 * WinAnsi-only. `forText` picks, for a given text, a face that shows ALL of it
 * (a Unicode face embedded when WinAnsi is not enough — see unicodefonts.ts);
 * `sanitiseForFont` is the last resort for what no available face covers.
 */

import fontkit from "@pdf-lib/fontkit";
import { StandardFonts } from "pdf-lib";
import type { PDFDocument, PDFFont } from "pdf-lib";
import { DEFAULT_FONT, customFontNames, getCustomFont, isCustomFont, pdfFamilyOf } from "../../ui/fonts";
import { coverageOf, isWinAnsi, liberationBytes, uncovered, type FontStyle, type UnicodeFamily } from "./unicodefonts";

const STANDARD = {
  helvetica: {
    r: StandardFonts.Helvetica,
    b: StandardFonts.HelveticaBold,
    i: StandardFonts.HelveticaOblique,
    bi: StandardFonts.HelveticaBoldOblique,
  },
  times: {
    r: StandardFonts.TimesRoman,
    b: StandardFonts.TimesRomanBold,
    i: StandardFonts.TimesRomanItalic,
    bi: StandardFonts.TimesRomanBoldItalic,
  },
  courier: {
    r: StandardFonts.Courier,
    b: StandardFonts.CourierBold,
    i: StandardFonts.CourierOblique,
    bi: StandardFonts.CourierBoldOblique,
  },
} as const;

export interface EmbeddedFont {
  font: PDFFont;
  /** True when the font can encode arbitrary Unicode (an imported face). */
  unicode: boolean;
}

/** Per-document font cache. One instance lives for the length of one export. */
export class FontBook {
  private cache = new Map<string, EmbeddedFont>();
  private fontkitReady = false;

  constructor(private readonly doc: PDFDocument) {}

  async get(family: string | undefined, bold = false, italic = false): Promise<EmbeddedFont> {
    const fam = family || DEFAULT_FONT;
    const key = `${fam}|${bold ? "b" : ""}${italic ? "i" : ""}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    let result: EmbeddedFont;
    const custom = getCustomFont(fam);
    if (custom) {
      if (!this.fontkitReady) {
        this.doc.registerFontkit(fontkit);
        this.fontkitReady = true;
      }
      try {
        result = { font: await this.doc.embedFont(custom, { subset: true }), unicode: true };
      } catch {
        // A corrupt or unsupported face must not break the export.
        result = { font: await this.doc.embedFont(STANDARD.helvetica.r), unicode: false };
      }
    } else {
      const set = STANDARD[pdfFamilyOf(fam)];
      const which = bold && italic ? set.bi : bold ? set.b : italic ? set.i : set.r;
      result = { font: await this.doc.embedFont(which), unicode: false };
    }
    this.cache.set(key, result);
    return result;
  }

  /**
   * A face showing every character of `text`: the family's own when it can
   * (standard fonts: WinAnsi text), else Liberation Sans in the same weight
   * and slant, else an imported font covering it. `missing` lists what no
   * available face has (then pass the text through `sanitiseForFont`).
   */
  async forText(
    family: string | undefined,
    bold: boolean,
    italic: boolean,
    text: string,
  ): Promise<EmbeddedFont & { missing: string }> {
    const base = await this.get(family, bold, italic);
    if (base.unicode) {
      const bytes = getCustomFont(family || DEFAULT_FONT);
      const cov = bytes ? coverageOf(bytes) : null;
      if (!cov || !uncovered(text, cov)) return { ...base, missing: "" };
    } else if (isWinAnsi(text)) {
      return { ...base, missing: "" };
    }
    const style: FontStyle = bold && italic ? "bi" : bold ? "b" : italic ? "i" : "r";
    // The Liberation face metric-compatible with the family (Times → Serif, Courier → Mono).
    const uni: UnicodeFamily = { helvetica: "sans", times: "serif", courier: "mono" }[
      pdfFamilyOf(family || DEFAULT_FONT)
    ] as UnicodeFamily;
    const lib =
      (await liberationBytes(style, uni)) ?? (await liberationBytes("r", uni)) ?? (await liberationBytes(style));
    let missing = text;
    if (lib) {
      const cov = coverageOf(lib);
      missing = cov ? uncovered(text, cov) : text;
      if (!missing) return { ...(await this.embedBytes(`lib-${uni}-${style}`, lib)), missing: "" };
    }
    for (const name of customFontNames()) {
      const bytes = getCustomFont(name);
      const cov = bytes ? coverageOf(bytes) : null;
      if (!bytes || !cov || uncovered(text, cov)) continue;
      return { ...(await this.embedBytes(`custom-${name}`, bytes)), missing: "" };
    }
    return { ...base, missing };
  }

  private async embedBytes(key: string, bytes: Uint8Array): Promise<EmbeddedFont> {
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (!this.fontkitReady) {
      this.doc.registerFontkit(fontkit);
      this.fontkitReady = true;
    }
    const result = { font: await this.doc.embedFont(bytes, { subset: true }), unicode: true };
    this.cache.set(key, result);
    return result;
  }

  /** Helvetica — the fallback used by watermarks, headers and captions. */
  standard(bold = false, italic = false): Promise<EmbeddedFont> {
    return this.get("Helvetica", bold, italic);
  }
}

/** Stand-ins, for a standard (WinAnsi) font, of characters it lacks. */
const WINANSI_STAND_IN: Record<string, string> = {
  "\u2010": "-", // hyphen
  "\u2011": "-", // non-breaking hyphen
  "\u2012": "-", // figure dash
  "\u2015": "—", // horizontal bar
  "\u2212": "-", // minus sign
  "\u2032": "'", // prime
  "\u2033": '"', // double prime
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\u2002": " ",
  "\u2003": " ",
  "\u2007": " ",
  "\u2008": " ",
  "\u2009": " ",
  "\u200A": " ",
  "\u202F": "\u00A0", // narrow no-break space (French « : ; ! ? »)
  "\u200B": "", // zero-width space
  "\u00AD": "", // soft hyphen
};

/**
 * Text for a standard font: what WinAnsi has stays as is (typographic quotes,
 * dashes, « … », œ, € are all there); what it lacks gets its usual stand-in
 * or goes. The last resort, when `FontBook.forText` found no face covering
 * the text.
 */
export function sanitiseForFont(text: string, unicode: boolean): string {
  if (unicode) return text;
  let out = "";
  for (const ch of text) {
    if (isWinAnsi(ch)) out += ch;
    else if (ch in WINANSI_STAND_IN) out += WINANSI_STAND_IN[ch];
  }
  return out;
}

export { isCustomFont, DEFAULT_FONT };
