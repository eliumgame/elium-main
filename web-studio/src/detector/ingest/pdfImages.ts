/**
 * Extraction des images JPEG (DCTDecode) d'un PDF avec pdf-lib — sans DOM ni pdf.js, donc exécutable
 * dans un Worker terminable (voir pdf-images.worker.ts) : un PDF qui rend `PDFDocument.load` très long
 * ne fige plus l'interface et peut être abandonné pour de bon.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import type { ImageModel } from "../types";

export interface PdfImagesRequest {
  bytes: Uint8Array;
  pageCount: number;
}

export interface ImageExtractionResult {
  images: ImageModel[];
  /** Compté avant tout filtrage sur le flux DCTDecode — cf. constat détecteur
   *  sur les images non-JPEG collées dans un PDF (PNG, etc.) jamais soumises
   *  à la vérification C2PA/EXIF, jusqu'ici sans aucun avertissement. */
  skippedNonJpeg: number;
}

export async function extractPdfImages(bytes: Uint8Array, pageCount: number): Promise<ImageExtractionResult> {
  const images: ImageModel[] = [];
  let skippedNonJpeg = 0;
  let doc: PDFDocument;
  try {
    // ignoreEncryption: un PDF chiffré n'est de toute façon pas exploitable
    // par pdf-lib (il ne déchiffre pas les flux) — sans cette option `load`
    // lèverait avant même qu'on ait la chance de le constater nous-mêmes et
    // de simplement renvoyer une liste d'images vide. Le timeout couvre le cas
    // (mesuré sur un document réel) où ce parsing devient disproportionnellement
    // lent — mieux vaut un rapport sans signaux image qu'une analyse qui ne
    // se termine jamais.
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return { images, skippedNonJpeg };
  }
  const pages = Math.min(pageCount, doc.getPageCount());
  for (let i = 0; i < pages; i++) {
    try {
      skippedNonJpeg += extractPageImages(doc, i, images);
    } catch {
      // Page structurellement inexploitable (résolution de référence
      // cassée, etc.) : on saute ses images, le reste du document continue.
    }
  }
  return { images, skippedNonJpeg };
}

/** Renvoie le nombre d'XObjects Image rencontrés sur cette page dont le
 *  filtre n'est pas DCTDecode (donc ignorés) — voir `ImageExtractionResult`. */
function extractPageImages(doc: PDFDocument, pageIndex: number, images: ImageModel[]): number {
  let skippedNonJpeg = 0;
  const page = doc.getPage(pageIndex);
  const xobjects = page.node.Resources()?.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return skippedNonJpeg;
  for (const name of xobjects.keys()) {
    try {
      const stream = xobjects.lookup(name);
      if (!(stream instanceof PDFRawStream)) continue;
      const dict = stream.dict;
      const subtype = dict.lookup(PDFName.of("Subtype"));
      if (!(subtype instanceof PDFName) || subtype.asString().replace(/^\//, "") !== "Image") continue;
      if (!isDctEncoded(dict)) {
        skippedNonJpeg++;
        continue;
      }
      const jpegBytes = stream.getContents(); // raw, undecoded — the JPEG itself
      if (!jpegBytes.length) continue;
      const image: ImageModel = { index: images.length, bytes: jpegBytes, mime: "image/jpeg", pageIndex };
      const width = numberAttr(dict, "Width");
      const height = numberAttr(dict, "Height");
      if (width != null) image.width = width;
      if (height != null) image.height = height;
      images.push(image);
    } catch {
      // Un XObject individuel mal formé ne doit pas priver le reste de la
      // page de ses images.
    }
  }
  return skippedNonJpeg;
}

function isDctEncoded(dict: PDFDict): boolean {
  const filter = dict.lookup(PDFName.of("Filter"));
  if (filter instanceof PDFName) return filter.asString().replace(/^\//, "") === "DCTDecode";
  if (filter instanceof PDFArray) {
    return filter.asArray().some((f) => f instanceof PDFName && f.asString().replace(/^\//, "") === "DCTDecode");
  }
  return false;
}

function numberAttr(dict: PDFDict, key: string): number | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}
