/**
 * Préférences de l'utilisateur (ce navigateur) : démarrage, apparence, édition,
 * sauvegarde. Stockées en JSON dans localStorage (`elium_prefs`), nettoyées et
 * bornées à la lecture (une valeur corrompue retombe sur le défaut, jamais
 * sur une erreur). La langue et le thème gardent leurs clés historiques.
 */
import { useSyncExternalStore } from "react";

export type StartupView = "home" | "library" | "recent";
export type Density = "comfortable" | "compact";

export interface Prefs {
  startupView: StartupView;
  /** Nombre d'éléments récents affichés sur l'accueil. */
  recentCount: number;
  density: Density;
  /** Police par défaut des NOUVEAUX documents ("" = celle du modèle). */
  defaultFont: string;
  /** Taille par défaut (px) des nouveaux documents (0 = celle du modèle). */
  defaultFontSize: number;
  /** Délai (s) entre deux enregistrements automatiques des brouillons de documents. */
  autosaveSeconds: number;
  /** Rappel de sauvegarde de l'espace de travail : tous les N jours (0 = jamais). */
  backupReminderDays: number;
  /** Dernière sauvegarde de l'espace de travail (ISO). */
  lastBackupAt: string;
  /** Rappel repoussé jusqu'à… (ISO). */
  backupSnoozedUntil: string;
}

export const DEFAULT_PREFS: Prefs = {
  startupView: "home",
  recentCount: 8,
  density: "comfortable",
  defaultFont: "",
  defaultFontSize: 0,
  autosaveSeconds: 3,
  backupReminderDays: 0,
  lastBackupAt: "",
  backupSnoozedUntil: "",
};

const KEY = "elium_prefs";

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const isoOr = (v: unknown): string => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : "");

/** Nettoie un objet quelconque en préférences valides. Pur. */
export function sanitizePrefs(raw: unknown): Prefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  return {
    startupView: oneOf(o.startupView, ["home", "library", "recent"] as const, d.startupView),
    recentCount: clampInt(o.recentCount, 4, 24, d.recentCount),
    density: oneOf(o.density, ["comfortable", "compact"] as const, d.density),
    defaultFont: typeof o.defaultFont === "string" ? o.defaultFont.slice(0, 80) : d.defaultFont,
    defaultFontSize: o.defaultFontSize === 0 ? 0 : clampInt(o.defaultFontSize, 8, 72, d.defaultFontSize),
    autosaveSeconds: clampInt(o.autosaveSeconds, 1, 60, d.autosaveSeconds),
    backupReminderDays: [0, 7, 14, 30].includes(Number(o.backupReminderDays)) ? Number(o.backupReminderDays) : 0,
    lastBackupAt: isoOr(o.lastBackupAt),
    backupSnoozedUntil: isoOr(o.backupSnoozedUntil),
  };
}

function read(): Prefs {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_PREFS;
  }
}

let current: Prefs = read();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return current;
}

export function setPrefs(patch: Partial<Prefs>): void {
  current = sanitizePrefs({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* stockage indisponible : la préférence vaut pour cette session seulement */
  }
  applyPrefsToDocument(current);
  for (const fn of listeners) fn();
}

export function resetPrefs(): void {
  setPrefs({ ...DEFAULT_PREFS });
}

/** Densité : attribut sur <html>, lu par les feuilles de style. */
export function applyPrefsToDocument(p: Prefs): void {
  if (typeof document !== "undefined") document.documentElement.dataset.density = p.density;
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getPrefs,
    getPrefs,
  );
}

// --- Rappel de sauvegarde (pur) -----------------------------------------------

/** Faut-il rappeler la sauvegarde de l'espace de travail ? */
export function backupReminderDue(
  p: Pick<Prefs, "backupReminderDays" | "lastBackupAt" | "backupSnoozedUntil">,
  now: Date,
  hasContent: boolean,
): boolean {
  if (!hasContent || p.backupReminderDays <= 0) return false;
  if (p.backupSnoozedUntil && new Date(p.backupSnoozedUntil).getTime() > now.getTime()) return false;
  if (!p.lastBackupAt) return true;
  return now.getTime() - new Date(p.lastBackupAt).getTime() >= p.backupReminderDays * 24 * 3600 * 1000;
}
