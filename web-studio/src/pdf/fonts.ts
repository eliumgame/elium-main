/**
 * PDF-side font embedding (pdf-lib). Names/CSS/custom bytes come from the shared
 * registry in `ui/fonts.ts`; here we only resolve a name to an embedded PDFFont.
 */
import fontkit from "@pdf-lib/fontkit";
import { StandardFonts, type PDFDocument, type PDFFont } from "pdf-lib";
import { DEFAULT_FONT, getCustomFont, isCustomFont, pdfFamilyOf } from "../ui/fonts";

const STD = {
  helvetica: { r: StandardFonts.Helvetica, b: StandardFonts.HelveticaBold, i: StandardFonts.HelveticaOblique, bi: StandardFonts.HelveticaBoldOblique },
  times: { r: StandardFonts.TimesRoman, b: StandardFonts.TimesRomanBold, i: StandardFonts.TimesRomanItalic, bi: StandardFonts.TimesRomanBoldItalic },
  courier: { r: StandardFonts.Courier, b: StandardFonts.CourierBold, i: StandardFonts.CourierOblique, bi: StandardFonts.CourierBoldOblique },
} as const;

/**
 * Embed (and cache, per document) the right font variant. Returns whether the
 * resolved font is Unicode-capable (imported) so the caller can skip WinAnsi
 * sanitisation. Falls back to Helvetica on any failure.
 */
export async function embedFont(
  doc: PDFDocument,
  cache: Map<string, PDFFont>,
  family: string | undefined,
  bold = false,
  italic = false,
): Promise<{ font: PDFFont; unicode: boolean }> {
  const fam = family || DEFAULT_FONT;
  const key = `${fam}|${bold ? "b" : ""}${italic ? "i" : ""}`;
  const cached = cache.get(key);
  if (cached) return { font: cached, unicode: isCustomFont(fam) };

  let font: PDFFont;
  let unicode = false;
  const custom = getCustomFont(fam);
  if (custom) {
    doc.registerFontkit(fontkit);
    font = await doc.embedFont(custom, { subset: true });
    unicode = true;
  } else {
    const s = STD[pdfFamilyOf(fam)];
    const which = bold && italic ? s.bi : bold ? s.b : italic ? s.i : s.r;
    font = await doc.embedFont(which);
  }
  cache.set(key, font);
  return { font, unicode };
}
