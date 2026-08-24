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
  encryptForRecipients,
  decryptAsRecipient,
  recipientFingerprint,
  type RecipientKeypair,
} from "../crypto/recipients";
import { createSeal, verifySeal, type SealVerdict } from "../sign/seal";
import { sha256Hex, nowIso } from "./canonical";
import { profileOf } from "./profiles";
import { emptyJournal } from "./journal";
import {
  ELIUM_FORMAT,
  ELIUM_FORMAT_VERSION,
  ELIUM_MIMETYPE,
  type DocumentSeal,
  type EliumFile,
  type EliumManifest,
  type EliumParapheur,
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
  parapheur: "parapheur/circuit.json",
  resIndex: "resources/index.json",
  rgpd: "meta/rgpd.json",
} as const;

export interface WriteOptions {
  password?: string;
  keyfile?: Uint8Array;
  /** Ed25519 private key (hex) used to seal the integrity-critical parts. */
  sealPrivateKeyHex?: string;
  /**
   * Carry an EXISTING seal forward unchanged when this write touches nothing
   * the seal covers (the manifest's integrity subset / signatures / journal —
   * see sign/seal.ts) and no `sealPrivateKeyHex` is given to compute a fresh
   * one. Used for a parapheur-only update: the circuit is deliberately outside
   * what the seal signs (see EliumParapheur), so preserving it here is exact,
   * not a shortcut. Safe even if misapplied elsewhere — `verifySeal` re-derives
   * the signed message from the ACTUAL output bytes, so a carried-forward seal
   * that no longer matches simply reads "broken" on next read; it can never be
   * mistaken for a fresh "valid" claim.
   */
  carryForwardSeal?: DocumentSeal;
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
  /** Circuit parapheur (noms = PII) — chiffré avec le reste des métadonnées. */
  parapheur?: EliumParapheur;
}

export interface IntegrityVerdict {
  /** Stored bytes match the manifest's recorded hash. */
  contentIntact: boolean;
  /** Hash check could not run (e.g. no recorded hash). */
  unchecked: boolean;
  /** Ressources rejetées à la lecture car `sha256(octets) !== id` (content-
   *  addressed) : elles ont été substituées/corrompues et ne sont pas chargées. */
  resourcesTampered?: string[];
}

export interface ReadResult {
  file: EliumFile;
  integrity: IntegrityVerdict;
  seal: { verdict: SealVerdict; fingerprint: string | null };
}

// Hard caps to bound memory when opening an attacker-supplied archive.
// Alignés sur le lecteur Python (src/elium/format/package.py) — parité DoS.
const MAX_ENTRY_BYTES = 128 * 1024 * 1024; // 128 MiB per uncompressed entry
const MAX_TOTAL_BYTES = 384 * 1024 * 1024; // 384 MiB total uncompressed
const MAX_ZIP_ENTRIES = 10_000; // refuse un nombre d'entrées pathologique
const MAX_JSON_DEPTH = 200; // refuse un JSON pathologiquement imbriqué

export class EliumPackageError extends Error {}

/** Garde de profondeur JSON (ignore les crochets à l'intérieur des chaînes),
 *  miroir de `_json_depth_ok` en Python. Défend `JSON.parse` contre une
 *  structure pathologiquement imbriquée AVANT de la parser. */
function jsonDepthOk(s: string, limit = MAX_JSON_DEPTH): boolean {
  let depth = 0,
    inStr = false,
    escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (escape) escape = false;
      else if (c === 0x5c)
        escape = true; // backslash
      else if (c === 0x22) inStr = false; // "
      continue;
    }
    if (c === 0x22) inStr = true;
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > limit) return false;
    } // { [
    else if (c === 0x7d || c === 0x5d) depth--; // } ]
  }
  return true;
}

/** Parse JSON d'une entrée d'archive avec garde de profondeur + erreur typée. */
function safeJsonParse<T>(bytes: Uint8Array, what: string): T {
  const s = strFromU8(bytes);
  if (!jsonDepthOk(s)) throw new EliumPackageError(`Structure JSON trop imbriquée (${what}).`);
  try {
    return JSON.parse(s) as T;
  } catch {
    throw new EliumPackageError(`JSON invalide (${what}).`);
  }
}
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
        "Données traitées localement. Voir la Documentation. Aucune donnée n'est envoyée en ligne sans action explicite.",
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
            ...(file.parapheur ? { parapheur: file.parapheur } : {}),
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

  // Clear (on-disk) signatures/journal/parapheur are redacted when metadata is
  // encrypted; the real ones live in the encrypted envelope, bound via
  // integrity.contentHash.
  const clearSignatures = secure ? [] : file.signatures;
  const clearJournal = secure ? emptyJournal() : file.journal;
  const clearParapheur = secure ? undefined : file.parapheur;

  // Seal the integrity-critical parts (the clear, possibly-redacted entries).
  if (opts.sealPrivateKeyHex) {
    manifest.seal = await createSeal(manifest, clearSignatures, clearJournal, opts.sealPrivateKeyHex);
  } else if (opts.carryForwardSeal) {
    manifest.seal = opts.carryForwardSeal;
  }

  const resIndex: EliumResource[] = file.resourceIndex;

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 | 9 }]> = {
    [ENTRY.mimetype]: [strToU8(ELIUM_MIMETYPE), { level: 0 }],
    [ENTRY.manifest]: strToU8(JSON.stringify(manifest, null, 2)),
    // Le contenu chiffré est de haute entropie : deflate ne gagne rien et coûte
    // du CPU → STORED. Le contenu en clair (JSON) reste compressé.
    [def.encrypted ? ENTRY.contentEnc : ENTRY.contentPlain]: def.encrypted
      ? [contentBytes, { level: 0 }]
      : contentBytes,
    [ENTRY.signatures]: strToU8(JSON.stringify(clearSignatures, null, 2)),
    [ENTRY.journal]: strToU8(JSON.stringify(clearJournal, null, 2)),
    ...(clearParapheur ? { [ENTRY.parapheur]: strToU8(JSON.stringify(clearParapheur, null, 2)) } : {}),
    [ENTRY.resIndex]: strToU8(JSON.stringify(resIndex, null, 2)),
    [ENTRY.rgpd]: strToU8(JSON.stringify(manifest.rgpd, null, 2)),
  };

  for (const res of resIndex) {
    const bytes = file.resources.get(res.id);
    // Ressources (PNG/JPEG/polices) déjà compressées → STORED (gain CPU/taille).
    if (bytes) files[`resources/${res.id}`] = [bytes, { level: 0 }];
  }

  return zipSync(files as Record<string, Uint8Array>);
}

// --- Read -----------------------------------------------------------------

export async function readEliumPackage(blob: Uint8Array, opts: WriteOptions = {}): Promise<ReadResult> {
  let entries: Record<string, Uint8Array>;
  let total = 0;
  let count = 0;
  const seenNames = new Set<string>();
  try {
    entries = unzipSync(blob, {
      filter: (f) => {
        // 1re passe sur les tailles DÉCLARÉES (central directory) + nombre
        // d'entrées : arrête net une bombe zip qui annonce sa taille.
        if (++count > MAX_ZIP_ENTRIES) {
          throw new EliumPackageError("Trop d'entrées dans l'archive .elium (protection DoS).");
        }
        // Entrées dupliquées = archive suspecte (confusion d'analyseur : un autre
        // outil pourrait lire l'autre occurrence, non couverte par le hash/sceau).
        if (seenNames.has(f.name)) {
          throw new EliumPackageError("Entrée d'archive .elium dupliquée (fichier suspect).");
        }
        seenNames.add(f.name);
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

  // 2e passe : ne jamais faire confiance à la taille déclarée. On revérifie les
  // tailles RÉELLES après décompression (attrape un en-tête menteur : taille
  // annoncée minuscule, inflate énorme) avant toute utilisation des données.
  let actualTotal = 0;
  for (const name in entries) {
    const len = entries[name]!.length;
    if (len > MAX_ENTRY_BYTES)
      throw new EliumPackageError("Entrée trop volumineuse dans le fichier .elium (protection DoS).");
    actualTotal += len;
    if (actualTotal > MAX_TOTAL_BYTES) throw new EliumPackageError("Fichier .elium trop volumineux (protection DoS).");
  }

  // Contrat OPC : l'entrée `mimetype` doit exister et valoir la valeur exacte —
  // refuse une archive ZIP quelconque renommée .elium (sniffing fiable).
  const mimetypeRaw = entries[ENTRY.mimetype];
  if (!mimetypeRaw || strFromU8(mimetypeRaw).trim() !== ELIUM_MIMETYPE) {
    throw new EliumPackageError("Ce fichier n'est pas un document Elium (mimetype OPC absent ou invalide).");
  }

  const manifestRaw = entries[ENTRY.manifest];
  if (!manifestRaw) throw new EliumPackageError("Manifeste manquant : fichier .elium invalide.");

  const manifest = safeJsonParse<EliumManifest>(manifestRaw, "manifeste");
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
  let integrity: IntegrityVerdict = { contentIntact: true, unchecked: true, resourcesTampered: [] };
  if (manifest.integrity.contentHash) {
    const actual = await sha256Hex(contentBytes);
    integrity = { contentIntact: actual === manifest.integrity.contentHash, unchecked: false, resourcesTampered: [] };
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
    document = safeJsonParse(contentBytes, "contenu");
  }

  // Clear entries (redacted when secure) — the seal is verified over these.
  const clearSignatures: EliumSignature[] = entries[ENTRY.signatures]
    ? safeJsonParse(entries[ENTRY.signatures], "signatures")
    : [];
  const clearJournal: Journal = entries[ENTRY.journal]
    ? safeJsonParse(entries[ENTRY.journal], "journal")
    : emptyJournal();
  const clearParapheur: EliumParapheur | undefined = entries[ENTRY.parapheur]
    ? safeJsonParse(entries[ENTRY.parapheur], "parapheur")
    : undefined;
  const resourceIndex: EliumResource[] = entries[ENTRY.resIndex]
    ? safeJsonParse(entries[ENTRY.resIndex], "index des ressources")
    : [];

  // Ressources content-addressed : l'`id` DOIT valoir sha256(octets). Une
  // ressource dont le hash ne correspond pas a été substituée/corrompue — on ne
  // la charge PAS (anti-falsification d'image/tampon/police, y compris dans un
  // document scellé où le sceau ne couvre pas les octets des ressources). Les
  // fichiers valides passent (id écrit = sha256 à l'ajout).
  const resources = new Map<string, Uint8Array>();
  const resourcesTampered: string[] = [];
  for (const res of resourceIndex) {
    const bytes = entries[`resources/${res.id}`];
    if (!bytes) continue;
    const actual = await sha256Hex(bytes);
    if (actual === res.id) resources.set(res.id, bytes);
    else resourcesTampered.push(res.id);
  }
  if (resourcesTampered.length) integrity = { ...integrity, resourcesTampered };

  const sealVerdict = await verifySeal(manifest, clearSignatures, clearJournal, opts.trustedKeyHex);

  // Surface the REAL decrypted metadata to callers when encrypted.
  const signatures = envelope ? (envelope.signatures ?? []) : clearSignatures;
  const journal = envelope ? (envelope.journal ?? emptyJournal()) : clearJournal;
  const parapheur = envelope ? envelope.parapheur : clearParapheur;
  const effectiveManifest = envelope ? { ...manifest, title: envelope.title } : manifest;

  return {
    file: { manifest: effectiveManifest, document, signatures, resources, resourceIndex, journal, parapheur },
    integrity,
    seal: { verdict: sealVerdict, fingerprint: manifest.seal?.fingerprint ?? null },
  };
}

/**
 * Verify a *loaded* file's seal the way the writer computed it.
 *
 * With metadata encryption on, the seal is signed over the REDACTED clear entries
 * (empty signatures, empty journal) — the real signatures/journal travel encrypted
 * inside the body (see `writeEliumPackage`). An in-memory `EliumFile` carries those
 * REAL decrypted values, so verifying the seal against `file.signatures` /
 * `file.journal` directly wrongly reports "broken" for any metadata-encrypted
 * document that has a signature or a tracked journal. This mirrors the write-time
 * redaction so a live re-verification (e.g. the viewer's verification banner) agrees
 * with `readEliumPackage`'s own verdict.
 *
 * The title is redacted too: the seal signs `REDACTED_TITLE`, but `readEliumPackage`
 * returns the manifest with the REAL title restored from the envelope, and `title`
 * is part of the sealed manifest subset.
 */
export async function verifyLoadedSeal(file: EliumFile, trustedKeyHex?: string): Promise<SealVerdict> {
  const secure = !!file.manifest.protection.metadataEncrypted;
  if (!secure) return verifySeal(file.manifest, file.signatures, file.journal, trustedKeyHex);
  const sealManifest: EliumManifest = { ...file.manifest, title: REDACTED_TITLE };
  return verifySeal(sealManifest, [], emptyJournal(), trustedKeyHex);
}

/** Quick sniff: is this byte blob a v4 `.elium` package (vs. a legacy v3 blob)? */
export function looksLikeV4Package(blob: Uint8Array): boolean {
  // ZIP local file header "PK\x03\x04"
  return blob.length > 4 && blob[0] === 0x50 && blob[1] === 0x4b && blob[2] === 0x03 && blob[3] === 0x04;
}

export const PACKAGE_ENTRIES = ENTRY;
