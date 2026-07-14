/**
 * `.elium` package reader/writer.
 *
 * On disk a `.elium` file is a ZIP package (OPC-style):
 *
 *   mimetype                     "application/x-elium"  (stored, first entry)
 *   manifest.json                always clear-text — describes profile & protection
 *   content/document.json        document body (clear-text profiles)   ── or ──
 *   content/document.elium       document body wrapped in a v3 encrypted container
 *   signatures/signatures.json   visual signatures + optional crypto proofs
 *   tracking/journal.json        hash-chained activity log
 *   resources/index.json         attachment index
 *   resources/<id>               attachment bytes (content-addressed)
 *   meta/rgpd.json               RGPD metadata
 *
 * Encryption reuses the audited v3 container (Argon2id + AES-256-GCM + HMAC)
 * as the body cipher, which keeps full interoperability with the Python core.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { EliumCryptoEngine } from "../crypto/elium-crypto";
import {
  encryptForRecipients, decryptAsRecipient, recipientFingerprint, type RecipientKeypair,
} from "../crypto/recipients";
import { createSeal, verifySeal, type SealVerdict } from "../sign/seal";
import { sha256Hex, nowIso } from "./canonical";
import { profileOf } from "./profiles";
import { emptyJournal } from "./journal";
import {
  ELIUM_FORMAT,
  ELIUM_FORMAT_VERSION,
  ELIUM_MIMETYPE,
  type EliumFile,
  type EliumManifest,
  type EliumResource,
  type EliumSignature,
  type Journal,
} from "./types";

const ENTRY = {
  mimetype: "mimetype",
  manifest: "manifest.json",
  contentPlain: "content/document.json",
  contentEnc: "content/document.elium",
  signatures: "signatures/signatures.json",
  journal: "tracking/journal.json",
  resIndex: "resources/index.json",
  rgpd: "meta/rgpd.json",
} as const;

export interface WriteOptions {
  password?: string;
  keyfile?: Uint8Array;
  /** Ed25519 private key (hex) used to seal the integrity-critical parts. */
  sealPrivateKeyHex?: string;
  /** Expected seal/proof signer key (hex) for attribution on read. */
  trustedKeyHex?: string;
  /** Encrypt title/signatures/journal inside the body (encrypted profiles only). */
  encryptMetadata?: boolean;
  /** Multi-recipient: P-256 public keys (hex) to encrypt TO instead of a password. */
  recipients?: string[];
  /** The reader's recipient keypair, to open a multi-recipient file. */
  recipientKey?: RecipientKeypair;
}

// When metadata encryption is on, the sensitive fields ride inside the encrypted
// body under this envelope; the clear ZIP entries are redacted. Mirror of package.py.
const SECURE_SCHEMA = "elium-secure/1";
const REDACTED_TITLE = "Document chiffré";

interface SecureEnvelope {
  schema: typeof SECURE_SCHEMA;
  document: EliumFile["document"];
  title: string;
  signatures: EliumSignature[];
  journal: Journal;
}

export interface IntegrityVerdict {
  /** Stored bytes match the manifest's recorded hash. */
  contentIntact: boolean;
  /** Hash check could not run (e.g. no recorded hash). */
  unchecked: boolean;
}

export interface ReadResult {
  file: EliumFile;
  integrity: IntegrityVerdict;
  seal: { verdict: SealVerdict; fingerprint: string | null };
}

// Hard caps to bound memory when opening an attacker-supplied archive.
const MAX_ENTRY_BYTES = 128 * 1024 * 1024; // 128 MiB per uncompressed entry
const MAX_TOTAL_BYTES = 384 * 1024 * 1024; // 384 MiB total uncompressed

export class EliumPackageError extends Error {}
export class EliumPasswordRequired extends EliumPackageError {
  constructor() {
    super("Ce document est chiffré : un mot de passe est requis.");
  }
}
export class EliumRecipientKeyRequired extends EliumPackageError {
  constructor() {
    super("Ce document est chiffré pour des destinataires : votre clé de réception est requise.");
  }
}

// --- Manifest construction ------------------------------------------------

export function buildManifest(
  file: EliumFile,
  contentHash: string | null,
  secure = false,
  recipientFprs?: string[],
): EliumManifest {
  const def = profileOf(file.manifest.profile);
  const encrypted = def.encrypted;
  return {
    format: ELIUM_FORMAT,
    formatVersion: ELIUM_FORMAT_VERSION,
    profile: file.manifest.profile,
    generator: "elium-web/4.0.0",
    // Preserve the stable document id across saves (mint one for legacy files).
    docId: file.manifest.docId ?? crypto.randomUUID(),
    createdAt: file.manifest.createdAt,
    modifiedAt: nowIso(),
    // Clear metadata is redacted when metadata encryption is on.
    title: secure ? REDACTED_TITLE : file.manifest.title,
    language: file.manifest.language || "fr",
    protection: {
      encrypted,
      locked: def.locked,
      keyfileRequired: file.manifest.protection.keyfileRequired,
      contentEntry: encrypted ? ENTRY.contentEnc : ENTRY.contentPlain,
      ...(secure ? { metadataEncrypted: true } : {}),
      ...(recipientFprs && recipientFprs.length ? { recipients: recipientFprs } : {}),
    },
    integrity: { algorithm: "sha-256", contentHash },
    features: {
      signatures: secure ? false : file.signatures.length > 0,
      tracking: secure ? false : def.tracking || file.journal.events.length > 0,
      resources: file.resourceIndex.length,
    },
    rgpd: {
      localOnly: true,
      storedPersonalData: secure ? [] : collectPersonalData(file),
      notice:
        "Données traitées localement. Voir PRIVACY_RGPD.md. Aucune donnée n'est envoyée en ligne sans action explicite.",
    },
    ...(file.manifest.accessExpiresAt ? { accessExpiresAt: file.manifest.accessExpiresAt } : {}),
  };
}

function collectPersonalData(file: EliumFile): string[] {
  const set = new Set<string>();
  for (const s of file.signatures) {
    if (s.signer.name) set.add("nom du signataire");
    if (s.signer.role) set.add("rôle du signataire");
    if (s.signer.org) set.add("organisation");
    if (s.proof) set.add("empreinte de clé publique");
  }
  return [...set];
}

// --- Write ----------------------------------------------------------------

export async function writeEliumPackage(file: EliumFile, opts: WriteOptions = {}): Promise<Uint8Array> {
  const def = profileOf(file.manifest.profile);
  const secure = !!opts.encryptMetadata && def.encrypted;

  // Guard against a silent-plaintext foot-gun: passing `recipients` on a
  // profile that isn't encrypted used to be accepted silently, writing the
  // document in the clear as if no recipients had been requested at all.
  if (opts.recipients?.length && !def.encrypted) {
    throw new EliumPackageError(
      `Le profil « ${file.manifest.profile} » n'est pas chiffré : des destinataires ont été ` +
        "fournis mais seraient ignorés et le document serait écrit EN CLAIR. " +
        "Utilisez un profil chiffré (protected, encrypted ou secure_max).",
    );
  }

  const useRecipients = def.encrypted && !!opts.recipients?.length;
  let contentBytes: Uint8Array;
  let recipientFprs: string[] | undefined;
  if (def.encrypted) {
    const payload = secure
      ? strToU8(
          JSON.stringify({
            schema: SECURE_SCHEMA,
            document: file.document,
            title: file.manifest.title,
            signatures: file.signatures,
            journal: file.journal,
          } satisfies SecureEnvelope),
        )
      : strToU8(JSON.stringify(file.document));
    if (useRecipients) {
      // Recipient envelope replaces the password container as the body cipher.
      // secure_max cascades a ChaCha20-Poly1305 layer here too, same as the
      // password path just below.
      contentBytes = await encryptForRecipients(payload, opts.recipients!, file.manifest.profile === "secure_max");
      recipientFprs = await Promise.all(opts.recipients!.map((p) => recipientFingerprint(p)));
    } else {
      if (!opts.password && !opts.keyfile) throw new EliumPasswordRequired();
      contentBytes = await EliumCryptoEngine.encodeContainer(
        payload,
        opts.password ?? "",
        secure ? "content.json" : `${file.manifest.title || "document"}.json`,
        undefined,
        opts.keyfile,
        file.manifest.profile === "secure_max", // cascade on the strongest profile
      );
    }
  } else {
    contentBytes = strToU8(JSON.stringify(file.document));
  }

  const contentHash = await sha256Hex(contentBytes);
  const manifest = buildManifest(file, contentHash, secure, recipientFprs);

  // Clear (on-disk) signatures/journal are redacted when metadata is encrypted;
  // the real ones live in the encrypted envelope, bound via integrity.contentHash.
  const clearSignatures = secure ? [] : file.signatures;
  const clearJournal = secure ? emptyJournal() : file.journal;

  // Seal the integrity-critical parts (the clear, possibly-redacted entries).
  if (opts.sealPrivateKeyHex) {
    manifest.seal = await createSeal(manifest, clearSignatures, clearJournal, opts.sealPrivateKeyHex);
  }

  const resIndex: EliumResource[] = file.resourceIndex;

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 | 9 }]> = {
    [ENTRY.mimetype]: [strToU8(ELIUM_MIMETYPE), { level: 0 }],
    [ENTRY.manifest]: strToU8(JSON.stringify(manifest, null, 2)),
    [def.encrypted ? ENTRY.contentEnc : ENTRY.contentPlain]: contentBytes,
    [ENTRY.signatures]: strToU8(JSON.stringify(clearSignatures, null, 2)),
    [ENTRY.journal]: strToU8(JSON.stringify(clearJournal, null, 2)),
    [ENTRY.resIndex]: strToU8(JSON.stringify(resIndex, null, 2)),
    [ENTRY.rgpd]: strToU8(JSON.stringify(manifest.rgpd, null, 2)),
  };

  for (const res of resIndex) {
    const bytes = file.resources.get(res.id);
    if (bytes) files[`resources/${res.id}`] = bytes;
  }

  return zipSync(files as Record<string, Uint8Array>);
}

// --- Read -----------------------------------------------------------------

export async function readEliumPackage(
  blob: Uint8Array,
  opts: WriteOptions = {},
): Promise<ReadResult> {
  let entries: Record<string, Uint8Array>;
  let total = 0;
  try {
    entries = unzipSync(blob, {
      filter: (f) => {
        total += f.originalSize;
        if (f.originalSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) {
          throw new EliumPackageError("Fichier .elium trop volumineux (protection DoS).");
        }
        return true;
      },
    });
  } catch (e) {
    if (e instanceof EliumPackageError) throw e;
    throw new EliumPackageError("Fichier .elium illisible (archive corrompue).");
  }

  const manifestRaw = entries[ENTRY.manifest];
  if (!manifestRaw) throw new EliumPackageError("Manifeste manquant : fichier .elium invalide.");

  const manifest = JSON.parse(strFromU8(manifestRaw)) as EliumManifest;
  if (manifest.format !== ELIUM_FORMAT) {
    throw new EliumPackageError("Ce fichier n'est pas un document Elium.");
  }
  if (manifest.formatVersion > ELIUM_FORMAT_VERSION) {
    throw new EliumPackageError(
      `Version de format ${manifest.formatVersion} non prise en charge (max ${ELIUM_FORMAT_VERSION}).`,
    );
  }

  const contentEntry = manifest.protection.contentEntry;
  const contentBytes = entries[contentEntry];
  if (!contentBytes) throw new EliumPackageError("Contenu du document manquant.");

  // Integrity check on the *stored* bytes (tamper detection).
  let integrity: IntegrityVerdict = { contentIntact: true, unchecked: true };
  if (manifest.integrity.contentHash) {
    const actual = await sha256Hex(contentBytes);
    integrity = { contentIntact: actual === manifest.integrity.contentHash, unchecked: false };
  }

  const secure = !!manifest.protection.metadataEncrypted;
  const useRecipients = !!manifest.protection.recipients?.length;
  let document: EliumFile["document"];
  let envelope: SecureEnvelope | null = null;
  if (manifest.protection.encrypted) {
    let payloadBytes: Uint8Array;
    if (useRecipients) {
      if (!opts.recipientKey) throw new EliumRecipientKeyRequired();
      payloadBytes = await decryptAsRecipient(contentBytes, opts.recipientKey);
    } else {
      if (!opts.password && !opts.keyfile) throw new EliumPasswordRequired();
      const { payload } = await EliumCryptoEngine.decodeContainer(
        contentBytes,
        opts.password ?? "",
        undefined,
        opts.keyfile,
      );
      payloadBytes = payload;
    }
    const parsed = JSON.parse(strFromU8(payloadBytes));
    if (secure) {
      if (!parsed || parsed.schema !== SECURE_SCHEMA) {
        throw new EliumPackageError("Enveloppe de métadonnées chiffrées invalide.");
      }
      envelope = parsed as SecureEnvelope;
      document = envelope.document;
    } else {
      document = parsed;
    }
  } else {
    document = JSON.parse(strFromU8(contentBytes));
  }

  // Clear entries (redacted when secure) — the seal is verified over these.
  const clearSignatures: EliumSignature[] = entries[ENTRY.signatures]
    ? JSON.parse(strFromU8(entries[ENTRY.signatures]))
    : [];
  const clearJournal: Journal = entries[ENTRY.journal]
    ? JSON.parse(strFromU8(entries[ENTRY.journal]))
    : emptyJournal();
  const resourceIndex: EliumResource[] = entries[ENTRY.resIndex]
    ? JSON.parse(strFromU8(entries[ENTRY.resIndex]))
    : [];

  const resources = new Map<string, Uint8Array>();
  for (const res of resourceIndex) {
    const bytes = entries[`resources/${res.id}`];
    if (bytes) resources.set(res.id, bytes);
  }

  const sealVerdict = await verifySeal(manifest, clearSignatures, clearJournal, opts.trustedKeyHex);

  // Surface the REAL decrypted metadata to callers when encrypted.
  const signatures = envelope ? envelope.signatures ?? [] : clearSignatures;
  const journal = envelope ? envelope.journal ?? emptyJournal() : clearJournal;
  const effectiveManifest = envelope ? { ...manifest, title: envelope.title } : manifest;

  return {
    file: { manifest: effectiveManifest, document, signatures, resources, resourceIndex, journal },
    integrity,
    seal: { verdict: sealVerdict, fingerprint: manifest.seal?.fingerprint ?? null },
  };
}

/** Quick sniff: is this byte blob a v4 `.elium` package (vs. a legacy v3 blob)? */
export function looksLikeV4Package(blob: Uint8Array): boolean {
  // ZIP local file header "PK\x03\x04"
  return blob.length > 4 && blob[0] === 0x50 && blob[1] === 0x4b && blob[2] === 0x03 && blob[3] === 0x04;
}

export const PACKAGE_ENTRIES = ENTRY;
