/**
 * Découpe un paragraphe en segments texte/souligné-rouge pour `DocumentPreview` :
 * quand `evidence` d'un finding est une citation littérale du paragraphe, on
 * souligne exactement cette plage ; sinon (finding qui ne cite qu'un résumé,
 * ex. "3 clichés dans ce paragraphe") on souligne le paragraphe entier — mais
 * seulement s'il n'y a AUCUNE citation littérale ailleurs dans le paragraphe,
 * pour ne pas noyer une localisation précise sous un soulignement grossier.
 */

export interface PreviewFlag {
  id: string;
  paragraphIndex: number;
  label: string;
  evidence?: string;
}

export interface TextSegment {
  text: string;
  flagged: boolean;
  labels?: string[];
}

export function segmentParagraph(text: string, flags: readonly PreviewFlag[]): TextSegment[] {
  if (flags.length === 0 || !text) return [{ text, flagged: false }];

  const ranges: { start: number; end: number; label: string }[] = [];
  const wholeParagraphLabels: string[] = [];
  for (const f of flags) {
    const idx = f.evidence ? text.indexOf(f.evidence) : -1;
    if (idx !== -1 && f.evidence) ranges.push({ start: idx, end: idx + f.evidence.length, label: f.label });
    else wholeParagraphLabels.push(f.label);
  }

  if (ranges.length === 0) {
    return [{ text, flagged: true, labels: wholeParagraphLabels }];
  }

  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number; labels: string[] }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      last.labels.push(r.label);
    } else {
      merged.push({ start: r.start, end: r.end, labels: [r.label] });
    }
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start), flagged: false });
    segments.push({ text: text.slice(m.start, m.end), flagged: true, labels: m.labels });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), flagged: false });
  return segments;
}

/** Regroupe les flags par paragraphe pour un accès O(1) pendant le rendu. */
export function flagsByParagraph(flags: readonly PreviewFlag[]): Map<number, PreviewFlag[]> {
  const map = new Map<number, PreviewFlag[]>();
  for (const f of flags) {
    const list = map.get(f.paragraphIndex);
    if (list) list.push(f);
    else map.set(f.paragraphIndex, [f]);
  }
  return map;
}
