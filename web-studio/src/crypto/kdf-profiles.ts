/**
 * Profils Argon2id NOMMÉS — l'unique endroit où les coûts de dérivation sont
 * décidés. Avant ce module, trois jeux de paramètres vivaient dans trois
 * fichiers sans justification commune.
 *
 * Chaque profil répond à une question différente :
 *
 *  - `document` (t3 / 64 Mio / p1) : conteneur .elium, sauvegarde `.eliumkey`.
 *    Payé à CHAQUE ouverture d'un fichier protégé. 256 Mio provoquait des OOM
 *    sur mobile/onglets contraints, et en WASM (mono-thread) p>1 ne parallélise
 *    rien. 64 Mio/t3 reste très au-dessus du minimum OWASP 2023 (19 Mio/t2).
 *  - `account` (t3 / 256 Mio / p4) : racine du compte Drive. Payé une fois par
 *    connexion, et le verrou est la SEULE défense contre un vol de la base
 *    serveur (hors-ligne) : on accepte le coût. Les comptes existants gardent
 *    leurs paramètres, stockés côté serveur (`kdf` du compte) : ne PAS les
 *    changer ici sans migration.
 *  - `local-cache` (t2 / 19 Mio / p1) : brouillons et historique chiffrés dans
 *    IndexedDB, réécrits toutes les quelques secondes. Plancher OWASP.
 *
 * Les bornes de DÉCODAGE (anti-DoS mémoire par en-tête malveillant) sont
 * communes à tous les lecteurs et miroir de `core/container.py`.
 */

export interface Argon2Profile {
  readonly t: number;
  readonly m: number; // Kio
  readonly p: number;
}

export type KdfProfileName = "document" | "account" | "local-cache";

export const KDF_PROFILES: Readonly<Record<KdfProfileName, Argon2Profile>> = {
  document: { t: 3, m: 65536, p: 1 },
  account: { t: 3, m: 262144, p: 4 },
  "local-cache": { t: 2, m: 19456, p: 1 },
};

/** Bornes acceptées en lecture (miroir Python container.py). */
export const KDF_DECODE_BOUNDS = {
  t: [1, 6],
  m: [8192, 262144],
  p: [1, 16],
} as const;

export function kdfWithinBounds(k: { t: number; m: number; p: number }): boolean {
  const b = KDF_DECODE_BOUNDS;
  return (
    Number.isInteger(k.t) &&
    Number.isInteger(k.m) &&
    Number.isInteger(k.p) &&
    k.t >= b.t[0] &&
    k.t <= b.t[1] &&
    k.m >= b.m[0] &&
    k.m <= b.m[1] &&
    k.p >= b.p[0] &&
    k.p <= b.p[1]
  );
}
