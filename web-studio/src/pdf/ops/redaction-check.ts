/**
 * Branchement de la vérification de caviardage : relève le texte SOUS chaque
 * zone caviardée avant l'enregistrement, puis relit le fichier écrit et
 * confirme que ce texte n'y figure plus (`redaction-verify.ts`).
 */
import type { PdfEngine } from "../core/engine";
import type { Rect } from "../core/coords";
import { layoutWords, type LayoutWord } from "./compare";
import { extractPageLayout } from "./export";
import { verifyRedaction, type RedactionVerification } from "./redaction-verify";

export interface RedactionMark {
  /** 0-based page index of the SOURCE document. */
  page: number;
  /** Page space (points, y down, unrotated). */
  rect: Rect;
}

const centreIn = (r: Rect, box: Rect) => {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
};

/** Pure : phrases (une par ligne et par zone) dont le centre des mots tombe dans la zone. */
export function phrasesUnder(words: readonly LayoutWord[], boxes: readonly Rect[]): string[] {
  const out: string[] = [];
  for (const box of boxes) {
    const byLine = new Map<number, string[]>();
    for (const w of words) if (centreIn(w.rect, box)) byLine.set(w.line, [...(byLine.get(w.line) ?? []), w.text]);
    for (const parts of byLine.values()) out.push(parts.join(" "));
  }
  return out;
}

export async function collectRedactedPhrases(engine: PdfEngine, marks: readonly RedactionMark[]): Promise<string[]> {
  const byPage = new Map<number, Rect[]>();
  for (const m of marks) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m.rect]);
  const out: string[] = [];
  for (const [page, boxes] of byPage) {
    if (page < 0 || page >= engine.pageCount) continue;
    out.push(...phrasesUnder(layoutWords(await extractPageLayout(engine, page)), boxes));
  }
  return out;
}

/** Relit `bytes` (le fichier tel qu'écrit) et cherche chaque phrase caviardée. */
export async function verifySavedFile(
  bytes: Uint8Array,
  phrases: readonly string[],
  open: (bytes: Uint8Array) => Promise<PdfEngine>,
): Promise<RedactionVerification> {
  const engine = await open(bytes);
  try {
    const texts: string[] = [];
    for (let i = 0; i < engine.pageCount; i++) {
      const tc = await engine.text(i);
      texts.push(tc.items.map((it) => it.str ?? "").join(" "));
    }
    return verifyRedaction(texts, phrases);
  } finally {
    engine.destroy();
  }
}
