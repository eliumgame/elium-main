/**
 * Unicode text in the PDFs Elium writes. The 14 standard fonts only encode
 * WinAnsi (Latin-1 plus a few typographic signs): « Łódź », Greek, Cyrillic,
 * Vietnamese… need an embedded face. Liberation Sans ships with pdf.js' assets
 * (so it is there offline, in the desktop app and in the Drive alike); a font
 * the user imported is the next candidate. Shared by field appearances,
 * rewritten paragraphs, comments, page marks and the OCR text layer.
 */

import fontkit from "@pdf-lib/fontkit";
import { StandardFonts } from "pdf-lib";

export type FontStyle = "r" | "b" | "i" | "bi";

const LIBERATION: Record<FontStyle, string> = {
  r: "LiberationSans-Regular.ttf",
  b: "LiberationSans-Bold.ttf",
  i: "LiberationSans-Italic.ttf",
  bi: "LiberationSans-BoldItalic.ttf",
};
export const STANDARD_STYLES: Record<FontStyle, StandardFonts> = {
  r: StandardFonts.Helvetica,
  b: StandardFonts.HelveticaBold,
  i: StandardFonts.HelveticaOblique,
  bi: StandardFonts.HelveticaBoldOblique,
};

const fontBytes = new Map<string, Promise<Uint8Array | null>>();

/** Bytes of one of pdf.js' bundled Liberation Sans faces (null when unavailable). */
export function liberationBytes(style: FontStyle): Promise<Uint8Array | null> {
  const file = LIBERATION[style];
  let p = fontBytes.get(file);
  if (!p) {
    p = (async () => {
      // Loaded on demand: keeps pdf.js out of what imports this module (forms.ts, tests).
      const urls = typeof document !== "undefined" ? (await import("../core/assets")).pdfjsAssetUrls() : null;
      if (urls) {
        const res = await fetch(`${urls.standardFontDataUrl}${file}`);
        if (!res.ok) return null;
        return new Uint8Array(await res.arrayBuffer());
      }
      // Node (tests, scripts): straight from node_modules.
      const proc = (globalThis as { process?: { cwd(): string } }).process;
      if (!proc) return null;
      const fsName = "node:fs/promises";
      const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(p: string): Promise<Uint8Array> };
      for (const dir of [
        "node_modules/pdfjs-dist/standard_fonts/",
        "web-studio/node_modules/pdfjs-dist/standard_fonts/",
      ]) {
        try {
          return new Uint8Array(await fs.readFile(`${proc.cwd()}/${dir}${file}`));
        } catch {
          /* next candidate */
        }
      }
      return null;
    })().catch(() => null);
    fontBytes.set(file, p);
  }
  return p;
}

export interface Coverage {
  hasGlyphForCodePoint(cp: number): boolean;
}
const coverageCache = new WeakMap<Uint8Array, Coverage | null>();
export function coverageOf(bytes: Uint8Array): Coverage | null {
  if (coverageCache.has(bytes)) return coverageCache.get(bytes)!;
  let c: Coverage | null = null;
  try {
    c = (fontkit as unknown as { create(b: Uint8Array): Coverage }).create(bytes);
  } catch {
    c = null;
  }
  coverageCache.set(bytes, c);
  return c;
}

const WINANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Can a standard (WinAnsi) font show every character of `text`? */
export function isWinAnsi(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 10 || c === 13 || c === 9) continue;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) continue;
    if (WINANSI_EXTRA.has(ch)) continue;
    return false;
  }
  return true;
}

/** Characters of `text` a font does not cover. */
export function uncovered(text: string, cov: Coverage): string {
  let out = "";
  for (const ch of new Set(text)) {
    const c = ch.codePointAt(0)!;
    if (c === 10 || c === 13 || c === 9 || c === 0x20) continue;
    if (!cov.hasGlyphForCodePoint(c)) out += ch;
  }
  return out;
}
