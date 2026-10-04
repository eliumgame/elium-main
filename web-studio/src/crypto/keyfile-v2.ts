/**
 * `.eliumkey` v2 — sauvegarde d'un TROUSSEAU : Ed25519 (signature) ET P-256
 * (réception), plus, si présent, le secret maître (dérivation déterministe).
 *
 * Structure du fichier (JSON) :
 *   { format:"elium-key", version:2, suite:"elium-keybundle/1",
 *     kdf:{alg:"argon2id",t,m,p}, cipher:"aes-256-gcm",
 *     keys:[ {kid,type,suite,label,createdAt,status,publicHex,fingerprint,…} ],
 *     enc:"<conteneur Elium hex>", exportedAt }
 *
 * Authentification de l'en-tête EXTERNE. Les champs en clair (kdf, cipher, suite,
 * keys) ne sont pas couverts par le chiffrement du conteneur ; on les lie donc au
 * contenu chiffré : le conteneur transporte `bound = SHA-256(JSON canonique de
 * l'en-tête externe)`. À l'ouverture on recalcule et on compare — toute
 * modification de `keys`, `kdf`, `cipher` ou `suite` est détectée. De plus, les
 * paramètres KDF/cipher du fichier doivent être EXACTEMENT ceux de l'en-tête du
 * conteneur (lui-même authentifié par AES-GCM + HMAC) : les étiquettes ne sont
 * plus décoratives.
 *
 * Agilité : `suite` identifie l'ensemble d'algorithmes. Un lecteur refuse une
 * suite inconnue au lieu de deviner. Miroir Python : elium/crypto/keybundle.py.
 */
import { strToU8, strFromU8 } from "fflate";
import { canonicalJSON, fromHex, sha256Hex, toHex } from "../format/canonical";
import { EliumCryptoEngine } from "./elium-crypto";
import { KDF_PROFILES, kdfWithinBounds } from "./kdf-profiles";
import { EliumKeyFileError, parseKeyFile, type StoredIdentity } from "../sign/identity-store";
import { isSuccessionShape, type SuccessionCert } from "../sign/succession";

export const KEYBUNDLE_FORMAT = "elium-key";
export const KEYBUNDLE_VERSION = 2;
export const KEYBUNDLE_SUITE = "elium-keybundle/1";

export type BundleKeyType = "identity-ed25519" | "recipient-p256";
export type BundleKeyStatus = "active" | "retired" | "revoked";

/** Suites d'algorithmes connues par type de clé. */
export const KEY_SUITES: Record<BundleKeyType, string> = {
  "identity-ed25519": "ed25519/1",
  "recipient-p256": "p256-ecdh-es/1",
};

export interface BundleKeyMeta {
  kid: string;
  type: BundleKeyType;
  suite: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  status: BundleKeyStatus;
  publicHex: string;
  fingerprint: string;
  /** Index de dérivation depuis le secret maître (absent pour une clé aléatoire). */
  derivationIndex?: number;
  succession?: SuccessionCert;
}

export interface BundleKey {
  meta: BundleKeyMeta;
  /** Clé privée en hex (Ed25519 : graine 32 o ; P-256 : scalaire 32 o). */
  privateHex: string;
}

export interface EliumKeyFileV2 {
  format: typeof KEYBUNDLE_FORMAT;
  version: typeof KEYBUNDLE_VERSION;
  suite: typeof KEYBUNDLE_SUITE;
  kdf: { alg: "argon2id"; t: number; m: number; p: number };
  cipher: "aes-256-gcm";
  keys: BundleKeyMeta[];
  enc: string;
  exportedAt: string;
}

interface InnerPayload {
  v: 2;
  bound: string;
  master?: string;
  secrets: Record<string, string>;
}

const HEX = /^[0-9a-f]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const P256_PUB = /^04[0-9a-f]{128}$/;

export type ParsedKeyFile =
  | { version: 1; stored: StoredIdentity }
  | { version: 2; bundle: EliumKeyFileV2 };

/** Lit n'importe quelle version de `.eliumkey` (v1 : identité seule ; v2 : trousseau). */
export function parseAnyKeyFile(text: string): ParsedKeyFile {
  let version: unknown;
  try {
    version = (JSON.parse(text) as { version?: unknown } | null)?.version;
  } catch {
    throw new EliumKeyFileError("Ce fichier n'est pas une sauvegarde .eliumkey valide (JSON illisible).");
  }
  if (version === 2) return { version: 2, bundle: parseKeyBundle(text) };
  return { version: 1, stored: parseKeyFile(text) };
}

/** Nom de fichier suggéré — volontairement sans empreinte ni identité. */
export function bundleFileName(now: Date = new Date()): string {
  return `elium-cles-${now.toISOString().slice(0, 10)}.eliumkey`;
}

/** Partie authentifiée de l'en-tête externe (tout sauf enc/exportedAt). */
function outerHeader(f: Pick<EliumKeyFileV2, "format" | "version" | "suite" | "kdf" | "cipher" | "keys">) {
  return { format: f.format, version: f.version, suite: f.suite, kdf: f.kdf, cipher: f.cipher, keys: f.keys };
}

async function boundOf(f: Pick<EliumKeyFileV2, "format" | "version" | "suite" | "kdf" | "cipher" | "keys">) {
  return sha256Hex(canonicalJSON(outerHeader(f)));
}

/** Lit l'en-tête (non secret) d'un conteneur Elium v3 — pour comparer kdf/cipher déclarés. */
export function peekContainerHeader(containerHex: string): {
  kdf: { alg: string; t: number; m: number; p: number };
  crypto: { cipher: string };
} {
  const b = fromHex(containerHex);
  if (b.length < 10) throw new EliumKeyFileError("Conteneur chiffré trop court.");
  const len = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(6, false);
  if (len <= 0 || 10 + len > b.length) throw new EliumKeyFileError("Conteneur chiffré invalide.");
  try {
    return JSON.parse(strFromU8(b.subarray(10, 10 + len)));
  } catch {
    throw new EliumKeyFileError("En-tête du conteneur illisible.");
  }
}

function publicValid(type: BundleKeyType, publicHex: string): boolean {
  return type === "identity-ed25519" ? HEX64.test(publicHex) : P256_PUB.test(publicHex);
}

/** Chiffre un trousseau complet dans un `.eliumkey` v2. */
export async function buildKeyBundle(
  keys: BundleKey[],
  password: string,
  master?: Uint8Array,
): Promise<EliumKeyFileV2> {
  if (!password) throw new EliumKeyFileError("Un mot de passe est requis pour chiffrer la sauvegarde.");
  if (!keys.length) throw new EliumKeyFileError("Aucune clé à sauvegarder.");
  const outer = {
    format: KEYBUNDLE_FORMAT,
    version: KEYBUNDLE_VERSION,
    suite: KEYBUNDLE_SUITE,
    kdf: { alg: "argon2id" as const, ...KDF_PROFILES.document },
    cipher: "aes-256-gcm" as const,
    keys: keys.map((k) => k.meta),
  } satisfies Omit<EliumKeyFileV2, "enc" | "exportedAt">;
  const inner: InnerPayload = {
    v: 2,
    bound: await boundOf(outer),
    ...(master ? { master: toHex(master) } : {}),
    secrets: Object.fromEntries(keys.map((k) => [k.meta.kid, k.privateHex])),
  };
  const enc = toHex(
    await EliumCryptoEngine.encodeContainer(strToU8(canonicalJSON(inner)), password, "elium-keybundle.json"),
  );
  return { ...outer, enc, exportedAt: new Date().toISOString() };
}

function validateMeta(m: unknown): BundleKeyMeta {
  if (!m || typeof m !== "object") throw new EliumKeyFileError("Sauvegarde corrompue : entrée de clé invalide.");
  const o = m as Record<string, unknown>;
  const type = o.type as BundleKeyType;
  if (type !== "identity-ed25519" && type !== "recipient-p256") {
    throw new EliumKeyFileError(`Type de clé inconnu : ${String(o.type)}.`);
  }
  if (o.suite !== KEY_SUITES[type]) {
    throw new EliumKeyFileError(`Suite cryptographique non prise en charge : ${String(o.suite)}.`);
  }
  const publicHex = typeof o.publicHex === "string" ? o.publicHex.toLowerCase() : "";
  const fingerprint = typeof o.fingerprint === "string" ? o.fingerprint.toLowerCase() : "";
  if (!publicValid(type, publicHex) || !HEX64.test(fingerprint)) {
    throw new EliumKeyFileError("Sauvegarde corrompue : clé publique ou empreinte invalide.");
  }
  if (typeof o.kid !== "string" || !/^[0-9a-f]{16}$/.test(o.kid)) {
    throw new EliumKeyFileError("Sauvegarde corrompue : identifiant de clé invalide.");
  }
  if (o.status !== "active" && o.status !== "retired" && o.status !== "revoked") {
    throw new EliumKeyFileError("Sauvegarde corrompue : état de clé invalide.");
  }
  if (typeof o.createdAt !== "string" || typeof o.label !== "string") {
    throw new EliumKeyFileError("Sauvegarde corrompue : métadonnées de clé invalides.");
  }
  if (o.expiresAt !== undefined && typeof o.expiresAt !== "string") {
    throw new EliumKeyFileError("Sauvegarde corrompue : date d'expiration invalide.");
  }
  if (o.derivationIndex !== undefined && !(Number.isInteger(o.derivationIndex) && (o.derivationIndex as number) >= 0)) {
    throw new EliumKeyFileError("Sauvegarde corrompue : index de dérivation invalide.");
  }
  if (o.succession !== undefined && !isSuccessionShape(o.succession)) {
    throw new EliumKeyFileError("Sauvegarde corrompue : certificat de succession invalide.");
  }
  return { ...(o as unknown as BundleKeyMeta), publicHex, fingerprint };
}

/** Valide la STRUCTURE d'un `.eliumkey` v2 (lève EliumKeyFileError). Ne déchiffre pas. */
export function parseKeyBundle(text: string): EliumKeyFileV2 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EliumKeyFileError("Ce fichier n'est pas une sauvegarde .eliumkey valide (JSON illisible).");
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.format !== KEYBUNDLE_FORMAT) {
    throw new EliumKeyFileError("Ce fichier n'est pas une sauvegarde de clés Elium (.eliumkey).");
  }
  if (o.version !== KEYBUNDLE_VERSION) {
    throw new EliumKeyFileError(`Version de sauvegarde non prise en charge (${String(o.version)}).`);
  }
  if (o.suite !== KEYBUNDLE_SUITE) {
    throw new EliumKeyFileError(`Suite de sauvegarde non prise en charge (${String(o.suite)}).`);
  }
  const kdf = o.kdf as { alg?: unknown; t?: unknown; m?: unknown; p?: unknown } | undefined;
  if (!kdf || kdf.alg !== "argon2id") throw new EliumKeyFileError("KDF non pris en charge (argon2id attendu).");
  if (!kdfWithinBounds({ t: kdf.t as number, m: kdf.m as number, p: kdf.p as number })) {
    throw new EliumKeyFileError("Paramètres Argon2id hors bornes.");
  }
  if (o.cipher !== "aes-256-gcm") throw new EliumKeyFileError("Chiffrement non pris en charge (aes-256-gcm attendu).");
  if (!Array.isArray(o.keys) || o.keys.length === 0) throw new EliumKeyFileError("Sauvegarde sans clé.");
  const keys = o.keys.map(validateMeta);
  if (new Set(keys.map((k) => k.kid)).size !== keys.length) {
    throw new EliumKeyFileError("Sauvegarde corrompue : identifiants de clé en double.");
  }
  const enc = typeof o.enc === "string" ? o.enc.toLowerCase() : "";
  if (!enc || enc.length % 2 !== 0 || !HEX.test(enc)) {
    throw new EliumKeyFileError("Sauvegarde corrompue : conteneur chiffré invalide.");
  }
  return {
    format: KEYBUNDLE_FORMAT,
    version: KEYBUNDLE_VERSION,
    suite: KEYBUNDLE_SUITE,
    kdf: { alg: "argon2id", t: kdf.t as number, m: kdf.m as number, p: kdf.p as number },
    cipher: "aes-256-gcm",
    keys,
    enc,
    exportedAt: typeof o.exportedAt === "string" ? o.exportedAt : "",
  };
}

export interface OpenedKeyBundle {
  keys: BundleKey[];
  master?: Uint8Array;
}

/**
 * Déchiffre un bundle v2 et en vérifie TOUTE la cohérence : liaison de l'en-tête
 * externe, paramètres du conteneur, correspondance clé privée ↔ clé publique ↔
 * empreinte ↔ kid.
 */
export async function openKeyBundle(file: EliumKeyFileV2, password: string): Promise<OpenedKeyBundle> {
  const head = peekContainerHeader(file.enc);
  if (
    head.kdf?.alg !== file.kdf.alg ||
    head.kdf.t !== file.kdf.t ||
    head.kdf.m !== file.kdf.m ||
    head.kdf.p !== file.kdf.p ||
    head.crypto?.cipher !== file.cipher
  ) {
    throw new EliumKeyFileError("Sauvegarde incohérente : les paramètres KDF/chiffrement ne correspondent pas au conteneur.");
  }
  let payload: Uint8Array;
  try {
    ({ payload } = await EliumCryptoEngine.decodeContainer(fromHex(file.enc), password));
  } catch {
    throw new EliumKeyFileError("Mot de passe incorrect ou sauvegarde corrompue.");
  }
  let inner: InnerPayload;
  try {
    inner = JSON.parse(strFromU8(payload)) as InnerPayload;
  } catch {
    throw new EliumKeyFileError("Contenu de la sauvegarde illisible.");
  }
  if (inner.v !== 2 || inner.bound !== (await boundOf(file))) {
    throw new EliumKeyFileError("Sauvegarde modifiée : l'en-tête ne correspond plus au contenu chiffré.");
  }
  const keys: BundleKey[] = [];
  for (const meta of file.keys) {
    const privateHex = inner.secrets?.[meta.kid];
    if (typeof privateHex !== "string" || !HEX64.test(privateHex)) {
      throw new EliumKeyFileError("Sauvegarde corrompue : clé privée manquante ou invalide.");
    }
    await assertCoherent(meta, privateHex);
    keys.push({ meta, privateHex });
  }
  let master: Uint8Array | undefined;
  if (inner.master !== undefined) {
    if (!HEX64.test(inner.master)) throw new EliumKeyFileError("Sauvegarde corrompue : secret maître invalide.");
    master = fromHex(inner.master);
  }
  return { keys, master };
}

async function assertCoherent(meta: BundleKeyMeta, privateHex: string): Promise<void> {
  let publicHex: string;
  if (meta.type === "identity-ed25519") {
    const { publicKeyHexFromPrivate } = await import("../sign/keys");
    publicHex = await publicKeyHexFromPrivate(privateHex);
  } else {
    const { p256 } = await import("@noble/curves/nist.js");
    try {
      publicHex = toHex(p256.getPublicKey(fromHex(privateHex), false));
    } catch {
      throw new EliumKeyFileError("Sauvegarde corrompue : clé privée P-256 invalide.");
    }
  }
  if (publicHex !== meta.publicHex) {
    throw new EliumKeyFileError("Sauvegarde incohérente : la clé privée ne correspond pas à la clé publique annoncée.");
  }
  if ((await sha256Hex(fromHex(meta.publicHex))) !== meta.fingerprint) {
    throw new EliumKeyFileError("Sauvegarde incohérente : empreinte invalide.");
  }
  if (meta.fingerprint.slice(0, 16) !== meta.kid) {
    throw new EliumKeyFileError("Sauvegarde incohérente : identifiant de clé invalide.");
  }
}
