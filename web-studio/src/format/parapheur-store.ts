/**
 * Parapheur (multi-party signing workflow) — local-first v1.
 *
 * Defines the ordered circuit of signatories for a document and tracks each
 * party's status. Stored in IndexedDB (this browser), keyed by the document's
 * creation timestamp. NOTE (v1 limitation): the circuit does not yet travel
 * inside the .elium — embedding it in the (signed, Python↔TS-interop) manifest
 * is a follow-up that needs the Python mirror. For now it is a local circuit
 * tracker that complements the existing signature engine.
 *
 * When the local vault (crypto/local-vault.ts, see format/vault-store.ts) is
 * configured, the signer list (names/roles — PII) is encrypted at rest.
 */
import { encryptAtRest, decryptAtRest, hasVaultSecret, type VaultSecret } from "../crypto/local-vault";

const DB_NAME = "elium-parapheur";
const STORE = "workflows";
const DB_VERSION = 1;

export type PartyStatus = "pending" | "signed" | "rejected";

export interface Party {
  id: string;
  name: string;
  role: string;
  status: PartyStatus;
  note?: string;
  updatedAt?: string;
}

export interface Workflow {
  docKey: string;
  parties: Party[];
  createdAt: string;
}

interface StoredWorkflow {
  docKey: string;
  createdAt: string;
  vaultProtected: boolean;
  parties?: Party[]; // plaintext — only when NOT vault-protected
  enc?: string; // encrypted Party[] — only when vault-protected
}

export function newPartyId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `pt-${c.randomUUID()}`;
  return `pt-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

/** Derived overall status of a circuit. */
export function workflowStatus(parties: Party[]): "draft" | "in_progress" | "completed" | "rejected" {
  if (parties.length === 0) return "draft";
  if (parties.some((p) => p.status === "rejected")) return "rejected";
  if (parties.every((p) => p.status === "signed")) return "completed";
  return "in_progress";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "docKey" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/** Throws if the workflow is vault-protected and `vaultSecret` is missing/wrong. */
export async function getWorkflow(docKey: string, vaultSecret?: VaultSecret): Promise<Workflow | undefined> {
  const rec = await run<StoredWorkflow | undefined>("readonly", (s) => s.get(docKey));
  if (!rec) return undefined;
  if (!rec.vaultProtected) return { docKey: rec.docKey, createdAt: rec.createdAt, parties: rec.parties ?? [] };
  if (!hasVaultSecret(vaultSecret)) throw new Error("Ce circuit de signature est protégé par le coffre local — déverrouillez-le d'abord.");
  const parties = await decryptAtRest<Party[]>(rec.enc!, vaultSecret!);
  return { docKey: rec.docKey, createdAt: rec.createdAt, parties };
}

/** Encrypts the signer list at rest when `vaultSecret` carries a password. */
export async function saveWorkflow(wf: Workflow, vaultSecret?: VaultSecret): Promise<void> {
  const record: StoredWorkflow = hasVaultSecret(vaultSecret)
    ? { docKey: wf.docKey, createdAt: wf.createdAt, vaultProtected: true, enc: await encryptAtRest(wf.parties, vaultSecret!) }
    : { docKey: wf.docKey, createdAt: wf.createdAt, vaultProtected: false, parties: wf.parties };
  await run("readwrite", (s) => s.put(record));
}

export async function deleteWorkflow(docKey: string): Promise<void> {
  await run("readwrite", (s) => s.delete(docKey));
}

/**
 * Re-encrypt every workflow from `from` to `to` — used when the vault is
 * enabled for the first time (`from` undefined), its password changes (both
 * set), or it's disabled (`to` undefined, decrypted back to plaintext).
 * All records are committed in a SINGLE IndexedDB transaction: if any single
 * `put` fails, the whole batch rolls back rather than leaving some workflows
 * under `from` and others under `to`.
 */
export async function reencryptParapheurVault(from: VaultSecret | undefined, to: VaultSecret | undefined): Promise<void> {
  const all = await run<StoredWorkflow[]>("readonly", (s) => s.getAll());
  const next: StoredWorkflow[] = [];
  for (const rec of all) {
    let parties: Party[];
    if (rec.vaultProtected) {
      if (!hasVaultSecret(from)) throw new Error("Mot de passe du coffre requis pour re-chiffrer le Parapheur.");
      parties = await decryptAtRest<Party[]>(rec.enc!, from!);
    } else {
      parties = rec.parties ?? [];
    }
    next.push(
      hasVaultSecret(to)
        ? { docKey: rec.docKey, createdAt: rec.createdAt, vaultProtected: true, enc: await encryptAtRest(parties, to!) }
        : { docKey: rec.docKey, createdAt: rec.createdAt, vaultProtected: false, parties },
    );
  }
  if (next.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    t.oncomplete = () => { db.close(); resolve(); };
    t.onerror = () => { db.close(); reject(t.error ?? new Error("Transaction annulée")); };
    t.onabort = () => { db.close(); reject(t.error ?? new Error("Transaction annulée")); };
    const store = t.objectStore(STORE);
    for (const rec of next) store.put(rec);
  });
}
