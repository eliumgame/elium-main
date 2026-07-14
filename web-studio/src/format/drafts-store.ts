/**
 * Auto-save / recovery drafts — a safety net for documents the user has NOT
 * explicitly saved. While editing, the app silently snapshots the document to
 * IndexedDB (this browser only).
 *
 * For protected documents (password and/or keyfile) the snapshot CONTENT is
 * encrypted at rest with the same document secret (see crypto/local-vault.ts):
 * neither the editor snapshot nor a ready-to-use .docx export are ever written
 * in clear. Unprotected documents keep the original plaintext snapshot plus a
 * pre-built .docx for instant recovery. The original protection profile is
 * stored alongside the draft so recovering it never silently downgrades a
 * protected document to an unprotected one.
 *
 * Separate database from the Drive and version stores to avoid IndexedDB
 * version coordination between independent features.
 */
import type { EliumProfile, PageSettings, ProseMirrorNode } from "./types";
import { encryptAtRest, decryptAtRest, hasVaultSecret, type VaultSecret } from "../crypto/local-vault";

const DB_NAME = "elium-drafts";
const STORE = "drafts";
const DB_VERSION = 1;

export interface DraftContent {
  doc: ProseMirrorNode;
  page: PageSettings;
}

export interface DraftDoc {
  id: string; // stable doc key (manifest.createdAt)
  title: string;
  profile: EliumProfile; // restored on recovery so protection isn't silently dropped
  protected: boolean;
  updatedAt: string; // ISO
  size: number; // .docx byte length (unprotected) or ciphertext byte length (protected)
  doc?: ProseMirrorNode; // plaintext snapshot — only when NOT protected
  page?: PageSettings; // plaintext page settings — only when NOT protected
  docx?: Uint8Array; // ready-to-use Word export — only when NOT protected
  enc?: string; // base64 salt+iv+ciphertext of { doc, page } — only when protected
}

/**
 * `legacy` flags entries written before the `protected` field existed at all
 * (older app versions stored every draft in clear, including for protected
 * documents). They aren't deleted automatically — we have no reliable way to
 * tell, from the record alone, whether the original document was protected —
 * but the UI surfaces them distinctly so the user can decide to remove one
 * that predates this fix.
 */
export type DraftEntry = Omit<DraftDoc, "doc" | "page" | "docx" | "enc"> & { legacy: boolean };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
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

/**
 * Build the record to persist for a draft. Pure (no IndexedDB access) so the
 * plaintext/encrypted decision is unit-testable on its own. Encrypts
 * `{ doc, page }` at rest when `secret` carries a password and/or keyfile;
 * otherwise stores plaintext `doc`/`page`/`docx`. Pass `docx` only for
 * unprotected documents — a ready-to-open Word file would otherwise defeat
 * the encryption.
 */
export async function buildDraftRecord(input: {
  id: string;
  title: string;
  profile: EliumProfile;
  updatedAt: string;
  doc: ProseMirrorNode;
  page: PageSettings;
  docx?: Uint8Array;
  secret?: VaultSecret;
}): Promise<DraftDoc> {
  if (!hasVaultSecret(input.secret)) {
    return {
      id: input.id,
      title: input.title,
      profile: input.profile,
      protected: false,
      updatedAt: input.updatedAt,
      doc: input.doc,
      page: input.page,
      docx: input.docx,
      size: input.docx?.length ?? 0,
    };
  }
  const enc = await encryptAtRest({ doc: input.doc, page: input.page } satisfies DraftContent, input.secret!);
  return {
    id: input.id,
    title: input.title,
    profile: input.profile,
    protected: true,
    updatedAt: input.updatedAt,
    enc,
    size: enc.length,
  };
}

/** Insert or update a draft (upsert by id). See {@link buildDraftRecord} for the encryption rule. */
export async function putDraft(input: Parameters<typeof buildDraftRecord>[0]): Promise<void> {
  const record = await buildDraftRecord(input);
  await run("readwrite", (s) => s.put(record));
}

/** All draft entries (metadata only — never the encrypted or plaintext content), newest first. */
export async function listDrafts(): Promise<DraftEntry[]> {
  const all = await run<DraftDoc[]>("readonly", (s) => s.getAll());
  return all
    .map(({ doc: _doc, page: _page, docx: _docx, enc: _enc, ...meta }) => ({
      ...meta,
      legacy: typeof meta.protected !== "boolean",
      protected: !!meta.protected,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getDraft(id: string): Promise<DraftDoc | undefined> {
  return run<DraftDoc | undefined>("readonly", (s) => s.get(id));
}

export async function deleteDraft(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

/** Resolve a stored draft to its content, decrypting when protected. Throws if the secret is missing/wrong. */
export async function resolveDraft(d: DraftDoc, secret?: VaultSecret): Promise<DraftContent> {
  if (d.enc != null) {
    if (!hasVaultSecret(secret)) throw new Error("Ce brouillon est chiffré — mot de passe requis.");
    return decryptAtRest<DraftContent>(d.enc, secret!);
  }
  if (!d.doc || !d.page) throw new Error("Brouillon vide.");
  return { doc: d.doc, page: d.page };
}
