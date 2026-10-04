/**
 * Un classeur ou une présentation « vierge » (jamais modifié depuis sa création)
 * n'est pas enregistré dans l'espace de travail : on évite ainsi de remplir la
 * bibliothèque d'éléments vides à chaque clic sur « Nouveau ».
 */
import type { Workbook } from "../sheet/model";
import { emptyDeck, withElements, type Deck } from "../slides/model";

export function isWorkbookPristine(wb: Workbook): boolean {
  return wb.sheets.every((s) => Object.keys(s.cells).length === 0 && !(s.styles && Object.keys(s.styles).length)) &&
    wb.sheets.length <= 1 &&
    !(wb.names && wb.names.length);
}

/** Retire récursivement les identifiants générés (ils changent à chaque création). */
function stripIds(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripIds);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "id") continue;
      out[k] = stripIds(val);
    }
    return out;
  }
  return v;
}

const normalize = (d: Deck) => JSON.stringify(stripIds({ ...d, slides: d.slides.map(withElements) }));

export function isDeckPristine(deck: Deck): boolean {
  return normalize(deck) === normalize(emptyDeck());
}
