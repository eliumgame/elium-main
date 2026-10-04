/**
 * Couche OPTIONNELLE « Protéger avec Windows » : le conteneur du secret maître
 * (déjà chiffré par mot de passe) est ré-enveloppé par Windows DPAPI via le
 * lanceur de bureau (POST /__keystore__/wrap|unwrap, jeton de session).
 *
 * Ce n'est qu'une couche EN PLUS du mot de passe — jamais à sa place : copié sur
 * une autre machine ou un autre compte Windows, le blob reste indéchiffrable
 * (même avec le bon mot de passe) ; la phrase de récupération / `.eliumkey`
 * restent le chemin de secours. Hors lanceur (navigateur, PWA) ou hors Windows :
 * indisponible, le trousseau fonctionne comme avant.
 */
import { toHex, fromHex } from "../format/canonical";

export interface OsKeystore {
  wrap(hex: string): Promise<string>;
  unwrap(hex: string): Promise<string>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function sessionToken(): string | null {
  try {
    return document.querySelector<HTMLMetaElement>('meta[name="elium-token"]')?.content ?? null;
  } catch {
    return null;
  }
}

/** Client du lanceur. `fetchImpl`/`token` injectables pour les tests. */
export function createLauncherKeystore(
  fetchImpl: FetchLike = (i, o) => fetch(i, o),
  token: string | null = sessionToken(),
): OsKeystore | null {
  if (!token) return null; // pas de lanceur (jeton absent)
  const call = async (op: "wrap" | "unwrap", hex: string): Promise<string> => {
    const r = await fetchImpl(`/__keystore__/${op}`, {
      method: "POST",
      headers: { "X-Elium-Token": token, "Content-Type": "application/octet-stream" },
      body: fromHex(hex) as unknown as BodyInit,
    });
    if (r.status === 501) throw new Error("Le magasin de clés du système n'est pas disponible sur cette plateforme.");
    if (!r.ok) {
      throw new Error(
        op === "unwrap"
          ? "Windows a refusé de déverrouiller ce trousseau (autre compte ou autre machine). Utilisez la phrase de récupération."
          : "Windows n'a pas pu protéger le trousseau.",
      );
    }
    return toHex(new Uint8Array(await r.arrayBuffer()));
  };
  return { wrap: (h) => call("wrap", h), unwrap: (h) => call("unwrap", h) };
}

/** Sonde : le lanceur expose-t-il DPAPI ? (wrap d'un octet de test, puis unwrap). */
export async function osKeystoreAvailable(os: OsKeystore | null): Promise<boolean> {
  if (!os) return false;
  try {
    return (await os.unwrap(await os.wrap("00"))) === "00";
  } catch {
    return false;
  }
}
