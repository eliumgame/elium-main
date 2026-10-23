/**
 * Presenter ↔ audience sync contract. The main editor window is the source of
 * truth: it broadcasts the deck + current position over a BroadcastChannel; the
 * speaker's presenter window (opened at ?presenter=1) renders from those messages
 * and posts back navigation intents. This works identically for the local suite
 * and the Drive collaborative editor because all data flows from the already-open
 * main window — the popup never needs the vault, the server, or the Y.Doc.
 */
import type { Slide, SlideTheme } from "./model";

export const PRESENTER_CHANNEL = "elium-presenter";

export interface PresenterDeckMsg {
  type: "deck";
  slides: Slide[];
  theme: SlideTheme;
  title: string;
}
/**
 * Mise à jour incrémentale : l'ordre complet (`ids`) et SEULEMENT les diapositives modifiées depuis
 * le dernier envoi. Évite de cloner tout le deck (médias compris) à chaque frappe.
 */
export interface PresenterDeltaMsg {
  type: "delta";
  ids: string[];
  changed: Slide[];
  theme: SlideTheme;
  title: string;
}
export interface PresenterPosMsg {
  type: "pos";
  idx: number;
  step: number;
  startedAt: number;
  presenting: boolean;
}
export interface PresenterNavMsg {
  type: "nav";
  dir: "next" | "prev";
}
export interface PresenterReadyMsg {
  type: "ready";
}
export interface PresenterEndMsg {
  type: "end";
}
export type PresenterMsg =
  PresenterDeckMsg | PresenterDeltaMsg | PresenterPosMsg | PresenterNavMsg | PresenterReadyMsg | PresenterEndMsg;

/**
 * Prépare un delta par rapport aux diapositives déjà envoyées (`sent`, mis à jour en place) ;
 * `null` si rien n'a changé du tout (ni ordre, ni contenu).
 */
export function makeDelta(sent: Map<string, Slide>, slides: Slide[]): { ids: string[]; changed: Slide[] } | null {
  const ids = slides.map((s) => s.id);
  const changed: Slide[] = [];
  for (const s of slides) if (sent.get(s.id) !== s) changed.push(s);
  let i = 0;
  let orderSame = ids.length === sent.size;
  if (orderSame) for (const id of sent.keys()) if (id !== ids[i++]) orderSame = false;
  if (!changed.length && orderSame) return null;
  sent.clear();
  for (const s of slides) sent.set(s.id, s);
  return { ids, changed };
}

/** Applique un delta côté fenêtre orateur ; `null` si une diapositive manque (il faut redemander le deck entier). */
export function applyDelta(current: Slide[], msg: PresenterDeltaMsg): Slide[] | null {
  const byId = new Map(current.map((s) => [s.id, s] as const));
  for (const s of msg.changed) byId.set(s.id, s);
  const out: Slide[] = [];
  for (const id of msg.ids) {
    const s = byId.get(id);
    if (!s) return null;
    out.push(s);
  }
  return out;
}
