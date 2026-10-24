/**
 * Registre des « pièces » modifiées depuis leur dernière sauvegarde dans le Drive (brouillons,
 * versions, polices, passeport…). Les magasins IndexedDB signalent un changement par `markDirty` ;
 * le moteur de synchronisation (drive-sync.ts) ne ré-envoie que ces pièces. Le registre est gardé en
 * localStorage : il survit au rechargement, donc un travail non encore envoyé l'est dès que le Drive
 * est de nouveau déverrouillé / en ligne (c'est la file d'attente hors ligne des pièces annexes).
 * Aucun import : ce module est appelé depuis les magasins sans créer de cycle.
 */
const KEY = "elium_sync_dirty_v1";
export const DIRTY_EVENT = "elium-sync-dirty";

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function write(s: Set<string>): void {
  try {
    if (s.size) localStorage.setItem(KEY, JSON.stringify([...s]));
    else localStorage.removeItem(KEY);
  } catch {
    /* stockage indisponible : le signal en mémoire (événement) reste */
  }
}

/** Signale qu'une pièce (`brouillons`, `versions`, `polices`, `passeport`, `parapheur`, `reglages`…) a changé. */
export function markDirty(piece: string): void {
  const s = read();
  if (!s.has(piece)) {
    s.add(piece);
    write(s);
  }
  try {
    window.dispatchEvent(new CustomEvent(DIRTY_EVENT, { detail: { piece } }));
  } catch {
    /* hors navigateur */
  }
}

export const dirtyPieces = (): string[] => [...read()];

/** Retire une pièce du registre (après un envoi réussi). */
export function clearDirty(piece: string): void {
  const s = read();
  if (s.delete(piece)) write(s);
}
