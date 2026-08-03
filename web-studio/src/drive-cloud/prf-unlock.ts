/**
 * Déverrouillage par clé d'accès (WebAuthn PRF).
 *
 * Modèle : Elium reste zéro-connaissance. La `masterKey` (qui déchiffre le
 * paquet de clés privées) dérive normalement de la passphrase (Argon2id). Ce
 * module ajoute un SECOND chemin de déverrouillage LOCAL : l'extension PRF de
 * WebAuthn permet à une passkey de produire, à la demande et après vérification
 * de l'utilisateur (Touch ID / Windows Hello / clé matérielle), un secret stable
 * de 32 octets propre à cet authentificateur. On en dérive une clé
 * d'enveloppe (HKDF) qui chiffre la `masterKey`. Le blob chiffré vit en
 * localStorage, à côté du `snapshot` (keyBundle) déjà présent : il est INUTILE
 * sans le secret PRF, que seul l'authentificateur peut régénérer. Le serveur ne
 * voit jamais rien de tout cela.
 *
 * La cérémonie PRF passe par l'API WebAuthn NATIVE (et non par
 * @simplewebauthn/browser) : on maîtrise ainsi précisément la conversion des
 * ArrayBuffer de l'extension `prf`, dont la prise en charge par les surcouches
 * reste inégale.
 */
import { toHex, fromHex } from "../format/canonical";

const enc = new TextEncoder();
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

const STORAGE_KEY = "elium_drive_prf_v1";
const WRAP_INFO = "elium-drive/prf-unlock/1";
const WRAP_AAD = enc.encode("elium-drive/prf-master/1");

// --- base64url <-> octets (identifiant de credential) ----------------------

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- Enveloppe chiffrée de la masterKey (pur, testable) ---------------------

export interface PrfWrappedMaster {
  v: 1;
  alg: "aes-256-gcm";
  nonce: string; // hex
  ct: string; // hex
}

/** Dérive la clé d'enveloppe AES-256 à partir de la sortie PRF (32 octets). */
async function deriveWrapKey(prfOutput: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", buf(prfOutput), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(new Uint8Array(32)), info: buf(enc.encode(WRAP_INFO)) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Chiffre la masterKey sous la clé dérivée du secret PRF. */
export async function wrapMaster(prfOutput: Uint8Array, masterKey: Uint8Array): Promise<PrfWrappedMaster> {
  const key = await deriveWrapKey(prfOutput);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(WRAP_AAD) }, key, buf(masterKey)),
  );
  return { v: 1, alg: "aes-256-gcm", nonce: toHex(nonce), ct: toHex(ct) };
}

/** Déchiffre la masterKey. Lève si le secret PRF est mauvais (GCM authentifié). */
export async function unwrapMaster(prfOutput: Uint8Array, wrapped: PrfWrappedMaster): Promise<Uint8Array> {
  const key = await deriveWrapKey(prfOutput);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(fromHex(wrapped.nonce)), additionalData: buf(WRAP_AAD) },
    key,
    buf(fromHex(wrapped.ct)),
  );
  return new Uint8Array(pt);
}

// --- Enregistrement local (localStorage) ------------------------------------

export interface PrfRecord {
  email: string;
  credentialId: string; // base64url
  salt: string; // hex — sel d'évaluation PRF (par enregistrement)
  wrapped: PrfWrappedMaster;
}

type PrfStore = Record<string, PrfRecord>; // clé = email en minuscules

function readStore(): PrfStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PrfStore) : {};
  } catch {
    return {};
  }
}

function writeStore(store: PrfStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota / mode privé : le déverrouillage par clé sera juste indisponible */
  }
}

export function getPrfRecord(email: string): PrfRecord | null {
  return readStore()[email.trim().toLowerCase()] ?? null;
}

export function hasPrfRecord(email: string): boolean {
  return getPrfRecord(email) !== null;
}

export function savePrfRecord(rec: PrfRecord): void {
  const store = readStore();
  store[rec.email.trim().toLowerCase()] = rec;
  writeStore(store);
}

export function removePrfRecord(email: string): void {
  const store = readStore();
  delete store[email.trim().toLowerCase()];
  writeStore(store);
}

// --- Cérémonie PRF (API WebAuthn native) ------------------------------------

/** Le navigateur/l'appareil expose-t-il l'API WebAuthn ? */
export function webauthnSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined" && !!navigator.credentials;
}

interface PrfExtResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

export interface PrfEvalResult {
  prfOutput: Uint8Array;
  credentialId: string; // base64url de la clé réellement utilisée
}

/**
 * Évalue l'extension PRF via une assertion WebAuthn et renvoie le secret de
 * 32 octets (+ l'ID de la clé utilisée), ou `null` si l'authentificateur ne
 * prend pas PRF en charge. `credentialIdB64url` cible une clé précise ; s'il est
 * `null`, on laisse l'authentificateur proposer une clé découvrable (resident
 * key). `rpId` cadre l'assertion sur l'origine du Drive.
 */
export async function evaluatePrf(
  credentialIdB64url: string | null,
  saltHex: string,
  rpId: string,
): Promise<PrfEvalResult | null> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: buf(challenge),
    rpId,
    timeout: 60_000,
    userVerification: "required",
    extensions: { prf: { eval: { first: buf(fromHex(saltHex)) } } } as AuthenticationExtensionsClientInputs,
  };
  if (credentialIdB64url) {
    publicKey.allowCredentials = [{ id: buf(b64urlToBytes(credentialIdB64url)), type: "public-key" }];
  }
  const assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!assertion) return null;
  const results = assertion.getClientExtensionResults() as PrfExtResults;
  const first = results.prf?.results?.first;
  if (!first) return null;
  return { prfOutput: new Uint8Array(first), credentialId: assertion.id };
}

export interface PrfEnrollResult {
  credentialId: string;
  saltHex: string;
  prfOutput: Uint8Array;
}

/**
 * Tente d'obtenir un secret PRF pour une passkey afin d'activer le
 * déverrouillage local. `credentialIdB64url` cible la clé qu'on vient d'enrôler
 * (`attestation.id`) ; `null` laisse choisir une clé découvrable existante.
 * Renvoie `null` si PRF n'est pas disponible. Note : cela déclenche une
 * vérification utilisateur (assertion) — la sortie PRF n'est généralement pas
 * fournie à la création de la clé.
 */
export async function enrollPrf(credentialIdB64url: string | null, rpId: string): Promise<PrfEnrollResult | null> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const saltHex = toHex(salt);
  const evaluated = await evaluatePrf(credentialIdB64url, saltHex, rpId);
  if (!evaluated) return null;
  return { credentialId: evaluated.credentialId, saltHex, prfOutput: evaluated.prfOutput };
}

/** Origine → rpId effectif (host sans port), pour cadrer la cérémonie. */
export function rpIdFromOrigin(): string {
  try {
    return location.hostname || "localhost";
  } catch {
    return "localhost";
  }
}
