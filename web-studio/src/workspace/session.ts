/**
 * Session de l'application : détecte une fermeture anormale de la précédente
 * (voir recovery.ts) UNE seule fois par chargement de page, même si React
 * double l'initialisation (mode strict en développement).
 */
import { endSession, startSession, type StartResult } from "./recovery";

let started: StartResult | null = null;

export function currentSession(): StartResult {
  if (started) return started;
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
  started = startSession(localStorage, new Date(), () => id);
  if (typeof window !== "undefined") {
    // « pagehide » couvre fermeture de fenêtre, rechargement et navigation ; un plantage ou un processus tué ne le déclenche pas.
    window.addEventListener("pagehide", () => endSession(localStorage, started!.marker.id));
  }
  return started;
}
