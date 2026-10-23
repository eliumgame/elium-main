/**
 * Point d'entrée unique du Détecteur : détecte le format d'un fichier ouvert
 * par l'utilisateur (.elium / .docx / .pdf / une image seule) et le convertit
 * en `DocumentModel` via le bon pipeline d'ingestion. Les exceptions de mot
 * de passe des lecteurs sous-jacents (`EliumPasswordRequired`,
 * `EliumRecipientKeyRequired`, `PdfPasswordRequired`) sont ré-exportées
 * telles quelles : c'est l'appelant (l'UI) qui sait proposer une invite et
 * relancer avec le mot de passe.
 */
import { yieldToMain } from "../../workers/yield";
import { strFromU8, unzipSync } from "fflate";
import { docxToDoc } from "../../format/docx";
import {
  EliumPasswordRequired,
  EliumRecipientKeyRequired,
  looksLikeV4Package,
  readEliumPackage,
} from "../../format/elium-package";
import { PdfPasswordRequired } from "../../pdf/core/engine";
import type { DocumentMetadata, DocumentModel } from "../types";
import { readImageDimensions } from "./imageDimensions";
import { documentModelFromPdf } from "./fromPdf";
import { documentModelFromProseMirrorDoc } from "./fromProseMirror";

export { EliumPasswordRequired, EliumRecipientKeyRequired, PdfPasswordRequired };

export type DetectorFileKind = "elium" | "docx" | "pdf" | "image";

export interface LoadFileOptions {
  password?: string;
  keyfile?: Uint8Array;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function isWebp(bytes: Uint8Array): boolean {
  // "RIFF" .... "WEBP" — la taille (4 octets) sépare les deux marqueurs.
  if (bytes.length < 12) return false;
  const riff = String.fromCharCode(...bytes.subarray(0, 4));
  const webp = String.fromCharCode(...bytes.subarray(8, 12));
  return riff === "RIFF" && webp === "WEBP";
}

function detectImageMime(name: string, bytes: Uint8Array): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "png" || PNG_MAGIC.every((b, i) => bytes[i] === b)) return "image/png";
  if (["jpg", "jpeg"].includes(ext) || JPEG_MAGIC.every((b, i) => bytes[i] === b)) return "image/jpeg";
  if (ext === "webp" || isWebp(bytes)) return "image/webp";
  return null;
}

export function detectFileKind(name: string, bytes: Uint8Array): DetectorFileKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || PDF_MAGIC.every((b, i) => bytes[i] === b)) return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "elium" || looksLikeV4Package(bytes)) return "elium";
  if (detectImageMime(name, bytes)) return "image";
  return null;
}

export class UnsupportedFileError extends Error {}

/** Plafonds de l'analyse d'un .docx (elle décompresse et parcourt tout le document sur le fil principal). */
export const MAX_DOCX_BYTES = 80 * 1024 * 1024;
export const MAX_DOCX_UNZIPPED_BYTES = 400 * 1024 * 1024;

/**
 * Refuse, avec un message clair, un .docx trop gros ou une bombe de décompression, AVANT de le décompresser :
 * la taille décompressée se lit dans l'annuaire du zip sans rien inflater (le filtre écarte tout).
 */
export function assertDocxWithinLimits(bytes: Uint8Array, maxUnzipped = MAX_DOCX_UNZIPPED_BYTES): void {
  const mo = (n: number) => `${Math.round(n / 1048576)} Mo`;
  if (bytes.length > MAX_DOCX_BYTES)
    throw new Error(
      `Ce fichier .docx est trop volumineux pour l'analyse (${mo(bytes.length)}, maximum ${mo(MAX_DOCX_BYTES)}).`,
    );
  let total = 0;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        return false;
      },
    });
  } catch {
    return; // zip illisible : docxToDoc le signalera lui-même
  }
  if (total > maxUnzipped)
    throw new Error(
      `Ce fichier .docx contient trop de données une fois décompressé (${mo(total)}, maximum ${mo(maxUnzipped)}).`,
    );
}

export async function loadDocumentModel(file: File, opts: LoadFileOptions = {}): Promise<DocumentModel> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detectFileKind(file.name, bytes);

  if (kind === "pdf") {
    const { paragraphs, images, metadata } = await documentModelFromPdf(bytes, opts.password);
    return { paragraphs, images, metadata: { sourceFormat: "pdf", ...metadata } };
  }

  if (kind === "docx") {
    assertDocxWithinLimits(bytes);
    await yieldToMain(); // l'analyse du .docx est synchrone : on cède la main avant de l'entamer
    const { title, doc } = docxToDoc(bytes);
    const { paragraphs, images } = documentModelFromProseMirrorDoc(doc, "docx");
    return { paragraphs, images, metadata: extractDocxMetadata(bytes, title) };
  }

  if (kind === "elium") {
    const result = await readEliumPackage(bytes, { password: opts.password, keyfile: opts.keyfile });
    const { paragraphs, images } = documentModelFromProseMirrorDoc(result.file.document.doc, "elium");
    const m = result.file.manifest;
    const metadata: DocumentMetadata = { sourceFormat: "elium", title: m.title };
    if (m.createdAt) metadata.createdAt = m.createdAt;
    if (m.modifiedAt) metadata.modifiedAt = m.modifiedAt;
    return { paragraphs, images, metadata };
  }

  if (kind === "image") {
    const mime = detectImageMime(file.name, bytes)!;
    const { width, height } = readImageDimensions(bytes);
    return {
      paragraphs: [],
      images: [{ index: 0, bytes, mime, ...(width != null && { width }), ...(height != null && { height }) }],
      metadata: { sourceFormat: "image", title: file.name },
    };
  }

  throw new UnsupportedFileError(
    `Format de fichier non pris en charge : « ${file.name} ». Formats acceptés : .elium, .docx, .pdf, ou une image seule (.png, .jpg, .webp).`,
  );
}

/** OOXML docProps: `dc:creator` in core.xml is the human author, `Application`
 *  in app.xml is the producing software — kept distinct to match this
 *  module's DocumentMetadata.author vs .creator split (see ../types.ts). */
function extractDocxMetadata(bytes: Uint8Array, title: string): DocumentMetadata {
  const metadata: DocumentMetadata = { sourceFormat: "docx", title };
  try {
    const zip = unzipSync(bytes, { filter: (f) => f.name === "docProps/core.xml" || f.name === "docProps/app.xml" });
    const core = zip["docProps/core.xml"];
    if (core) {
      const xml = strFromU8(core);
      const author = xmlTag(xml, "dc:creator");
      if (author) metadata.author = author;
      const createdAt = normalizeIso(xmlTag(xml, "dcterms:created"));
      if (createdAt) metadata.createdAt = createdAt;
      const modifiedAt = normalizeIso(xmlTag(xml, "dcterms:modified"));
      if (modifiedAt) metadata.modifiedAt = modifiedAt;
      const revision = parseInt(xmlTag(xml, "cp:revision") ?? "", 10);
      if (Number.isFinite(revision)) metadata.revisionCount = revision;
    }
    const app = zip["docProps/app.xml"];
    if (app) {
      const xml = strFromU8(app);
      const application = xmlTag(xml, "Application");
      if (application) metadata.creator = application;
      const totalTime = parseInt(xmlTag(xml, "TotalTime") ?? "", 10);
      if (Number.isFinite(totalTime)) metadata.editingMinutes = totalTime;
      const pages = parseInt(xmlTag(xml, "Pages") ?? "", 10);
      if (Number.isFinite(pages)) metadata.pageCount = pages;
    }
  } catch {
    // docProps/*.xml absent ou malformé : on garde juste le titre déjà connu.
  }
  return metadata;
}

function xmlTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`);
  const m = re.exec(xml);
  const v = m?.[1]?.trim();
  return v || undefined;
}

function normalizeIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
