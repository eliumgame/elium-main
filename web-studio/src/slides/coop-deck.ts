/**
 * Sérialisation JSON d'une présentation par tranches : un deck de plusieurs centaines de
 * diapositives portant des images en data URL (des dizaines de Mo) ne doit pas bloquer
 * l'interface pendant l'autosauvegarde. Même principe que `sheet/coop-json.ts` : le JSON est
 * assemblé en `Blob` diapositive par diapositive, en rendant la main entre deux tranches.
 * Les petits decks gardent le chemin habituel (la fonction renvoie `null`).
 */
import type { Deck } from "./model";

/** Au-delà de ce volume approximatif (caractères de médias) ou de ce nombre de diapositives. */
const COOP_CHARS = 2 * 1024 * 1024;
const COOP_SLIDES = 60;
const SLICE_MS = 12;

const nextTurn = () => new Promise<void>((r) => setTimeout(r, 0));

/** Estimation de la taille sérialisée SANS sérialiser : somme des longueurs de `src` + marge par élément. */
export function estimateDeckChars(deck: Deck): number {
  let n = 0;
  for (const s of deck.slides) {
    n += 400;
    for (const e of s.elements ?? []) {
      n += 300;
      if (typeof e.src === "string") n += e.src.length;
      if (typeof e.media?.src === "string") n += e.media.src.length;
      if (typeof e.html === "string") n += e.html.length;
    }
    if (typeof s.background === "string") n += s.background.length;
  }
  return n;
}

/**
 * JSON déjà encodé de chaque diapositive, par référence : une diapositive inchangée entre deux
 * enregistrements (les mises à jour sont immuables) n'est ni re-sérialisée ni ré-encodée en UTF-8.
 * Seules les diapositives modifiées coûtent quelque chose à l'autosauvegarde suivante.
 */
const slideBlobs = new WeakMap<object, Blob>();

export async function stringifyDeckCooperative(deck: Deck): Promise<Blob | null> {
  if (deck.slides.length < COOP_SLIDES && estimateDeckChars(deck) < COOP_CHARS) return null;
  const { slides, ...top } = deck;
  const topJson = JSON.stringify(top);
  const pieces: Blob[] = [new Blob([`${topJson.slice(0, -1)}${topJson.length > 2 ? "," : ""}"slides":[`])];
  let last = performance.now();
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i]!;
    let b = slideBlobs.get(s);
    if (!b) {
      b = new Blob([JSON.stringify(s)]);
      slideBlobs.set(s, b);
    }
    if (i) pieces.push(new Blob([","]));
    pieces.push(b);
    if (performance.now() - last >= SLICE_MS) {
      await nextTurn();
      last = performance.now();
    }
  }
  pieces.push(new Blob(["]}"]));
  return new Blob(pieces, { type: "application/json" });
}
