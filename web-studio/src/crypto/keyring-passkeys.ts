/**
 * Passkeys (WebAuthn PRF) pour le trousseau LOCAL.
 *
 * Réutilise l'enveloppe du Drive (`wrapMaster` / `unwrapMaster`,
 * drive-cloud/prf-unlock.ts) mais pour le SECRET MAÎTRE du trousseau : chaque
 * passkey enrôlée (appareil + clé de sécurité, plusieurs possibles) en détient
 * une enveloppe indépendante ; n'importe laquelle déverrouille le trousseau,
 * révoquer l'une supprime son enveloppe sans toucher aux autres ni au mot de
 * passe. Si PRF n'est pas disponible (navigateur, authentificateur) le mot de
 * passe reste le chemin de repli.
 *
 * La cérémonie WebAuthn est derrière l'interface `PrfAuthenticator` : la logique
 * (enrôlement, déverrouillage, révocation) est testée avec un faux
 * authentificateur, l'implémentation navigateur reste mince.
 */
import { toHex, fromHex } from "../format/canonical";
import { wrapMaster, unwrapMaster, type PrfWrappedMaster } from "../drive-cloud/prf-unlock";
import { KeyringError, getMasterRecord, putMasterRecord, type KeyringStore, type PasskeySlot } from "./keyring";

/** Sel PRF propre au trousseau local (séparation de domaine avec le Drive). */
export const KEYRING_PRF_SALT_HEX = toHex(new TextEncoder().encode("elium-keyring/prf-unlock/v1\0\0\0\0\0"));

export interface PrfEvaluation {
  prfOutput: Uint8Array;
  credentialId: string; // base64url
}

export interface PrfAuthenticator {
  supported(): boolean;
  /** Crée une passkey ; retourne son identifiant ou null si l'utilisateur annule. */
  create(opts: {
    rpId: string;
    userName: string;
    label: string;
  }): Promise<{ credentialId: string; kind: PasskeySlot["kind"] } | null>;
  /** Évalue PRF avec l'une des clés `allow` (ou toute clé découvrable si vide). Null si PRF indisponible. */
  evaluate(opts: { rpId: string; allow: string[]; saltHex: string }): Promise<PrfEvaluation | null>;
}

export class PasskeyUnsupportedError extends KeyringError {}

/** Enrôle une passkey et enveloppe le secret maître sous son secret PRF. */
export async function enrollPasskey(
  store: KeyringStore,
  master: Uint8Array,
  auth: PrfAuthenticator,
  rpId: string,
  label: string,
  now: Date = new Date(),
): Promise<PasskeySlot> {
  if (!auth.supported()) throw new PasskeyUnsupportedError("Les clés d'accès (WebAuthn) ne sont pas disponibles ici.");
  const record = await getMasterRecord(store);
  if (!record) throw new KeyringError("Aucun secret maître : créez d'abord le trousseau.");
  const created = await auth.create({ rpId, userName: "Elium — trousseau local", label });
  if (!created) throw new KeyringError("Enrôlement annulé.");
  const ev = await auth.evaluate({ rpId, allow: [created.credentialId], saltHex: KEYRING_PRF_SALT_HEX });
  if (!ev) {
    throw new PasskeyUnsupportedError(
      "Cette clé d'accès ne prend pas en charge l'extension PRF : utilisez le mot de passe du trousseau.",
    );
  }
  const slot: PasskeySlot = {
    credentialId: ev.credentialId,
    label: label.trim() || "Clé d'accès",
    createdAt: now.toISOString(),
    kind: created.kind,
    prfSalt: KEYRING_PRF_SALT_HEX,
    wrapped: await wrapMaster(ev.prfOutput, master),
  };
  await putMasterRecord(store, {
    ...record,
    passkeys: [...record.passkeys.filter((p) => p.credentialId !== slot.credentialId), slot],
  });
  return slot;
}

/** Déverrouille : retourne le secret maître déchiffré par la passkey utilisée. */
export async function unlockWithPasskey(
  store: KeyringStore,
  auth: PrfAuthenticator,
  rpId: string,
): Promise<{ master: Uint8Array; slot: PasskeySlot }> {
  const record = await getMasterRecord(store);
  if (!record || record.passkeys.length === 0) throw new KeyringError("Aucune clé d'accès enrôlée pour ce trousseau.");
  if (!auth.supported()) throw new PasskeyUnsupportedError("Les clés d'accès (WebAuthn) ne sont pas disponibles ici.");
  const ev = await auth.evaluate({
    rpId,
    allow: record.passkeys.map((p) => p.credentialId),
    saltHex: KEYRING_PRF_SALT_HEX,
  });
  if (!ev) throw new PasskeyUnsupportedError("PRF indisponible sur cette clé d'accès : utilisez le mot de passe.");
  const slot = record.passkeys.find((p) => p.credentialId === ev.credentialId);
  if (!slot) throw new KeyringError("Cette clé d'accès n'est pas enrôlée sur ce trousseau.");
  try {
    return { master: await unwrapMaster(ev.prfOutput, slot.wrapped as PrfWrappedMaster), slot };
  } catch {
    throw new KeyringError("Clé d'accès non valide pour ce trousseau.");
  }
}

/** Révoque une passkey : supprime son enveloppe (les autres et le mot de passe restent valides). */
export async function revokePasskey(store: KeyringStore, credentialId: string): Promise<boolean> {
  const record = await getMasterRecord(store);
  if (!record) return false;
  const next = record.passkeys.filter((p) => p.credentialId !== credentialId);
  if (next.length === record.passkeys.length) return false;
  await putMasterRecord(store, { ...record, passkeys: next });
  return true;
}

// --- Implémentation navigateur (WebAuthn natif) ------------------------------

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export function createWebAuthnPrfAuthenticator(): PrfAuthenticator {
  return {
    supported: () =>
      typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined" && !!navigator.credentials,
    async create({ rpId, userName, label }) {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: buf(challenge),
          rp: { id: rpId, name: "Elium" },
          user: { id: buf(crypto.getRandomValues(new Uint8Array(16))), name: userName, displayName: label || userName },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
          timeout: 60_000,
          extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!cred) return null;
      const att = cred.response as AuthenticatorAttestationResponse;
      const transports = att.getTransports?.() ?? [];
      const kind: PasskeySlot["kind"] = transports.includes("internal")
        ? "platform"
        : transports.length > 0
          ? "cross-platform"
          : "unknown";
      return { credentialId: cred.id, kind };
    },
    async evaluate({ rpId, allow, saltHex }) {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const publicKey: PublicKeyCredentialRequestOptions = {
        challenge: buf(challenge),
        rpId,
        timeout: 60_000,
        userVerification: "required",
        extensions: { prf: { eval: { first: buf(fromHex(saltHex)) } } } as AuthenticationExtensionsClientInputs,
      };
      if (allow.length) publicKey.allowCredentials = allow.map((id) => ({ id: buf(unb64url(id)), type: "public-key" }));
      const assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
      if (!assertion) return null;
      const first = (assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf
        ?.results?.first;
      if (!first) return null;
      return { prfOutput: new Uint8Array(first), credentialId: b64url(new Uint8Array(assertion.rawId)) };
    },
  };
}
