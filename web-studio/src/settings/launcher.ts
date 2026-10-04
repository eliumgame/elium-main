/**
 * Dialogue avec le lanceur de bureau (installer/elium_launcher.py) pour le port
 * d'écoute et le redémarrage. Hors lanceur (navigateur, mode dev) ces routes
 * répondent 404 : `fetchPorts()` renvoie alors null et l'interface l'explique.
 *
 * La validation et la description d'état sont PURES (tests/launcher-ports.test.ts).
 */

export interface PortInfo {
  current: number;
  configured: number | null;
  fallbackUsed: boolean;
  ports: { port: number; free: boolean }[];
}

export const PORT_MIN = 1024;
export const PORT_MAX = 65535;
/** Fenêtre utilisée quand le port est choisi automatiquement. */
export const AUTO_RANGE: [number, number] = [3000, 3100];

export type PortValidation =
  { ok: true; port: number } | { ok: false; reason: "empty" | "not_a_number" | "out_of_range" };

/** Valide la saisie d'un port (entier, 1024-65535). */
export function validatePortInput(raw: string): PortValidation {
  const s = raw.trim();
  if (s === "") return { ok: false, reason: "empty" };
  if (!/^\d+$/.test(s)) return { ok: false, reason: "not_a_number" };
  const n = Number(s);
  if (n < PORT_MIN || n > PORT_MAX) return { ok: false, reason: "out_of_range" };
  return { ok: true, port: n };
}

export type PortState =
  | { kind: "auto"; current: number }
  | { kind: "pinned"; current: number; configured: number }
  /** Le port épinglé était occupé au démarrage : un autre est utilisé cette fois. */
  | { kind: "fallback"; current: number; configured: number };

export function describePortState(info: PortInfo): PortState {
  if (info.configured == null) return { kind: "auto", current: info.current };
  if (info.fallbackUsed || info.configured !== info.current)
    return { kind: "fallback", current: info.current, configured: info.configured };
  return { kind: "pinned", current: info.current, configured: info.configured };
}

export const inAutoRange = (port: number): boolean => port >= AUTO_RANGE[0] && port <= AUTO_RANGE[1];

/** Le port saisi est-il signalé occupé par le lanceur (hors le port actuel d'Elium lui-même) ? */
export function isKnownBusy(info: PortInfo, port: number): boolean {
  if (port === info.current) return false;
  return info.ports.some((p) => p.port === port && !p.free);
}

/** Jeton anti-CSRF injecté par le lanceur dans une balise <meta name="elium-token">. */
export function eliumToken(): string {
  return document.querySelector('meta[name="elium-token"]')?.getAttribute("content") ?? "";
}

export async function fetchPorts(): Promise<PortInfo | null> {
  try {
    const r = await fetch("/__ports__", { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<PortInfo>;
    if (typeof j.current !== "number" || !Array.isArray(j.ports)) return null; // repli SPA du serveur de dev : pas le lanceur
    return { current: j.current, configured: j.configured ?? null, fallbackUsed: !!j.fallbackUsed, ports: j.ports };
  } catch {
    return null;
  }
}

export type SetPortResult = { ok: true; port: number | null } | { ok: false; reason: "busy" | "error" };

/** Épingle un port (null = automatique) pour les PROCHAINS démarrages. */
export async function setLauncherPort(port: number | null): Promise<SetPortResult> {
  try {
    const r = await fetch("/__ports__/set", {
      method: "POST",
      headers: { "X-Elium-Token": eliumToken(), "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
    if (!r.ok) return { ok: false, reason: "error" };
    const j = (await r.json()) as { ok?: boolean; port?: number | null; error?: string };
    if (j.ok) return { ok: true, port: j.port ?? null };
    return { ok: false, reason: j.error === "port-busy" ? "busy" : "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Demande au lanceur de redémarrer Elium ; la page se recharge quand le serveur répond de nouveau. */
export async function restartLauncher(): Promise<boolean> {
  try {
    const r = await fetch("/__update__/restart", { method: "POST", headers: { "X-Elium-Token": eliumToken() } });
    return r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/**
 * Après un redémarrage, l'ancien process meurt puis le nouveau reprend un port
 * (peut-être différent !) : on sonde l'adresse courante puis, si elle ne répond
 * plus, on cesse — l'utilisateur rouvrira Elium (la fenêtre desktop se rattache
 * au nouveau serveur). Renvoie une fonction d'arrêt.
 */
export function reloadWhenServerBack(maxAttempts = 40): () => void {
  let n = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    n++;
    fetch("/__version__", { cache: "no-store" })
      .then((r) => (r.ok ? window.location.reload() : retry()))
      .catch(retry);
  };
  const retry = () => {
    if (stopped) return;
    if (n < maxAttempts) setTimeout(tick, 500);
  };
  setTimeout(tick, 400);
  return () => {
    stopped = true;
  };
}
