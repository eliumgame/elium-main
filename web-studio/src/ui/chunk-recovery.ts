/**
 * Reprise après une mise à jour : une page restée ouverte pendant une mise à jour de l'application
 * réclame, au prochain module chargé à la demande (Tableur, PDF…), un fichier d'une ancienne version
 * qui n'existe plus (« Failed to fetch dynamically imported module »). Ce n'est pas un bogue du
 * document : il suffit de recharger. On le fait automatiquement UNE fois (garde anti-boucle), les
 * autosauvegardes étant conservées sur l'appareil. Sans cette reprise l'utilisateur voyait l'écran
 * « Elium a rencontré un problème ».
 */

const KEY = "elium_chunk_reload_at";
/** Une seconde tentative dans cette fenêtre signale un vrai problème (fichier réellement absent) : on n'insiste pas. */
const LOOP_WINDOW_MS = 60_000;

const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return CHUNK_ERROR.test(msg);
}

/** Recharge la page si ce n'est pas déjà arrivé à l'instant. Renvoie true si un rechargement est lancé. */
export function reloadForNewVersion(now = Date.now(), reload: () => void = () => window.location.reload()): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? "0");
    if (last && now - last < LOOP_WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    return false; // pas de stockage de session : impossible de garantir l'absence de boucle
  }
  reload();
  return true;
}

let installed = false;
/** Branche l'événement `vite:preloadError` (émis par Vite quand le préchargement d'un module échoue). */
export function installChunkRecovery(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("vite:preloadError", (ev) => {
    if (reloadForNewVersion()) ev.preventDefault();
  });
}
