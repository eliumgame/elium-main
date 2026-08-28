/**
 * Signaux "mise en forme" — repère les traces qu'une relecture humaine laisse
 * rarement : un bloc collé depuis un autre document (police/taille qui
 * détonne, guillemets d'un autre style) ou une hiérarchie de titres qui saute
 * des niveaux. Chaque `Finding` cite les valeurs mesurées, jamais un simple
 * soupçon.
 */
import type { Finding, ParagraphModel, RunFormat } from "./types";

const MIN_WORDS_FOR_STYLE_CHECK = 5;
const FONT_SIZE_JUMP_PT = 2; // difference from the majority size that counts as a "jump"

interface StyleFingerprint {
  fontFamily: string | undefined;
  fontSize: number | undefined;
  boldRatio: number;
  italicRatio: number;
  charCount: number;
}

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/** Dominant family/size are the ones covering the most characters in the paragraph's runs. */
function fingerprintParagraph(paragraph: ParagraphModel): StyleFingerprint {
  const familyCounts = new Map<string, number>();
  const sizeCounts = new Map<number, number>();
  let charCount = 0;
  let boldChars = 0;
  let italicChars = 0;

  for (const run of paragraph.runs) {
    const len = run.text.length;
    if (len === 0) continue;
    charCount += len;
    if (run.bold) boldChars += len;
    if (run.italic) italicChars += len;
    if (run.fontFamily) familyCounts.set(run.fontFamily, (familyCounts.get(run.fontFamily) ?? 0) + len);
    if (run.fontSize !== undefined) sizeCounts.set(run.fontSize, (sizeCounts.get(run.fontSize) ?? 0) + len);
  }

  return {
    fontFamily: dominantKey(familyCounts),
    fontSize: dominantKey(sizeCounts),
    boldRatio: charCount ? boldChars / charCount : 0,
    italicRatio: charCount ? italicChars / charCount : 0,
    charCount,
  };
}

function dominantKey<T>(counts: Map<T, number>): T | undefined {
  let best: T | undefined;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/** Majority family+size across the whole document, weighted by character count. */
function documentFingerprint(fingerprints: StyleFingerprint[]): { fontFamily?: string; fontSize?: number } {
  const familyCounts = new Map<string, number>();
  const sizeCounts = new Map<number, number>();
  for (const fp of fingerprints) {
    if (fp.fontFamily) familyCounts.set(fp.fontFamily, (familyCounts.get(fp.fontFamily) ?? 0) + fp.charCount);
    if (fp.fontSize !== undefined) sizeCounts.set(fp.fontSize, (sizeCounts.get(fp.fontSize) ?? 0) + fp.charCount);
  }
  return { fontFamily: dominantKey(familyCounts), fontSize: dominantKey(sizeCounts) };
}

const CURLY_QUOTES = /[‘’“”]/g;
const STRAIGHT_QUOTES = /["']/g;

type QuoteStyle = "courbes" | "droites" | "mixte" | "aucune";

function quoteStyleOf(runs: RunFormat[]): QuoteStyle {
  const text = runs.map((r) => r.text).join("");
  const curly = (text.match(CURLY_QUOTES) ?? []).length;
  const straight = (text.match(STRAIGHT_QUOTES) ?? []).length;
  if (curly === 0 && straight === 0) return "aucune";
  if (curly > 0 && straight === 0) return "courbes";
  if (straight > 0 && curly === 0) return "droites";
  return "mixte";
}

function locationLabel(index: number): string {
  return `Paragraphe ${index + 1}`;
}

export function analyzeFormattingSignals(paragraphs: ParagraphModel[]): Finding[] {
  const findings: Finding[] = [];
  if (paragraphs.length === 0) return findings;

  const fingerprints = paragraphs.map(fingerprintParagraph);
  const majority = documentFingerprint(fingerprints);

  // ---- Police / taille incohérente ---------------------------------------
  if (majority.fontFamily || majority.fontSize !== undefined) {
    paragraphs.forEach((paragraph, i) => {
      if (wordCount(paragraph.text) < MIN_WORDS_FOR_STYLE_CHECK) return;
      const fp = fingerprints[i];
      if (!fp.fontFamily && fp.fontSize === undefined) return;

      const familyDiffers = !!majority.fontFamily && !!fp.fontFamily && fp.fontFamily !== majority.fontFamily;
      const sizeJump =
        majority.fontSize !== undefined &&
        fp.fontSize !== undefined &&
        Math.abs(fp.fontSize - majority.fontSize) >= FONT_SIZE_JUMP_PT;

      if (!familyDiffers && !sizeJump) return;

      const paragraphDesc = describeFingerprint(fp.fontFamily, fp.fontSize);
      const majorityDesc = describeFingerprint(majority.fontFamily, majority.fontSize);
      findings.push({
        id: `fmt-police-${i}`,
        category: "mise_en_forme",
        signal: "police_incoherente",
        label: "Police incohérente avec le reste du document",
        explanation:
          `Ce paragraphe utilise ${paragraphDesc} alors que le reste du document utilise ${majorityDesc}, ` +
          "ce qui évoque un bloc collé depuis une autre source.",
        severity: familyDiffers && sizeJump ? "moyen" : "faible",
        weight: familyDiffers && sizeJump ? 0.5 : 0.3,
        location: { paragraphIndex: i, label: locationLabel(i) },
        evidence: paragraphDesc,
      });
    });
  }

  // ---- Guillemets incohérents ---------------------------------------------
  const styleCounts = new Map<QuoteStyle, number>();
  const paragraphQuoteStyles: QuoteStyle[] = paragraphs.map((p) => quoteStyleOf(p.runs));
  for (const style of paragraphQuoteStyles) {
    if (style === "aucune") continue;
    styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
  }
  const totalQuoted = [...styleCounts.values()].reduce((a, b) => a + b, 0);
  const majorityQuoteStyle = dominantKey(styleCounts);
  if (majorityQuoteStyle && majorityQuoteStyle !== "mixte" && totalQuoted >= 3) {
    const majorityShare = (styleCounts.get(majorityQuoteStyle) ?? 0) / totalQuoted;
    if (majorityShare >= 0.7) {
      const opposite: QuoteStyle = majorityQuoteStyle === "courbes" ? "droites" : "courbes";
      paragraphQuoteStyles.forEach((style, i) => {
        if (style !== opposite) return;
        findings.push({
          id: `fmt-guillemets-${i}`,
          category: "mise_en_forme",
          signal: "guillemets_incoherents",
          label: "Style de guillemets incohérent",
          explanation:
            `Ce paragraphe utilise des guillemets ${opposite} alors que ${Math.round(majorityShare * 100)} % ` +
            `des paragraphes du document utilisent des guillemets ${majorityQuoteStyle}, ` +
            "signe classique d'un texte collé depuis une autre source.",
          severity: "faible",
          weight: 0.25,
          location: { paragraphIndex: i, label: locationLabel(i) },
        });
      });
    }
  }

  // ---- Irrégularités de niveaux de titres ---------------------------------
  let lastHeading = 0;
  paragraphs.forEach((paragraph, i) => {
    if (!paragraph.heading) return;
    if (lastHeading > 0 && paragraph.heading > lastHeading + 1) {
      findings.push({
        id: `fmt-titre-${i}`,
        category: "mise_en_forme",
        signal: "niveau_titre_irregulier",
        label: "Saut de niveau de titre",
        explanation: `Ce titre est de niveau ${paragraph.heading} et suit directement un titre de niveau ${lastHeading}, sans les niveaux intermédiaires.`,
        severity: "info",
        weight: 0,
        location: { paragraphIndex: i, label: locationLabel(i) },
      });
    }
    lastHeading = paragraph.heading;
  });

  return findings;
}

function describeFingerprint(fontFamily: string | undefined, fontSize: number | undefined): string {
  if (fontFamily && fontSize !== undefined) return `${fontFamily} ${fontSize}pt`;
  if (fontFamily) return fontFamily;
  if (fontSize !== undefined) return `${fontSize}pt`;
  return "une police non identifiée";
}
