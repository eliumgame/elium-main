/**
 * Drive depuis l'app Windows : la CSP du lanceur (`connect-src 'self'`) interdit tout accès réseau
 * externe. Quand l'utilisateur a saisi l'URL de son serveur Drive (réglage `elium_drive_api_base`),
 * on déclare SON origine au lanceur (`/__drive_origin__`, protégé par le jeton de session), qui
 * l'ajoute à `connect-src` au chargement suivant ; la page se recharge alors UNE fois pour la prendre
 * en compte. Hors lanceur (site, PWA, dev) : aucun effet.
 */

const API_BASE_KEY = "elium_drive_api_base";
const RELOAD_FLAG = "elium_drive_origin_reload";

export interface DriveOriginEnv {
  fetchFn?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  session?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  token?: () => string | null;
  reload?: () => void;
}

/** Origine (`scheme://hôte[:port]`) de l'URL du serveur Drive saisie, ou null (relative, invalide, autre schéma). */
export function driveOriginOf(base: string | null | undefined): string | null {
  if (!base) return null;
  try {
    const u = new URL(base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Renvoie « reloaded » si la page va être rechargée pour appliquer la nouvelle CSP. */
export async function syncDriveOrigin(env: DriveOriginEnv = {}): Promise<"none" | "ok" | "reloaded" | "refused"> {
  const fetchFn = env.fetchFn ?? fetch;
  const storage = env.storage ?? localStorage;
  const session = env.session ?? sessionStorage;
  const token = (
    env.token ?? (() => document.querySelector<HTMLMetaElement>('meta[name="elium-token"]')?.content || null)
  )();
  const wanted = driveOriginOf(storage.getItem(API_BASE_KEY));
  if (!wanted || !token) return "none";
  try {
    const cur = await fetchFn("/__drive_origin__");
    if (!cur.ok || !(cur.headers.get("content-type") ?? "").includes("json")) return "none"; // pas le lanceur
    if (((await cur.json()) as { origin?: string | null }).origin === wanted) {
      session.removeItem(RELOAD_FLAG);
      return "ok";
    }
    const r = await fetchFn("/__drive_origin__", {
      method: "POST",
      headers: { "X-Elium-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: wanted }),
    });
    if (!r.ok) return "refused"; // ex. http hors boucle locale : le lanceur le refuse
    if (session.getItem(RELOAD_FLAG) === wanted) return "ok"; // déjà rechargé pour cette origine : pas de boucle
    session.setItem(RELOAD_FLAG, wanted);
    (env.reload ?? (() => location.reload()))();
    return "reloaded";
  } catch {
    return "none";
  }
}
