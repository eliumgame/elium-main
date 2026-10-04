/**
 * Sauvegarde / restauration du trousseau (`.eliumkey` v2) et récupération depuis
 * le secret maître (phrase de 24 mots, parts Shamir).
 */
import {
  KeyringError,
  fromBundleKey,
  getMasterRecord,
  importKey,
  installMaster,
  kidOf,
  markBackedUp,
  toBundleMeta,
  type KeyEntry,
  type KeyringStore,
  type MasterRecord,
} from "./keyring";
import type { KeyringSession } from "./keyring-session";
import { buildKeyBundle, KEY_SUITES, type EliumKeyFileV2, type OpenedKeyBundle } from "./keyfile-v2";
import { deriveEd25519, deriveP256 } from "./keyring-derive";
import { encryptPrivateKey } from "../sign/identity-store";
import { fingerprintOf } from "../sign/keys";
import { recipientFingerprint } from "./recipients";

/** Combien d'indices de dérivation re-parcourir lors d'une restauration depuis le secret maître seul. */
export const RESTORE_SCAN_COUNT = 4;

/**
 * Construit une sauvegarde chiffrée de `ids` (tout le trousseau si omis). Toutes
 * les clés doivent être déverrouillées dans la session. Marque les clés
 * sauvegardées (`backedUpAt`) UNE FOIS le fichier produit.
 */
export async function buildBackup(
  store: KeyringStore,
  session: KeyringSession,
  bundlePassword: string,
  ids?: string[],
  now: Date = new Date(),
): Promise<EliumKeyFileV2> {
  const entries = (await store.getAll()).filter((e) => e.type !== "contact" && (!ids || ids.includes(e.id)));
  if (entries.length === 0) throw new KeyringError("Aucune clé à sauvegarder.");
  const keys = entries.map((e) => {
    const privateHex = session.getPrivate(e.id);
    if (!privateHex)
      throw new KeyringError(`La clé « ${e.label} » est verrouillée : déverrouillez le trousseau d'abord.`);
    return { meta: toBundleMeta(e), privateHex };
  });
  const file = await buildKeyBundle(keys, bundlePassword, session.getMaster() ?? undefined);
  await markBackedUp(
    store,
    entries.map((e) => e.id),
    now,
  );
  return file;
}

export interface ImportResult {
  added: string[];
  existing: string[];
  masterInstalled: boolean;
}

/**
 * Importe un bundle ouvert. Si le bundle porte un secret maître et que le
 * trousseau n'en a pas encore, il est installé sous `password` et les clés
 * dérivées restent « dérivées » ; sinon chaque clé est protégée par un conteneur
 * chiffré sous `password` (jamais de clé en clair).
 */
export async function importOpenedBundle(
  store: KeyringStore,
  opened: OpenedKeyBundle,
  password: string,
  now: Date = new Date(),
): Promise<ImportResult> {
  const record = await getMasterRecord(store);
  let masterInstalled = false;
  let useDerived = false;
  if (opened.master && !record) {
    const maxEd = Math.max(
      -1,
      ...opened.keys.filter((k) => k.meta.type === "identity-ed25519").map((k) => k.meta.derivationIndex ?? -1),
    );
    const maxP = Math.max(
      -1,
      ...opened.keys.filter((k) => k.meta.type === "recipient-p256").map((k) => k.meta.derivationIndex ?? -1),
    );
    await installMaster(store, opened.master, password, { ed: maxEd + 1, p256: maxP + 1 });
    masterInstalled = true;
    useDerived = true;
  }
  const added: string[] = [];
  const existing: string[] = [];
  for (const k of opened.keys) {
    let entry: KeyEntry;
    const idx = k.meta.derivationIndex;
    let derived = false;
    if (useDerived && idx !== undefined && opened.master) {
      const pub =
        k.meta.type === "identity-ed25519"
          ? (await deriveEd25519(opened.master, idx)).publicKeyHex
          : (await deriveP256(opened.master, idx)).publicHex;
      derived = pub === k.meta.publicHex;
    }
    if (derived) entry = fromBundleKey(k, "derived");
    else entry = fromBundleKey(k, "password", await encryptPrivateKey(k.privateHex, password));
    entry.backedUpAt = now.toISOString();
    if ((await importKey(store, entry)) === "added") added.push(entry.id);
    else existing.push(entry.id);
  }
  return { added, existing, masterInstalled };
}

/**
 * Récupération depuis le SEUL secret maître (phrase / parts Shamir) : réinstalle
 * le secret sous un nouveau mot de passe et re-dérive les premiers indices de
 * chaque type. L'historique exact des rotations n'est pas connu : l'indice 0 est
 * actif, les suivants sont « retirés » (ils déchiffrent toujours d'anciens
 * documents ; l'utilisateur peut en réactiver un).
 */
export async function restoreFromMaster(
  store: KeyringStore,
  master: Uint8Array,
  password: string,
  now: Date = new Date(),
): Promise<{ record: MasterRecord; restored: string[] }> {
  const record = await installMaster(store, master, password, { ed: RESTORE_SCAN_COUNT, p256: RESTORE_SCAN_COUNT });
  const existingIds = new Set((await store.getAll()).map((e) => e.id));
  const restored: string[] = [];
  for (let i = 0; i < RESTORE_SCAN_COUNT; i++) {
    const ed = await deriveEd25519(master, i);
    const edFpr = await fingerprintOf(ed.publicKeyHex);
    if (!existingIds.has(kidOf(edFpr))) {
      await store.put({
        id: kidOf(edFpr),
        type: "identity-ed25519",
        suite: KEY_SUITES["identity-ed25519"],
        label: i === 0 ? "Identité de signature (restaurée)" : `Identité n°${i + 1} (restaurée)`,
        createdAt: new Date(now.getTime() + i).toISOString(),
        status: i === 0 ? "active" : "retired",
        usage: "sign",
        publicHex: ed.publicKeyHex,
        fingerprint: edFpr,
        protection: "derived",
        derivationIndex: i,
        backedUpAt: now.toISOString(),
      });
      restored.push(kidOf(edFpr));
    }
    const p = await deriveP256(master, i);
    const pFpr = await recipientFingerprint(p.publicHex);
    if (!existingIds.has(kidOf(pFpr))) {
      await store.put({
        id: kidOf(pFpr),
        type: "recipient-p256",
        suite: KEY_SUITES["recipient-p256"],
        label: i === 0 ? "Clé de réception (restaurée)" : `Clé de réception n°${i + 1} (restaurée)`,
        createdAt: new Date(now.getTime() + i).toISOString(),
        status: i === 0 ? "active" : "retired",
        usage: "decrypt",
        publicHex: p.publicHex,
        fingerprint: pFpr,
        protection: "derived",
        derivationIndex: i,
        backedUpAt: now.toISOString(),
      });
      restored.push(kidOf(pFpr));
    }
  }
  return { record, restored };
}
