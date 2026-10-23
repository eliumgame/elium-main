/**
 * Veille des tâches longues : un gel (fil principal occupé plus de 200 ms) est noté dans le
 * journal d'incidents local avec la vue en cours, pour qu'aucun blocage ne passe inaperçu.
 * Aucune télémétrie : rien ne quitte l'appareil. Les durées sont aussi exposées dans
 * `window.__eliumLongTasks` pour les tests de parcours (Playwright).
 */
import { logIncident } from "./crash-log";

/** Seuil de signalement (ms) : au-delà, l'interface est perceptiblement figée. */
export const LONG_TASK_MS = 200;
/** Gel jugé grave : noté sans limite de fréquence. */
const SEVERE_MS = 1000;
const MIN_GAP_MS = 10_000;

export interface LongTaskRecord {
  at: number;
  duration: number;
  view: string;
}

declare global {
  interface Window {
    __eliumLongTasks?: LongTaskRecord[];
  }
}

let installed = false;
/** Branche l'observateur (à appeler une fois au démarrage). Sans effet si le navigateur ne l'expose pas. */
export function installLongTaskWatcher(): void {
  if (installed || typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;
  if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
  installed = true;
  const records: LongTaskRecord[] = (window.__eliumLongTasks = []);
  let lastLogged = 0;
  const view = () => `${location.pathname}${location.hash}`.slice(0, 80) || "/";
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < LONG_TASK_MS) continue;
        const rec = { at: Math.round(e.startTime), duration: Math.round(e.duration), view: view() };
        if (records.length < 200) records.push(rec);
        const now = Date.now();
        if (rec.duration < SEVERE_MS && now - lastLogged < MIN_GAP_MS) continue;
        lastLogged = now;
        logIncident("gel", `Interface figée ${rec.duration} ms (vue ${rec.view})`);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* observateur indisponible : sans conséquence */
  }
}
