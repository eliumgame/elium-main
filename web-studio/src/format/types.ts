/**
 * Elium documentary format v4 — shared type definitions.
 *
 * A `.elium` file is a ZIP package (OPC-style) whose entries are described in
 * DOCUMENTATION.md (§5). These types describe the *logical* objects; serialization to/from
 * the ZIP package lives in `elium-package.ts`.
 *
 * Design goals:
 *  - Protection is OPTIONAL and expressed through a profile (see `profiles.ts`).
 *  - The document body uses the ProseMirror/TipTap JSON model so the editor and
 *    viewer share one representation.
 *  - Visual signatures and cryptographic proof are two separate layers.
 *  - Integrity (tamper detection) and the activity journal are first-class.
 */

export const ELIUM_FORMAT = "elium";
export const ELIUM_FORMAT_VERSION = 4;
export const ELIUM_MIMETYPE = "application/x-elium";
export const ELIUM_DOC_SCHEMA = "elium-doc/1";

/** Protection profiles offered to the user (see DOCUMENTATION.md §5.4). */
export type EliumProfile =
  | "standard" // portable, non chiffré
  | "signed" // signatures visuelles + empreinte + journal
  | "protected" // mot de passe d'ouverture
  | "encrypted" // contenu chiffré
  | "locked" // lecture seule + détection d'altération
  | "tracked" // journal de suivi intégré
  | "secure_max"; // chiffrement + signature + verrouillage + suivi

/** ProseMirror/TipTap JSON node. */
export interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

export type PageFormat = "A4" | "Letter";
export type PageOrientation = "portrait" | "landscape";

export interface PageSettings {
  format: PageFormat;
  orientation: PageOrientation;
  /** Margins in millimetres. */
  margins: { top: number; right: number; bottom: number; left: number };
  header?: string;
  footer?: string;
  showPageNumbers?: boolean;
  /** Auto-number H1–H3 headings (1. / 1.1 / 1.1.1), purely presentational. */
  numberedHeadings?: boolean;
}

/** The editable document: page setup + ProseMirror content. */
export interface EliumDocumentModel {
  schema: typeof ELIUM_DOC_SCHEMA;
  page: PageSettings;
  doc: ProseMirrorNode; // root node, type === "doc"
}

/** Embedded binary resource (image, attachment). */
export interface EliumResource {
  id: string; // sha256 of the bytes (content-addressed)
  name: string;
  mime: string;
  size: number;
  kind: "image" | "attachment";
}

// --- Signatures -----------------------------------------------------------

export type SignatureKind =
  | "drawn"
  | "typed"
  | "image"
  | "stamp"
  | "initials"
  | "qr"
  | "mixed";

export type StampStyle =
  | "approved"
  | "validated"
  | "confidential"
  | "paid"
  | "received"
  | "custom";

export interface SignatureVisual {
  /** Rendered raster (PNG data URL) for drawn / image / stamp / qr signatures. */
  image?: string;
  /** Text content for typed / mixed signatures. */
  text?: string;
  subText?: string;
  fontFamily?: string;
  color?: string;
  background?: string;
  stampStyle?: StampStyle;
}

/**
 * Placement is stored in *page-relative percentages* (0..1) so a signature
 * lands in the same spot regardless of zoom or rendering resolution.
 */
export interface SignaturePlacement {
  page: number; // 1-based page index
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  rotation: number; // degrees
  z: number;
  anchorType: "page" | "paragraph";
  anchorId?: string;
}

export interface SignerInfo {
  name?: string;
  role?: string;
  org?: string;
  date?: string;
  identifier?: string;
}

/**
 * Optional cryptographic proof. A `visual`-level signature has `proof === null`.
 * Verification status is recomputed on open and never trusted from the file.
 */
export interface SignatureProof {
  alg: "ed25519";
  publicKeyHex: string;
  fingerprint: string;
  contentHashAlg: "sha-256";
  /** Hash of the canonical document at signing time (tamper baseline). */
  signedContentHash: string;
  /** Ed25519 signature over the canonical "to-be-signed" structure. */
  signatureHex: string;
  signedAt: string;
  timestamp?: { type: "local"; at: string; note: string } | null;
}

export interface EliumSignature {
  id: string;
  kind: SignatureKind;
  visual: SignatureVisual;
  placement: SignaturePlacement;
  signer: SignerInfo;
  proof: SignatureProof | null;
  level: "visual" | "advanced";
  createdAt: string;
}

/** Runtime verification verdict (computed, not stored). */
export type SignatureVerdict =
  | "valid" // proof verified AND document unchanged since signing
  | "modified" // proof verified BUT document changed since signing
  | "invalid" // signature does not verify against the public key
  | "unknown_key" // proof present, no trusted key supplied
  | "visual_only"; // no cryptographic proof

// --- Tracking journal -----------------------------------------------------

export type JournalEventType =
  | "document.created"
  | "document.modified"
  | "signature.added"
  | "signature.validated"
  | "protection.enabled"
  | "document.locked"
  | "export"
  | "document.opened";

export interface JournalEvent {
  seq: number;
  type: JournalEventType;
  at: string;
  actor?: { name?: string; fingerprint?: string };
  data?: Record<string, unknown>;
  prevHash: string; // hex sha256
  hash: string; // hex sha256 of prevHash + canonical(payload)
}

export interface Journal {
  version: 1;
  events: JournalEvent[];
}

// --- Manifest -------------------------------------------------------------

export interface ProtectionState {
  encrypted: boolean;
  /** Read-only + tamper detection. */
  locked: boolean;
  /** A keyfile is required in addition to the password. */
  keyfileRequired: boolean;
  /** ZIP entry that holds the document body. */
  contentEntry: string;
  /** Title/signatures/journal are encrypted inside the body (not in clear). */
  metadataEncrypted?: boolean;
  /** Multi-recipient: fingerprints of the P-256 keys that can open this file. */
  recipients?: string[];
}

export interface IntegrityState {
  algorithm: "sha-256";
  /** Hash of the bytes stored at `protection.contentEntry` (tamper detection). */
  contentHash: string | null;
}

export interface RgpdMetadata {
  /** True while the file has never been synced to any remote service. */
  localOnly: boolean;
  /** Personal data fields intentionally stored in this file. */
  storedPersonalData: string[];
  notice: string;
}

/**
 * Optional document seal — one Ed25519 signature over a canonical digest of the
 * integrity-critical parts (manifest subset + signatures + journal). It makes
 * silent tampering of the content, the journal, the signature set or the profile
 * badge detectable. See sign/seal.ts. Never a qualified signature.
 */
export interface DocumentSeal {
  alg: "ed25519";
  publicKeyHex: string;
  fingerprint: string;
  sealedAt: string;
  signatureHex: string;
}

export interface EliumManifest {
  format: typeof ELIUM_FORMAT;
  formatVersion: typeof ELIUM_FORMAT_VERSION;
  profile: EliumProfile;
  generator: string;
  /** Stable unique document id (UUID). Used as the local index key (versions,
   *  Parapheur, seal pinning). Legacy files without it fall back to createdAt
   *  (see docKeyOf). Not part of the signed seal subset. */
  docId?: string;
  createdAt: string;
  modifiedAt: string;
  title: string;
  language: string;
  protection: ProtectionState;
  integrity: IntegrityState;
  features: { signatures: boolean; tracking: boolean; resources: number };
  rgpd: RgpdMetadata;
  /** Optional access-expiry date (ISO). Authenticated by the seal when present. */
  accessExpiresAt?: string;
  /** Optional cryptographic seal over the integrity-critical parts. */
  seal?: DocumentSeal;
}

/** Fully-loaded document in memory (after opening + optional decryption). */
export interface EliumFile {
  manifest: EliumManifest;
  document: EliumDocumentModel;
  signatures: EliumSignature[];
  resources: Map<string, Uint8Array>; // id -> bytes
  resourceIndex: EliumResource[];
  journal: Journal;
}
