/**
 * Calcul par tranches d'un masque de lignes (filtre actif) : sur une feuille de plusieurs centaines
 * de milliers de lignes, évaluer chaque cellule filtrée d'un seul bloc figeait l'interface à chaque
 * modification. On rend la main au navigateur toutes les `SLICE_MS` ms ; l'appelant peut annuler.
 */
const SLICE_MS = 8;
const CHECK_EVERY = 64;

/** En dessous de ce nombre de lignes, le calcul synchrone reste plus simple et assez rapide. */
export const SYNC_ROWS_MAX = 4000;

const nextTurn = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Masque `1` = ligne masquée. Renvoie `null` si `cancelled()` devient vrai en cours de route
 * (un calcul plus récent a pris le relais).
 */
export async function hiddenRowsCooperative(
  rows: number,
  visible: (r: number) => boolean,
  cancelled: () => boolean,
): Promise<Uint8Array | null> {
  const out = new Uint8Array(rows);
  let last = performance.now();
  for (let r = 0; r < rows; r++) {
    out[r] = visible(r) ? 0 : 1;
    if (r % CHECK_EVERY === 0 && performance.now() - last >= SLICE_MS) {
      await nextTurn();
      if (cancelled()) return null;
      last = performance.now();
    }
  }
  return cancelled() ? null : out;
}
