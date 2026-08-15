/**
 * WebAuthn / passkeys en **second facteur**.
 *
 * Rappel du modèle : Elium est zéro-connaissance ; la clé maîtresse dérive de la
 * passphrase (Argon2id) côté client. WebAuthn prouve la possession d'un
 * authentificateur AU SERVEUR mais ne produit AUCUNE clé de chiffrement. Il ne
 * peut donc pas remplacer la connexion — il vient en 2e facteur, à côté du TOTP.
 *
 * Ce module encapsule @simplewebauthn/server et le stockage : clés enregistrées
 * (clé publique + compteur anti-clonage) et défi courant par (utilisateur, usage)
 * pour empêcher le rejeu (la vérification exige le défi exact émis).
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { query, queryOne } from "../db/pool.js";
import { config } from "../config.js";

const CHALLENGE_TTL_SEC = 300;
export type WebauthnPurpose = "register" | "auth";

export interface CredentialRow {
  id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string; // BIGINT → chaîne via node-postgres
  transports: string[] | null;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** Les clés enregistrées d'un utilisateur. */
export function listCredentials(userId: string): Promise<CredentialRow[]> {
  return query<CredentialRow>(
    `SELECT id, credential_id, public_key, counter, transports, name, created_at, last_used_at
       FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
}

/** Vrai si l'utilisateur a au moins une clé WebAuthn (⇒ 2e facteur requis). */
export async function hasWebauthn(userId: string): Promise<boolean> {
  const r = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM webauthn_credentials WHERE user_id = $1`, [
    userId,
  ]);
  return (r?.n ?? 0) > 0;
}

/** Pose le défi courant (un par utilisateur et par usage), à courte durée de vie. */
async function setChallenge(userId: string, purpose: WebauthnPurpose, challenge: string): Promise<void> {
  await query(
    `INSERT INTO webauthn_challenges (user_id, purpose, challenge, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
     ON CONFLICT (user_id, purpose) DO UPDATE
       SET challenge = EXCLUDED.challenge, expires_at = EXCLUDED.expires_at`,
    [userId, purpose, challenge, String(CHALLENGE_TTL_SEC)],
  );
}

/** Récupère ET consomme (usage unique) le défi courant, ou null s'il a expiré. */
async function consumeChallenge(userId: string, purpose: WebauthnPurpose): Promise<string | null> {
  const row = await queryOne<{ challenge: string; expired: boolean }>(
    `DELETE FROM webauthn_challenges
      WHERE user_id = $1 AND purpose = $2
      RETURNING challenge, (expires_at < now()) AS expired`,
    [userId, purpose],
  );
  if (!row || row.expired) return null;
  return row.challenge;
}

// --- Cérémonie d'enregistrement (utilisateur authentifié) ------------------

export async function registrationOptions(
  userId: string,
  email: string,
  displayName: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await listCredentials(userId);
  const options = await generateRegistrationOptions({
    rpName: config.webauthnRpName,
    rpID: config.webauthnRpId,
    userID: new TextEncoder().encode(userId),
    userName: email,
    userDisplayName: displayName || email,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as never,
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    // Demande l'extension PRF : les authentificateurs compatibles provisionnent
    // un secret dérivable, qui sert au déverrouillage LOCAL de la clé maîtresse
    // (cf. web-studio/src/drive-cloud/prf-unlock.ts). Le serveur ne l'utilise
    // jamais — il reste zéro-connaissance, PRF est purement côté client.
    extensions: { prf: {} } as never,
  });
  await setChallenge(userId, "register", options.challenge);
  return options;
}

export async function verifyRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  name: string,
): Promise<boolean> {
  const expectedChallenge = await consumeChallenge(userId, "register");
  if (!expectedChallenge) return false;
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.corsOrigins,
      expectedRPID: config.webauthnRpId,
      requireUserVerification: false,
    });
  } catch {
    return false;
  }
  if (!verification.verified || !verification.registrationInfo) return false;
  const { credential } = verification.registrationInfo;
  await query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (credential_id) DO NOTHING`,
    [
      userId,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports ?? null,
      name.slice(0, 64),
    ],
  );
  return true;
}

// --- Cérémonie d'authentification (2e facteur, userId issu du mfaToken) -----

export async function authenticationOptions(userId: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const creds = await listCredentials(userId);
  const options = await generateAuthenticationOptions({
    rpID: config.webauthnRpId,
    userVerification: "preferred",
    allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: (c.transports ?? undefined) as never })),
  });
  await setChallenge(userId, "auth", options.challenge);
  return options;
}

export async function verifyAuthentication(userId: string, response: AuthenticationResponseJSON): Promise<boolean> {
  const expectedChallenge = await consumeChallenge(userId, "auth");
  if (!expectedChallenge) return false;
  // La réponse désigne l'ID de la clé utilisée : on charge la clé correspondante.
  const cred = await queryOne<CredentialRow>(
    `SELECT id, credential_id, public_key, counter, transports, name, created_at, last_used_at
       FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2`,
    [userId, response.id],
  );
  if (!cred) return false;
  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.corsOrigins,
      expectedRPID: config.webauthnRpId,
      requireUserVerification: false,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(cred.public_key),
        counter: Number(cred.counter),
        transports: (cred.transports ?? undefined) as never,
      },
    });
  } catch {
    return false;
  }
  if (!verification.verified) return false;
  // Compteur anti-clonage : on avance le compteur stocké. Une régression aurait
  // fait échouer verifyAuthenticationResponse ci-dessus (clé clonée détectée).
  await query(`UPDATE webauthn_credentials SET counter = $3, last_used_at = now() WHERE id = $1 AND user_id = $2`, [
    cred.id,
    userId,
    verification.authenticationInfo.newCounter,
  ]);
  return true;
}

// --- Connexion SANS mot de passe (WebAuthn 1er facteur, clé découvrable) -----
//  L'utilisateur n'est PAS connu avant la cérémonie : allowCredentials est vide,
//  l'authentificateur propose une clé « resident » et renvoie son credential_id,
//  d'où l'on retrouve l'utilisateur. Aucun e-mail n'est demandé → pas d'oracle
//  d'énumération. La vérification utilisateur (biométrie/PIN) est EXIGÉE : la clé
//  devient alors un facteur de possession + inhérence fort, équivalent connexion.

/** Défi de connexion découvrable (non lié à un utilisateur), à usage unique. */
export async function createLoginChallenge(challenge: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO webauthn_login_challenges (challenge, expires_at)
     VALUES ($1, now() + ($2 || ' seconds')::interval) RETURNING id`,
    [challenge, String(CHALLENGE_TTL_SEC)],
  );
  return row!.id;
}

/** Récupère ET consomme (usage unique) le défi de connexion, ou null si expiré. */
export async function consumeLoginChallenge(id: string): Promise<string | null> {
  const row = await queryOne<{ challenge: string; expired: boolean }>(
    `DELETE FROM webauthn_login_challenges WHERE id = $1
      RETURNING challenge, (expires_at < now()) AS expired`,
    [id],
  );
  if (!row || row.expired) return null;
  return row.challenge;
}

export async function discoverableAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: config.webauthnRpId,
    userVerification: "required",
    allowCredentials: [], // clé découvrable : l'authentificateur choisit
  });
}

/** Vérifie une assertion découvrable ; renvoie l'ID utilisateur ou null. La clé
 *  est retrouvée par son credential_id ; le défi attendu vient de l'appelant. */
export async function verifyDiscoverableAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<string | null> {
  const cred = await queryOne<CredentialRow & { user_id: string }>(
    `SELECT id, user_id, credential_id, public_key, counter, transports, name, created_at, last_used_at
       FROM webauthn_credentials WHERE credential_id = $1`,
    [response.id],
  );
  if (!cred) return null;
  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.corsOrigins,
      expectedRPID: config.webauthnRpId,
      requireUserVerification: true,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(cred.public_key),
        counter: Number(cred.counter),
        transports: (cred.transports ?? undefined) as never,
      },
    });
  } catch {
    return null;
  }
  if (!verification.verified) return null;
  await query(`UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1`, [
    cred.id,
    verification.authenticationInfo.newCounter,
  ]);
  return cred.user_id;
}
