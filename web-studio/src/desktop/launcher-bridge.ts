/**
 * Pont avec le lanceur de bureau (installer/elium_launcher.py).
 *
 * Quand Elium est déjà ouvert et que l'utilisateur double-clique un .elium, le
 * 2e lancement dépose le fichier auprès de l'instance en cours (au lieu de
 * démarrer un 2e serveur) ; la page l'apprend en interrogeant /__open_seq__ et
 * récupère le fichier sur /__open__. Hors lanceur (dev, PWA) ces routes
 * n'existent pas : la boucle s'arrête dès la 1re réponse inattendue.
 */

export interface LauncherFile {
  name: string;
  bytes: ArrayBuffer;
}

/** Lit le fichier actuellement servi sur /__open__ (undefined si aucun). */
export async function fetchLauncherFile(): Promise<LauncherFile | undefined> {
  const r = await fetch("/__open__");
  if (!r.ok) return undefined;
  const name = decodeURIComponent(r.headers.get("X-Elium-Name") ?? "document.elium");
  return { name, bytes: await r.arrayBuffer() };
}

/**
 * Surveille les fichiers transmis par un 2e lancement. Renvoie une fonction
 * d'arrêt. `onFile` est appelé une fois par fichier reçu.
 */
export function watchLauncherInbox(onFile: (f: LauncherFile) => void | Promise<void>, intervalMs = 1500): () => void {
  let stopped = false;
  let last: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    try {
      const r = await fetch("/__open_seq__");
      if (!r.ok) return;
      const body = (await r.json()) as { seq?: unknown };
      if (typeof body.seq !== "number") return; // pas le lanceur (ex. repli SPA du serveur de dev)
      if (last === null) {
        last = body.seq; // état de départ : ce qui précède le chargement de la page est déjà géré (?open=1)
      } else if (body.seq !== last) {
        last = body.seq;
        const file = await fetchLauncherFile();
        if (file) await onFile(file);
      }
    } catch {
      return; // lanceur absent : on cesse d'interroger
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
