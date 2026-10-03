/**
 * Journal d'incidents LOCAL (aucune télémétrie : rien ne quitte l'appareil).
 *
 * Garde les derniers incidents — erreurs non rattrapées, rejets de promesses,
 * crashs React, échecs d'écriture en arrière-plan — dans localStorage, pour
 * qu'un utilisateur puisse les consulter/exporter depuis les réglages ou
 * l'écran de récupération. Le contenu des documents n'y est jamais écrit :
 * uniquement le message, la pile technique, la version et l'heure.
 */

const KEY = "elium_crash_log";
const MAX_ENTRIES = 50;
const MAX_FIELD = 4000;

export interface CrashEntry {
  at: string;
  source: string;
  message: string;
  stack?: string;
}

function read(): CrashEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(entries: CrashEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    /* stockage plein ou indisponible : le journal est un confort, jamais bloquant */
  }
}

const clip = (s: string | undefined) => (s && s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "…" : s);

/** Enregistre un incident et le trace en console. Ne lève jamais. */
export function reportError(source: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : safeJson(err));
  console.error(`[elium:${source}]`, err);
  write([...read(), { at: new Date().toISOString(), source, message: clip(e.message) ?? "", stack: clip(e.stack) }]);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export function getCrashLog(): CrashEntry[] {
  return read();
}

export function clearCrashLog(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Journal formaté pour copie / export. */
export function formatCrashLog(version?: string): string {
  const head = `Elium${version ? " " + version : ""} — journal d'incidents (${new Date().toISOString()})`;
  const body = read()
    .map((e) => `[${e.at}] ${e.source}: ${e.message}${e.stack ? "\n" + e.stack : ""}`)
    .join("\n\n");
  return `${head}\n\n${body || "(aucun incident)"}\n`;
}

let installed = false;
/** Branche les gestionnaires globaux (à appeler une fois au démarrage). */
export function installGlobalCrashHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => reportError("window.onerror", ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => reportError("unhandledrejection", ev.reason));
}
