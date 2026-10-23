/**
 * Ingestion PDF — texte (pdf.js, via `PdfEngine` + `pdf/core/text.ts`) et
 * images JPEG intégrées (pdf-lib, lecture bas niveau des XObjects) pour le
 * Détecteur.
 *
 * Le texte : `PdfEngine.open` lève `PdfPasswordRequired` si le PDF est
 * protégé — laissée non interceptée ici, l'appelant sait déjà proposer une
 * invite de mot de passe (voir `pdf/core/engine.ts`). `engine.info` donne
 * quasi gratuitement les métadonnées (créateur/producteur/dates/pages) : pas
 * besoin de reparser le PDF pour ça. Chaque page passe par
 * `buildRuns`/`groupLines`/`groupBlocks` (mêmes fonctions que l'export Word
 * du module PDF, voir `pdf/ops/export.ts`) pour obtenir des blocs
 * paragraphe-like avec gras/italique/taille déjà agrégés.
 *
 * Les images : seuls les XObjects Image dont le filtre inclut DCTDecode
 * (JPEG) sont extraits — le flux brut d'un DCTDecode EST le JPEG original
 * octet pour octet (PDF ne fait qu'y coller les données déjà compressées),
 * ce qui préserve les octets EXIF d'origine. C'est précisément ce qui compte
 * ici : un autre filtre (JPXDecode, CCITTFaxDecode…) perdrait cette
 * préservation de toute façon. Ces images ignorées (typiquement un PNG collé
 * dans le PDF) ne sont PAS passées sous silence pour autant : leur nombre est
 * compté (`ImageExtractionResult.skippedNonJpeg`, avant tout filtrage) et
 * remonté dans `DocumentMetadata.skippedNonJpegImages`, pour qu'un
 * avertissement explicite s'affiche dans le panneau Images plutôt que de
 * laisser croire que ces images ont été vérifiées. Best effort : une image
 * individuelle qui ne s'extrait pas proprement est sautée, jamais fatale pour
 * le reste du document.
 *
 * `PDFDocument.load` (pdf-lib) fait un parsing JS pur, complet et synchrone
 * de tout l'objet PDF — sur un document réel volumineux/complexe, mesuré en
 * pratique à largement plus de 30s dans certains environnements (contre
 * <1s pour l'extraction de texte pdf.js du même fichier), sans qu'aucune
 * page individuelle ne soit en cause. C'est un budget de temps, pas une
 * fonctionnalité : `IMAGE_EXTRACTION_TIMEOUT_MS` borne l'attente pour que
 * l'analyse ne reste jamais bloquée indéfiniment sur cette seule étape —
 * au pire on perd les signaux image, jamais l'analyse entière.
 */
import { PdfEngine } from "../../pdf/core/engine";
import { buildRuns, groupBlocks, groupLines } from "../../pdf/core/text";
import type { TextBlock } from "../../pdf/core/text";
import type { DocumentMetadata, ImageModel, ParagraphModel, RunFormat } from "../types";
import { runWorkerTask } from "../../workers/worker-task";
import { extractPdfImages, type PdfImagesRequest } from "./pdfImages";

export interface PdfIngestResult {
  paragraphs: ParagraphModel[];
  images: ImageModel[];
  metadata: Partial<DocumentMetadata>;
}

export async function documentModelFromPdf(bytes: Uint8Array, password?: string): Promise<PdfIngestResult> {
  const engine = await PdfEngine.open(bytes, password);
  try {
    const paragraphs = await extractParagraphs(engine);
    const { images, skippedNonJpeg } = await extractImages(bytes, engine.pageCount);
    const metadata = metadataFromEngine(engine);
    if (skippedNonJpeg > 0) metadata.skippedNonJpegImages = skippedNonJpeg;
    return { paragraphs, images, metadata };
  } finally {
    engine.destroy();
  }
}

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

async function extractParagraphs(engine: PdfEngine): Promise<ParagraphModel[]> {
  const paragraphs: ParagraphModel[] = [];
  for (let i = 0; i < engine.pageCount; i++) {
    const page = await engine.page(i);
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    const textContent = await engine.text(i);
    const runs = buildRuns(textContent, viewport.transform as unknown as number[]);
    const lines = groupLines(runs, textContent.items);
    for (const block of groupBlocks(lines)) {
      if (!block.text.trim()) continue;
      paragraphs.push({
        index: paragraphs.length,
        text: block.text,
        runs: [runFormatFromBlock(block)],
        pageIndex: i,
      });
    }
  }
  return paragraphs;
}

function runFormatFromBlock(block: TextBlock): RunFormat {
  const run: RunFormat = { text: block.text };
  if (block.bold) run.bold = true;
  if (block.italic) run.italic = true;
  if (block.fontFamily) run.fontFamily = block.fontFamily;
  // pdf.js reports font size in PDF user-space units, i.e. points already —
  // no px→pt conversion needed here (unlike the ProseMirror ingest path).
  if (Number.isFinite(block.fontSize) && block.fontSize > 0) run.fontSize = Math.round(block.fontSize * 100) / 100;
  return run;
}

function metadataFromEngine(engine: PdfEngine): Partial<DocumentMetadata> {
  const info = engine.info;
  const metadata: Partial<DocumentMetadata> = { sourceFormat: "pdf", pageCount: engine.pageCount };
  if (info.title) metadata.title = info.title;
  if (info.author) metadata.author = info.author;
  if (info.creator) metadata.creator = info.creator;
  if (info.producer) metadata.producer = info.producer;
  const createdAt = parsePdfInfoDate(info.creationDate);
  if (createdAt) metadata.createdAt = createdAt;
  const modifiedAt = parsePdfInfoDate(info.modDate);
  if (modifiedAt) metadata.modifiedAt = modifiedAt;
  return metadata;
}

/** `D:YYYYMMDDHHmmSS…` → ISO. Unlike other PDF-date readers in this codebase
 *  this returns `undefined` (not the epoch) on failure — DocumentMetadata's
 *  date fields are optional, and a fabricated 1970 date would itself read as
 *  a (false) anomaly to `metadataSignals.ts`. */
function parsePdfInfoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw.trim());
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const [, y, mo = "01", da = "01", h = "00", mi = "00", s = "00"] = m;
  const d = new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ---------------------------------------------------------------------------
// Images (JPEG / DCTDecode uniquement)
// ---------------------------------------------------------------------------

export const IMAGE_EXTRACTION_TIMEOUT_MS = 10_000;

/** Résout avec `promise`, ou rejette après `ms` — `promise` elle-même continue
 *  en arrière-plan (pdf-lib n'offre pas d'annulation) mais son résultat est
 *  alors ignoré : on n'attend juste plus après elle. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Délai dépassé (${ms}ms)`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface ImageExtractionResult {
  images: ImageModel[];
  skippedNonJpeg: number;
}

async function extractImages(bytes: Uint8Array, pageCount: number): Promise<ImageExtractionResult> {
  // Le PDF est analysé dans un Worker : `PDFDocument.load` est synchrone et ne peut pas être interrompu
  // sur le fil principal ; ici le délai TERMINE le Worker (le rapport se fait alors sans signaux image).
  const copy = bytes.slice();
  try {
    return await runWorkerTask<PdfImagesRequest, ImageExtractionResult>({
      create: () => new Worker(new URL("./pdf-images.worker.ts", import.meta.url), { type: "module" }),
      request: { bytes: copy, pageCount },
      transfer: [copy.buffer],
      inline: (r) => withTimeout(extractPdfImages(bytes, r.pageCount), IMAGE_EXTRACTION_TIMEOUT_MS),
      timeoutMs: IMAGE_EXTRACTION_TIMEOUT_MS,
    });
  } catch {
    return { images: [], skippedNonJpeg: 0 };
  }
}
