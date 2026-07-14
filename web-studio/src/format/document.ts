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

export function createDocumentModel(
  doc?: ProseMirrorNode,
  page?: Partial<PageSettings>,
): EliumDocumentModel {
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

/** Append a "document.modified" event (only when tracking is active). */
export async function recordModification(file: EliumFile): Promise<EliumFile> {
  if (!(profileOf(file.manifest.profile).tracking || file.journal.events.length)) return file;
  const journal = await appendEvent(file.journal, "document.modified", {});
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

/** Best-effort plain-text extraction (for previews / search). */
export function extractText(node: ProseMirrorNode): string {
  if (node.text) return node.text;
  if (!node.content) return "";
  const sep = ["paragraph", "heading", "listItem", "blockquote"].includes(node.type) ? "\n" : "";
  return node.content.map(extractText).join("") + sep;
}
