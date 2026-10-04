/**
 * Détection d'une fermeture anormale et tri des brouillons récupérables — logique
 * PURE (le stockage est injecté), testée dans tests/workspace-recovery.test.ts.
 *
 * Principe : au démarrage on lit le marqueur de la session précédente. S'il
 * n'a pas été marqué « propre » (fermeture normale : événement `pagehide`),
 * Elium s'est arrêté brutalement (plantage, extinction, processus tué) et on
 * propose de récupérer ce qui n'avait pas été enregistré.
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SessionMarker {
  id: string;
  startedAt: string;
  /** Vrai une fois la page fermée normalement. */
  clean: boolean;
}

export const SESSION_KEY = "elium_session";

export function readMarker(storage: KeyValueStorage): SessionMarker | null {
  try {
    const raw = storage.getItem(SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SessionMarker>;
    if (typeof v.id !== "string" || typeof v.startedAt !== "string") return null;
    return { id: v.id, startedAt: v.startedAt, clean: v.clean === true };
  } catch {
    return null;
  }
}

export interface StartResult {
  /** La session précédente ne s'est pas terminée proprement. */
  uncleanExit: boolean;
  /** Début de cette session précédente (pour dire « depuis… »). */
  previousStartedAt: string | null;
  marker: SessionMarker;
}

/** À appeler une fois au démarrage : lit la session précédente puis ouvre la nouvelle. */
export function startSession(storage: KeyValueStorage, now: Date, newId: () => string): StartResult {
  const previous = readMarker(storage);
  const marker: SessionMarker = { id: newId(), startedAt: now.toISOString(), clean: false };
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(marker));
  } catch {
    /* stockage indisponible : on ne peut pas détecter, on ne prétend pas le contraire */
  }
  return { uncleanExit: !!previous && !previous.clean, previousStartedAt: previous?.startedAt ?? null, marker };
}

/** Fermeture normale. Ne touche rien si une AUTRE session a pris la place du marqueur. */
export function endSession(storage: KeyValueStorage, sessionId: string): void {
  const cur = readMarker(storage);
  if (!cur || cur.id !== sessionId) return;
  try {
    storage.setItem(SESSION_KEY, JSON.stringify({ ...cur, clean: true }));
  } catch {
    /* rien à faire */
  }
}

// --- Brouillons ------------------------------------------------------------

export interface DraftLike {
  id: string;
  title: string;
  updatedAt: string;
  size: number;
  protected: boolean;
  legacy?: boolean;
  preview?: string;
}

export interface RecoverableDraft extends DraftLike {
  /** Un enregistrement de la bibliothèque est aussi récent : ce brouillon n'apporte rien de plus. */
  saved: boolean;
  /** Modifié après le début de la session précédente (donc probablement perdu dans la fermeture anormale). */
  fromLastSession: boolean;
}

/**
 * Classe les brouillons : « enregistré » quand la bibliothèque contient déjà une
 * version au moins aussi récente (rien à récupérer), sinon « à récupérer ».
 * `libraryDates` : date d'enregistrement par identifiant de document.
 */
export function classifyDrafts(
  drafts: DraftLike[],
  libraryDates: Map<string, string>,
  previousStartedAt: string | null,
): RecoverableDraft[] {
  return drafts
    .map((d) => {
      const lib = libraryDates.get(d.id);
      return {
        ...d,
        saved: !!lib && lib >= d.updatedAt,
        fromLastSession: !!previousStartedAt && d.updatedAt >= previousStartedAt,
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** Ce qu'il faut proposer au démarrage après une fermeture anormale (jamais les brouillons déjà enregistrés). */
export function offerAfterCrash(classified: RecoverableDraft[]): RecoverableDraft[] {
  return classified.filter((d) => !d.saved);
}

/** Aperçu court (une ligne) d'un texte de document. */
export function previewOf(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
