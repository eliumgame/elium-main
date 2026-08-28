/**
 * Point d'entrée unique du Détecteur : détecte le format d'un fichier ouvert
 * par l'utilisateur (.elium / .docx / .pdf) et le convertit en `DocumentModel`
 * via le bon pipeline d'ingestion. Les exceptions de mot de passe des lecteurs
 * sous-jacents (`EliumPasswordRequired`, `EliumRecipientKeyRequired`,
 * `PdfPasswordRequired`) sont ré-exportées telles quelles : c'est l'appelant
 * (l'UI) qui sait proposer une invite et relancer avec le mot de passe.
 */
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
import { documentModelFromPdf } from "./fromPdf";
import { documentModelFromProseMirrorDoc } from "./fromProseMirror";

export { EliumPasswordRequired, EliumRecipientKeyRequired, PdfPasswordRequired };

export type DetectorFileKind = "elium" | "docx" | "pdf";

export interface LoadFileOptions {
  password?: string;
  keyfile?: Uint8Array;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

export function detectFileKind(name: string, bytes: Uint8Array): DetectorFileKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || PDF_MAGIC.every((b, i) => bytes[i] === b)) return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "elium" || looksLikeV4Package(bytes)) return "elium";
  return null;
}

export class UnsupportedFileError extends Error {}

export async function loadDocumentModel(file: File, opts: LoadFileOptions = {}): Promise<DocumentModel> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detectFileKind(file.name, bytes);

  if (kind === "pdf") {
    const { paragraphs, images, metadata } = await documentModelFromPdf(bytes, opts.password);
    return { paragraphs, images, metadata: { sourceFormat: "pdf", ...metadata } };
  }

  if (kind === "docx") {
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

  throw new UnsupportedFileError(
    `Format de fichier non pris en charge : « ${file.name} ». Formats acceptés : .elium, .docx, .pdf.`,
  );
}

/** OOXML docProps: `dc:creator` in core.xml is the human author, `Application`
 *  in app.xml is the producing software — kept distinct to match this
 *  module's DocumentMetadata.author vs .creator split (see ../types.ts). */
function extractDocxMetadata(bytes: Uint8Array, title: string): DocumentMetadata {
  const metadata: DocumentMetadata = { sourceFormat: "docx", title };
  try {
    const zip = unzipSync(bytes);
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
