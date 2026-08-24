/**
 * Factory + high-level mutations for an in-memory `EliumFile`.
 *
 * These helpers keep the three layers consistent: changing the profile updates
 * tracking, adding a signature appends a journal event, etc. The manifest is
 * mostly rebuilt at save time (see `buildManifest`), so here we only need to
 * carry the user-controlled fields (title, profile, createdAt, keyfile flag).
 */

import { appendEvent, emptyJournal } from "./journal";
import { profileOf } from "./profiles";
import { nowIso } from "./canonical";
import {
  ELIUM_DOC_SCHEMA,
  ELIUM_FORMAT,
  ELIUM_FORMAT_VERSION,
  type EliumDocumentModel,
  type EliumFile,
  type EliumManifest,
  type EliumProfile,
  type EliumSignature,
  type PageSettings,
  type ParapheurParty,
  type ProseMirrorNode,
} from "./types";

export const DEFAULT_PAGE: PageSettings = {
  format: "A4",
  orientation: "portrait",
  margins: { top: 25, right: 20, bottom: 25, left: 20 },
  showPageNumbers: true,
};

export function emptyDocNode(): ProseMirrorNode {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Nouveau document" }] },
      { type: "paragraph", content: [{ type: "text", text: "Commencez à rédiger ici…" }] },
    ],
  };
}

export function createDocumentModel(doc?: ProseMirrorNode, page?: Partial<PageSettings>): EliumDocumentModel {
  return { schema: ELIUM_DOC_SCHEMA, page: { ...DEFAULT_PAGE, ...page }, doc: doc ?? emptyDocNode() };
}

function baseManifest(title: string, profile: EliumProfile): EliumManifest {
  const now = nowIso();
  return {
    format: ELIUM_FORMAT,
    formatVersion: ELIUM_FORMAT_VERSION,
    profile,
    generator: "elium-web/4.0.0",
    docId: crypto.randomUUID(),
    createdAt: now,
    modifiedAt: now,
    title,
    language: "fr",
    protection: { encrypted: false, locked: false, keyfileRequired: false, contentEntry: "content/document.json" },
    integrity: { algorithm: "sha-256" as const, contentHash: null },
    features: { signatures: false, tracking: false, resources: 0 },
    rgpd: { localOnly: true, storedPersonalData: [], notice: "" },
  };
}

export async function createEliumFile(opts: {
  title?: string;
  profile?: EliumProfile;
  doc?: ProseMirrorNode;
}): Promise<EliumFile> {
  const title = opts.title ?? "Document sans titre";
  const profile = opts.profile ?? "standard";

  let journal = emptyJournal();
  if (profileOf(profile).tracking) {
    journal = await appendEvent(journal, "document.created", { data: { title } });
  }

  return {
    manifest: baseManifest(title, profile),
    document: createDocumentModel(opts.doc),
    signatures: [],
    resources: new Map(),
    resourceIndex: [],
    journal,
  };
}

/** Switch protection profile, logging the change when tracking is active. */
export async function setProfile(file: EliumFile, profile: EliumProfile): Promise<EliumFile> {
  const def = profileOf(profile);
  let journal = file.journal;
  if (def.tracking || file.journal.events.length) {
    journal = await appendEvent(journal, "protection.enabled", { data: { profile } });
    if (def.locked) {
      journal = await appendEvent(journal, "document.locked", {});
    }
  }
  return {
    ...file,
    manifest: { ...file.manifest, profile },
    journal,
  };
}

/** Whether the tracking journal is active for this file (profile opts in, or a journal already exists). */
export function tracksJournal(file: EliumFile): boolean {
  return profileOf(file.manifest.profile).tracking || file.journal.events.length > 0;
}

/**
 * A read-time event queued in memory during a session (document opened, exported,
 * signature validated). It carries its real timestamp; the events are only
 * appended to the journal at save time — see `recordSave`.
 */
export type SessionJournalType = "document.opened" | "export" | "signature.validated";
export interface PendingJournalEvent {
  type: SessionJournalType;
  at: string;
  data?: Record<string, unknown>;
  actor?: { name?: string; fingerprint?: string };
}

/**
 * Flush the queued session events, then append one "document.modified" for this
 * save — in order, and only when tracking is active. Called right before the file
 * is (re)sealed, so the seal covers the new journal.
 *
 * Read-time events are queued rather than appended live on purpose: the seal signs
 * a hash of the journal, so mutating it while merely viewing a sealed document
 * would break the seal until the next save. Queuing defers every such event to the
 * save that re-anchors (re-seals) them.
 */
export async function recordSave(file: EliumFile, pending: PendingJournalEvent[] = []): Promise<EliumFile> {
  if (!tracksJournal(file)) return file;
  let journal = file.journal;
  for (const p of pending) {
    journal = await appendEvent(journal, p.type, {
      at: p.at,
      ...(p.data && Object.keys(p.data).length ? { data: p.data } : {}),
      ...(p.actor && Object.keys(p.actor).length ? { actor: p.actor } : {}),
    });
  }
  journal = await appendEvent(journal, "document.modified", {});
  return { ...file, journal };
}

/** Add a visual signature and log it. */
export async function addSignature(file: EliumFile, signature: EliumSignature): Promise<EliumFile> {
  let journal = file.journal;
  const tracking = profileOf(file.manifest.profile).tracking || file.journal.events.length > 0;
  if (tracking) {
    journal = await appendEvent(journal, "signature.added", {
      actor: signature.proof
        ? { name: signature.signer.name, fingerprint: signature.proof.fingerprint }
        : { name: signature.signer.name },
      data: { id: signature.id, level: signature.level, kind: signature.kind },
    });
  }
  return { ...file, signatures: [...file.signatures, signature], journal };
}

export function removeSignature(file: EliumFile, id: string): EliumFile {
  return { ...file, signatures: file.signatures.filter((s) => s.id !== id) };
}

// --- Parapheur bridge (local circuit <-> cloud sign-by-link requests) -----

/**
 * Update exactly ONE party of the circuit by id; every other party is left
 * byte-for-byte untouched, and this is a no-op when there is no circuit or no
 * matching party. This is the single choke point an account-less remote
 * signer's write-back goes through (see SignLinkView): their link resolves to
 * exactly one party id, so this function is what makes it structurally
 * impossible for that write-back to touch anyone else's row.
 */
export function markPartySigned(file: EliumFile, partyId: string, patch: Partial<ParapheurParty>): EliumFile {
  const parties = file.parapheur?.parties;
  if (!parties?.some((p) => p.id === partyId)) return file;
  return {
    ...file,
    parapheur: { ...file.parapheur!, parties: parties.map((p) => (p.id === partyId ? { ...p, ...patch } : p)) },
  };
}

/**
 * Align the document's embedded circuit with the parties of a cloud sign
 * request about to exist server-side, so the two never describe a different
 * signer list. When the circuit already has the same number of parties, its
 * existing entries (name/role/status/signatureId…) are kept and only their
 * `id` is re-pointed to the request's party id (the correlation a remote
 * signer's link needs) — an existing "signed" party is never reset. Otherwise
 * (no circuit yet, or the party count changed) a fresh "pending" circuit is
 * built from `labels`, in the SAME order as `requestPartyIds` — never a
 * disconnected, ad-hoc list.
 */
export function alignCircuitWithRequest(
  file: EliumFile,
  requestPartyIds: string[],
  labels: (string | undefined)[],
): EliumFile {
  const existing = file.parapheur?.parties;
  const parties: ParapheurParty[] =
    existing && existing.length === requestPartyIds.length
      ? existing.map((p, i) => ({ ...p, id: requestPartyIds[i]! }))
      : requestPartyIds.map((id, i) => ({
          id,
          name: labels[i]?.trim() || `Signataire ${i + 1}`,
          role: "",
          status: "pending",
        }));
  return { ...file, parapheur: { ...(file.parapheur ?? {}), parties, requestedAt: nowIso() } };
}

/** Best-effort plain-text extraction (for previews / search). */
export function extractText(node: ProseMirrorNode): string {
  if (node.text) return node.text;
  if (!node.content) return "";
  const sep = ["paragraph", "heading", "listItem", "blockquote"].includes(node.type) ? "\n" : "";
  return node.content.map(extractText).join("") + sep;
}
