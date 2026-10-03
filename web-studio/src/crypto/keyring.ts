/**
 * Trousseau unifié d'Elium : un seul registre typé pour toutes les clés
 * (identité de signature Ed25519, clé de réception P-256, contacts), stocké dans
 * IndexedDB (`elium-keys`).
 *
 * Avant : deux entrées localStorage indépendantes (`elium_identity`,
 * `elium_recipient_key`), chacune avec SON mot de passe, sans sauvegarde de la clé
 * de réception, sans statut ni expiration.
 *
 * Modèle de protection d'une clé privée :
 *  - `derived`  : aucun secret stocké ; la clé se DÉRIVE du secret maître du
 *                 trousseau (crypto/keyring-derive.ts). Le secret maître est
 *                 enveloppé par le mot de passe (et, en option, par des passkeys).
 *  - `password` : clé héritée, conteneur Elium chiffré par son propre mot de passe
 *                 (le format historique). Reste lisible, jamais perdue.
 *
 * Le cœur (statuts, migration, mutations) est testable avec `createMemoryStore`
 * et un faux `Storage` ; seul `createIdbStore` touche IndexedDB.
 */
import { fromHex, toHex } from "../format/canonical";
import { EliumCryptoEngine } from "./elium-crypto";
import { deriveEd25519, deriveP256 } from "./keyring-derive";
import { recipientFingerprint } from "./recipients";
import { fingerprintOf } from "../sign/keys";
import { createSuccession, type SuccessionCert } from "../sign/succession";
import { KEY_SUITES, type BundleKey, type BundleKeyMeta } from "./keyfile-v2";

export const KEYRING_DB = "elium-keys";
export const LEGACY_IDENTITY_KEY = "elium_identity";
export const LEGACY_RECIPIENT_KEY = "elium_recipient_key";

export type KeyType = "identity-ed25519" | "recipient-p256" | "contact";
export type KeyStatus = "active" | "retired" | "revoked";
export type KeyUsage = "sign" | "decrypt" | "verify" | "encrypt";
export type KeyProtection = "password" | "derived";

export interface KeyEntry {
  /** kid = 16 premiers hex de l'empreinte. */
  id: string;
  type: KeyType;
  suite: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  status: KeyStatus;
  usage: KeyUsage;
  publicHex: string;
  fingerprint: string;
  protection?: KeyProtection;
  /** Conteneur Elium hex (protection "password"). */
  enc?: string;
  derivationIndex?: number;
  backedUpAt?: string;
  retiredAt?: string;
  revokedAt?: string;
  succession?: SuccessionCert;
}

/** État affiché : « expirée » est un état calculé, pas stocké. */
export type EffectiveStatus = KeyStatus | "expired";

export class KeyringError extends Error {}

// --- Magasins -----------------------------------------------------------------

export interface KeyringStore {
  getAll(): Promise<KeyEntry[]>;
  put(entry: KeyEntry): Promise<void>;
  remove(id: string): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  clear(): Promise<void>;
}

export function createMemoryStore(): KeyringStore {
  const keys = new Map<string, KeyEntry>();
  const meta = new Map<string, unknown>();
  return {
    getAll: async () => [...keys.values()].map((e) => structuredClone(e)),
    put: async (e) => void keys.set(e.id, structuredClone(e)),
    remove: async (id) => void keys.delete(id),
    getMeta: async <T>(k: string) => structuredClone(meta.get(k)) as T | undefined,
    setMeta: async (k, v) => void meta.set(k, structuredClone(v)),
    clear: async () => {
      keys.clear();
      meta.clear();
    },
  };
}

const KEYS_STORE = "keys";
const META_STORE = "meta";

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Erreur IndexedDB"));
  });
}

/** Magasin IndexedDB `elium-keys` (navigateur / desktop). */
export function createIdbStore(factory: IDBFactory = indexedDB): KeyringStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(KEYRING_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KEYS_STORE)) db.createObjectStore(KEYS_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbp = null;
        reject(req.error ?? new Error("Impossible d'ouvrir le trousseau (IndexedDB)."));
      };
    }));
  const tx = async (store: string, mode: IDBTransactionMode) => (await open()).transaction(store, mode).objectStore(store);
  return {
    getAll: async () => idbRequest((await tx(KEYS_STORE, "readonly")).getAll()) as Promise<KeyEntry[]>,
    put: async (e) => void (await idbRequest((await tx(KEYS_STORE, "readwrite")).put(e))),
    remove: async (id) => void (await idbRequest((await tx(KEYS_STORE, "readwrite")).delete(id))),
    getMeta: async <T>(k: string) => (await idbRequest((await tx(META_STORE, "readonly")).get(k))) as T | undefined,
    setMeta: async (k, v) => void (await idbRequest((await tx(META_STORE, "readwrite")).put(v, k))),
    clear: async () => {
      await idbRequest((await tx(KEYS_STORE, "readwrite")).clear());
      await idbRequest((await tx(META_STORE, "readwrite")).clear());
    },
  };
}

// --- Aides pures --------------------------------------------------------------

export const kidOf = (fingerprint: string): string => fingerprint.slice(0, 16);

export function effectiveStatus(e: Pick<KeyEntry, "status" | "expiresAt">, now: number = Date.now()): EffectiveStatus {
  if (e.status === "active" && e.expiresAt && Date.parse(e.expiresAt) <= now) return "expired";
  return e.status;
}

/** Clé active la plus récente d'un type, non expirée. */
export function activeEntry(entries: KeyEntry[], type: KeyType, now: number = Date.now()): KeyEntry | undefined {
  return entries
    .filter((e) => e.type === type && effectiveStatus(e, now) === "active")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Clés privées de réception pouvant encore déchiffrer d'anciens documents (actives + retirées + révoquées). */
export function decryptCandidates(entries: KeyEntry[]): KeyEntry[] {
  return entries
    .filter((e) => e.type === "recipient-p256")
    .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || b.createdAt.localeCompare(a.createdAt));
}

export function toBundleMeta(e: KeyEntry): BundleKeyMeta {
  if (e.type === "contact") throw new KeyringError("Un contact n'est pas exportable dans une sauvegarde de clés.");
  return {
    kid: e.id,
    type: e.type,
    suite: e.suite,
    label: e.label,
    createdAt: e.createdAt,
    ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}),
    status: e.status,
    publicHex: e.publicHex,
    fingerprint: e.fingerprint,
    ...(e.derivationIndex !== undefined ? { derivationIndex: e.derivationIndex } : {}),
    ...(e.succession ? { succession: e.succession } : {}),
  };
}

export function fromBundleKey(k: BundleKey, protection: KeyProtection, enc?: string): KeyEntry {
  const m = k.meta;
  return {
    id: m.kid,
    type: m.type,
    suite: m.suite,
    label: m.label,
    createdAt: m.createdAt,
    ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}),
    status: m.status,
    usage: m.type === "identity-ed25519" ? "sign" : "decrypt",
    publicHex: m.publicHex,
    fingerprint: m.fingerprint,
    protection,
    ...(enc ? { enc } : {}),
    ...(m.derivationIndex !== undefined ? { derivationIndex: m.derivationIndex } : {}),
    ...(m.succession ? { succession: m.succession } : {}),
  };
}

// --- Migration depuis le stockage historique ---------------------------------

export interface LegacyStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isHex = (v: unknown, n?: number): v is string =>
  typeof v === "string" && /^[0-9a-f]+$/i.test(v) && (n === undefined || v.length === n);

/**
 * Migration UNIQUE et IDEMPOTENTE depuis `elium_identity` / `elium_recipient_key`.
 * Ne SUPPRIME jamais l'ancienne entrée : elle reste lisible comme repli (et comme
 * second exemplaire de la clé chiffrée) tant que l'utilisateur ne supprime pas la
 * clé depuis « Mes clés ». Retourne le nombre de clés ajoutées.
 */
export async function migrateLegacy(store: KeyringStore, legacy: LegacyStorage, now: Date = new Date()): Promise<number> {
  const existing = new Set((await store.getAll()).map((e) => e.id));
  let added = 0;

  const id = parseJson(legacy.getItem(LEGACY_IDENTITY_KEY));
  if (id && isHex(id.publicKeyHex, 64)) {
    const publicHex = id.publicKeyHex.toLowerCase();
    const fingerprint = (isHex(id.fingerprint, 64) ? id.fingerprint : await fingerprintOf(publicHex)).toLowerCase();
    const kid = kidOf(fingerprint);
    if (!existing.has(kid)) {
      const enc = typeof id.enc === "string" && isHex(id.enc) ? id.enc.toLowerCase() : "";
      await store.put({
        id: kid,
        type: "identity-ed25519",
        suite: KEY_SUITES["identity-ed25519"],
        label: "Identité de signature",
        createdAt: now.toISOString(),
        status: "active",
        usage: "sign",
        publicHex,
        fingerprint,
        protection: "password",
        ...(enc ? { enc } : {}),
      });
      existing.add(kid);
      added++;
    }
  }

  const rc = parseJson(legacy.getItem(LEGACY_RECIPIENT_KEY));
  if (rc && typeof rc.publicHex === "string" && /^04[0-9a-f]{128}$/i.test(rc.publicHex)) {
    const publicHex = rc.publicHex.toLowerCase();
    const fingerprint = await recipientFingerprint(publicHex);
    const kid = kidOf(fingerprint);
    if (!existing.has(kid)) {
      const enc = typeof rc.enc === "string" && isHex(rc.enc) ? rc.enc.toLowerCase() : "";
      await store.put({
        id: kid,
        type: "recipient-p256",
        suite: KEY_SUITES["recipient-p256"],
        label: "Clé de réception",
        createdAt: now.toISOString(),
        status: "active",
        usage: "decrypt",
        publicHex,
        fingerprint,
        protection: "password",
        ...(enc ? { enc } : {}),
      });
      added++;
    }
  }
  if (added > 0) await store.setMeta("migratedAt", now.toISOString());
  return added;
}

/**
 * Écriture miroir de la clé ACTIVE vers les anciennes clés localStorage : le
 * démarrage synchrone de l'app (état initial) et un retour arrière restent
 * possibles. Ne contient que des blobs chiffrés / des clés publiques.
 */
export async function mirrorLegacy(store: KeyringStore, legacy: LegacyStorage, now: number = Date.now()): Promise<void> {
  const entries = await store.getAll();
  const id = activeEntry(entries, "identity-ed25519", now) ?? entries.find((e) => e.type === "identity-ed25519" && e.status !== "revoked");
  if (id) {
    legacy.setItem(
      LEGACY_IDENTITY_KEY,
      JSON.stringify({ publicKeyHex: id.publicHex, fingerprint: id.fingerprint, enc: id.enc ?? "" }),
    );
  } else legacy.removeItem(LEGACY_IDENTITY_KEY);
  const rc = activeEntry(entries, "recipient-p256", now) ?? decryptCandidates(entries)[0];
  if (rc) {
    legacy.setItem(
      LEGACY_RECIPIENT_KEY,
      JSON.stringify({ publicHex: rc.publicHex, fingerprint: rc.fingerprint, enc: rc.enc ?? "" }),
    );
  } else legacy.removeItem(LEGACY_RECIPIENT_KEY);
}

// --- Secret maître ------------------------------------------------------------

export interface PasskeySlot {
  credentialId: string; // base64url
  label: string;
  createdAt: string;
  kind: "platform" | "cross-platform" | "unknown";
  prfSalt: string; // hex
  wrapped: { v: 1; alg: "aes-256-gcm"; nonce: string; ct: string };
}

export interface MasterRecord {
  v: 1;
  createdAt: string;
  /** Secret maître chiffré par le mot de passe (conteneur Elium hex). */
  passwordWrap?: string;
  passkeys: PasskeySlot[];
  /** Prochains index de dérivation. */
  nextIndex: { ed: number; p256: number };
  phraseVerifiedAt?: string;
  sharesExportedAt?: string;
}

const MASTER_META = "master";

export const getMasterRecord = (store: KeyringStore) => store.getMeta<MasterRecord>(MASTER_META);
export const putMasterRecord = (store: KeyringStore, r: MasterRecord) => store.setMeta(MASTER_META, r);

export async function wrapMasterWithPassword(master: Uint8Array, password: string): Promise<string> {
  return toHex(await EliumCryptoEngine.encodeContainer(master, password, "keyring-master"));
}

export async function unwrapMasterWithPassword(wrap: string, password: string): Promise<Uint8Array> {
  const { payload } = await EliumCryptoEngine.decodeContainer(fromHex(wrap), password);
  if (payload.length !== 32) throw new KeyringError("Secret maître invalide.");
  return payload;
}

/** Crée le secret maître (aléatoire) s'il n'existe pas ; retourne le secret en clair. */
export async function createMaster(store: KeyringStore, password: string): Promise<{ master: Uint8Array; record: MasterRecord }> {
  if (await getMasterRecord(store)) throw new KeyringError("Le trousseau possède déjà un secret maître.");
  const master = crypto.getRandomValues(new Uint8Array(32));
  const record: MasterRecord = {
    v: 1,
    createdAt: new Date().toISOString(),
    passwordWrap: await wrapMasterWithPassword(master, password),
    passkeys: [],
    nextIndex: { ed: 0, p256: 0 },
  };
  await putMasterRecord(store, record);
  return { master, record };
}

/**
 * Installe un secret maître EXISTANT (restauration depuis une phrase, des parts
 * Shamir ou une sauvegarde) sous un nouveau mot de passe.
 */
export async function installMaster(
  store: KeyringStore,
  master: Uint8Array,
  password: string,
  nextIndex: { ed: number; p256: number } = { ed: 0, p256: 0 },
): Promise<MasterRecord> {
  const prev = await getMasterRecord(store);
  const record: MasterRecord = {
    v: 1,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    passwordWrap: await wrapMasterWithPassword(master, password),
    passkeys: prev?.passkeys ?? [],
    nextIndex: {
      ed: Math.max(nextIndex.ed, prev?.nextIndex.ed ?? 0),
      p256: Math.max(nextIndex.p256, prev?.nextIndex.p256 ?? 0),
    },
    ...(prev?.phraseVerifiedAt ? { phraseVerifiedAt: prev.phraseVerifiedAt } : {}),
    ...(prev?.sharesExportedAt ? { sharesExportedAt: prev.sharesExportedAt } : {}),
  };
  await putMasterRecord(store, record);
  return record;
}

// --- Génération / rotation (dérivées) ----------------------------------------

async function takeIndex(store: KeyringStore, kind: "ed" | "p256"): Promise<number> {
  const rec = await getMasterRecord(store);
  if (!rec) throw new KeyringError("Aucun secret maître : déverrouillez ou créez le trousseau.");
  const index = rec.nextIndex[kind];
  await putMasterRecord(store, { ...rec, nextIndex: { ...rec.nextIndex, [kind]: index + 1 } });
  return index;
}

export interface NewKeyOptions {
  label?: string;
  expiresAt?: string;
}

/** Nouvelle identité de signature dérivée du secret maître. */
export async function generateIdentityKey(
  store: KeyringStore,
  master: Uint8Array,
  opts: NewKeyOptions = {},
  now: Date = new Date(),
): Promise<{ entry: KeyEntry; privateKeyHex: string }> {
  const index = await takeIndex(store, "ed");
  const d = await deriveEd25519(master, index);
  const fingerprint = await fingerprintOf(d.publicKeyHex);
  const entry: KeyEntry = {
    id: kidOf(fingerprint),
    type: "identity-ed25519",
    suite: KEY_SUITES["identity-ed25519"],
    label: opts.label?.trim() || "Identité de signature",
    createdAt: now.toISOString(),
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    status: "active",
    usage: "sign",
    publicHex: d.publicKeyHex,
    fingerprint,
    protection: "derived",
    derivationIndex: index,
  };
  await store.put(entry);
  return { entry, privateKeyHex: d.privateKeyHex };
}

/** Nouvelle clé de réception P-256 dérivée du secret maître. */
export async function generateRecipientKey(
  store: KeyringStore,
  master: Uint8Array,
  opts: NewKeyOptions = {},
  now: Date = new Date(),
): Promise<{ entry: KeyEntry; privateHex: string }> {
  const index = await takeIndex(store, "p256");
  const d = await deriveP256(master, index);
  const fingerprint = await recipientFingerprint(d.publicHex);
  const entry: KeyEntry = {
    id: kidOf(fingerprint),
    type: "recipient-p256",
    suite: KEY_SUITES["recipient-p256"],
    label: opts.label?.trim() || "Clé de réception",
    createdAt: now.toISOString(),
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    status: "active",
    usage: "decrypt",
    publicHex: d.publicHex,
    fingerprint,
    protection: "derived",
    derivationIndex: index,
  };
  await store.put(entry);
  return { entry, privateHex: d.privateHex };
}

/** Importe une clé issue d'une sauvegarde / d'un import brut (protection « password » : conteneur fourni). */
export async function importKey(store: KeyringStore, entry: KeyEntry): Promise<"added" | "exists"> {
  const all = await store.getAll();
  if (all.some((e) => e.id === entry.id)) return "exists";
  await store.put(entry);
  return "added";
}

/**
 * Rotation d'identité : la nouvelle clé (dérivée) est liée à l'ancienne par un
 * certificat de succession ; l'ancienne passe `retired` (elle reste vérifiable).
 */
export async function rotateIdentityKey(
  store: KeyringStore,
  master: Uint8Array,
  old: { entry: KeyEntry; privateKeyHex: string },
  opts: NewKeyOptions = {},
  now: Date = new Date(),
): Promise<{ entry: KeyEntry; privateKeyHex: string; succession: SuccessionCert }> {
  if (old.entry.type !== "identity-ed25519") throw new KeyringError("Seule une identité de signature peut être tournée ici.");
  const created = await generateIdentityKey(store, master, { label: opts.label ?? old.entry.label, expiresAt: opts.expiresAt }, now);
  const succession = await createSuccession({
    oldPrivateKeyHex: old.privateKeyHex,
    oldPublicKeyHex: old.entry.publicHex,
    newPrivateKeyHex: created.privateKeyHex,
    newPublicKeyHex: created.entry.publicHex,
    issuedAt: now.toISOString(),
  });
  const entry = { ...created.entry, succession };
  await store.put(entry);
  await store.put({ ...old.entry, status: "retired", retiredAt: now.toISOString() });
  return { entry, privateKeyHex: created.privateKeyHex, succession };
}

/** Rotation de la clé de réception : l'ancienne reste dans la liste de déchiffrement. */
export async function rotateRecipientKey(
  store: KeyringStore,
  master: Uint8Array,
  old: KeyEntry,
  opts: NewKeyOptions = {},
  now: Date = new Date(),
): Promise<{ entry: KeyEntry; privateHex: string }> {
  if (old.type !== "recipient-p256") throw new KeyringError("Seule une clé de réception peut être tournée ici.");
  const created = await generateRecipientKey(store, master, { label: opts.label ?? old.label, expiresAt: opts.expiresAt }, now);
  await store.put({ ...old, status: "retired", retiredAt: now.toISOString() });
  return created;
}

// --- Mutations d'état ---------------------------------------------------------

async function mutate(store: KeyringStore, id: string, f: (e: KeyEntry) => KeyEntry): Promise<KeyEntry> {
  const e = (await store.getAll()).find((x) => x.id === id);
  if (!e) throw new KeyringError("Clé introuvable dans le trousseau.");
  const next = f(e);
  await store.put(next);
  return next;
}

export const retireKey = (store: KeyringStore, id: string, now = new Date()) =>
  mutate(store, id, (e) => ({ ...e, status: "retired", retiredAt: now.toISOString() }));

export const revokeKey = (store: KeyringStore, id: string, now = new Date()) =>
  mutate(store, id, (e) => ({ ...e, status: "revoked", revokedAt: now.toISOString() }));

export const reactivateKey = (store: KeyringStore, id: string) =>
  mutate(store, id, (e) => {
    if (e.status === "revoked") throw new KeyringError("Une clé révoquée ne peut pas être réactivée.");
    const { retiredAt: _r, ...rest } = e;
    void _r;
    return { ...rest, status: "active" };
  });

export const setKeyExpiry = (store: KeyringStore, id: string, expiresAt: string | null) =>
  mutate(store, id, (e) => {
    const { expiresAt: _x, ...rest } = e;
    void _x;
    return expiresAt ? { ...rest, expiresAt } : rest;
  });

export const renameKey = (store: KeyringStore, id: string, label: string) =>
  mutate(store, id, (e) => ({ ...e, label: label.trim() || e.label }));

export const markBackedUp = (store: KeyringStore, ids: string[], now = new Date()) =>
  Promise.all(ids.map((id) => mutate(store, id, (e) => ({ ...e, backedUpAt: now.toISOString() }))));

/**
 * Supprime une clé. La sauvegarde est OBLIGATOIRE : refuse si la clé n'a jamais
 * été sauvegardée, sauf confirmation explicite `acknowledgeLoss` (l'appelant n'y
 * recourt qu'après avoir proposé la sauvegarde ET obtenu un accord explicite).
 */
export async function deleteKey(
  store: KeyringStore,
  id: string,
  opts: { acknowledgeLoss?: boolean } = {},
): Promise<void> {
  const e = (await store.getAll()).find((x) => x.id === id);
  if (!e) return;
  if (!e.backedUpAt && e.type !== "contact" && !opts.acknowledgeLoss) {
    throw new KeyringError("Cette clé n'a pas été sauvegardée : exportez-la avant de la supprimer.");
  }
  await store.remove(id);
}

// --- Préparation à la récupération --------------------------------------------

export interface RecoveryChecklist {
  backupDone: boolean;
  phraseVerified: boolean;
  passkeyEnrolled: boolean;
  /** Parts Shamir exportées (optionnel). */
  sharesExported: boolean;
  /** 0..3 : sauvegarde, phrase vérifiée, passkey. */
  score: number;
}

export function recoveryChecklist(entries: KeyEntry[], master: MasterRecord | undefined): RecoveryChecklist {
  const own = entries.filter((e) => e.type !== "contact" && e.status !== "revoked");
  const backupDone = own.length > 0 && own.every((e) => !!e.backedUpAt);
  const phraseVerified = !!master?.phraseVerifiedAt;
  const passkeyEnrolled = (master?.passkeys.length ?? 0) > 0;
  return {
    backupDone,
    phraseVerified,
    passkeyEnrolled,
    sharesExported: !!master?.sharesExportedAt,
    score: Number(backupDone) + Number(phraseVerified) + Number(passkeyEnrolled),
  };
}
