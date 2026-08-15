/**
 * The export pipeline: turn the source PDF plus the editing state into real
 * PDF bytes.
 *
 * Order matters, and it is the order Acrobat uses:
 *
 *   decrypt → reorganise pages → rewrite content (text, images, redaction)
 *   → crop/rotate → markup → form fields → page marks → outline & metadata
 *   → sanitise → optimise → protect
 *
 * Content rewriting happens *before* markup so a redaction can delete the very
 * text a highlight sits on without the highlight losing its place, and markup
 * happens before form fields so flattening a form does not swallow comments.
 */

import { PDFDocument, PDFName } from "pdf-lib";
import type { PDFPage, PDFRef } from "pdf-lib";
import type { Rect } from "../core/coords";
import type { Annot, Page, PdfState } from "../model/types";
import { pageFrame, flattenAnnots, mustFlatten, writeAnnots } from "./annots-pdf";
import type { PaintContext } from "./annots-pdf";
import { applyBand, applyBatesStamp, applyWatermark, batesLabel } from "./decorate";
import { FontBook } from "./fonts";
import { createFields, fillForm, flattenForm } from "./forms";
import { ImageBank } from "./images";
import { PAGE_SIZES, cropPage, rotatePage, writeOutline, writePageLabels } from "./organize";
import type { OutlineEntry } from "./organize";
import { applyRedactions, sanitiseDocument } from "./redact";
import { protectDocument } from "./security";
import type { ProtectOptions } from "./security";
import { applyImageEdits, applyTextEdits } from "./textedit";

export interface BuildOptions {
  /** Keep markup as real, re-editable PDF annotations (Acrobat-compatible). */
  interactiveAnnots: boolean;
  /** Bake form fields into static content. */
  flattenForms: boolean;
  /** Perform pending redactions destructively. */
  applyRedactions: boolean;
  /** Strip metadata, JavaScript, attachments and automatic actions. */
  sanitise: boolean;
  /** Recompress and downsample to reduce the file size. */
  optimise: boolean;
  /** Password-protect the result. */
  protect?: ProtectOptions;
  author: string;
  fileName: string;
  onProgress?: (label: string, ratio: number) => void;
}

export const DEFAULT_BUILD: BuildOptions = {
  interactiveAnnots: true,
  flattenForms: false,
  applyRedactions: true,
  sanitise: false,
  optimise: false,
  author: "Elium",
  fileName: "document.pdf",
};

export interface BuildReport {
  pages: number;
  annotsWritten: number;
  annotsFlattened: number;
  redactedGlyphs: number;
  redactedImages: number;
  textBlocksNative: number;
  textBlocksSubstituted: number;
  textBlocksSkipped: number;
  fieldsCreated: number;
  fieldsFilled: number;
  bytes: number;
  warnings: string[];
}

/** Build the output PDF. `sourceBytes` must already be decrypted. */
export async function buildPdf(
  sourceBytes: Uint8Array,
  state: PdfState,
  options: Partial<BuildOptions> = {},
): Promise<{ bytes: Uint8Array; report: BuildReport }> {
  const opts: BuildOptions = { ...DEFAULT_BUILD, ...options };
  const report: BuildReport = {
    pages: 0,
    annotsWritten: 0,
    annotsFlattened: 0,
    redactedGlyphs: 0,
    redactedImages: 0,
    textBlocksNative: 0,
    textBlocksSubstituted: 0,
    textBlocksSkipped: 0,
    fieldsCreated: 0,
    fieldsFilled: 0,
    bytes: 0,
    warnings: [],
  };
  const step = (label: string, ratio: number) => opts.onProgress?.(label, ratio);

  step("Ouverture du document", 0.02);
  const doc = await PDFDocument.load(sourceBytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });

  // --- 1. page order -------------------------------------------------------
  step("Organisation des pages", 0.08);
  const wanted = state.pages.filter((p) => !p.skipped);
  const source = doc.getPages();
  const targets: { page: PDFPage; model: Page }[] = [];
  const seen = new Set<number>();

  for (const model of wanted) {
    if (model.from == null) {
      const size = model.size ?? { w: PAGE_SIZES.A4[0], h: PAGE_SIZES.A4[1] };
      const created = doc.addPage([size.w, size.h]);
      targets.push({ page: created, model });
      continue;
    }
    const src = source[model.from];
    if (!src) continue;
    if (!seen.has(model.from)) {
      seen.add(model.from);
      targets.push({ page: src, model });
    } else {
      const [copy] = await doc.copyPages(doc, [model.from]);
      doc.addPage(copy);
      targets.push({ page: copy, model });
    }
  }

  if (!targets.length) {
    doc.addPage(PAGE_SIZES.A4);
    report.warnings.push("Aucune page à exporter : une page blanche a été produite.");
  } else {
    // Rebuild the page tree in the requested order.
    for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
    for (const t of targets) doc.addPage(t.page);
  }
  report.pages = doc.getPageCount();

  const fonts = new FontBook(doc);
  const images = new ImageBank(doc);
  const byPageId = new Map<string, { page: PDFPage; index: number }>();
  targets.forEach((t, i) => byPageId.set(t.model.id, { page: t.page, index: i }));

  // Background pictures for pages the user inserted from an image.
  for (const t of targets) {
    if (t.model.from != null || !t.model.image) continue;
    const img = await images.get(t.model.image);
    if (!img) continue;
    const { width, height } = t.page.getSize();
    const scale = Math.min(width / img.width, height / img.height);
    t.page.drawImage(img, {
      x: (width - img.width * scale) / 2,
      y: (height - img.height * scale) / 2,
      width: img.width * scale,
      height: img.height * scale,
    });
  }

  // --- 2. rewrite the page's own content ------------------------------------
  step("Application des modifications de contenu", 0.2);
  for (const { page, model } of targets) {
    const frame = pageFrame(page);

    const edits = state.contentEdits.filter((e) => e.pageId === model.id);
    if (edits.length) {
      try {
        const r = await applyTextEdits(doc, page, edits, frame, fonts);
        report.textBlocksNative += r.native;
        report.textBlocksSubstituted += r.substituted;
        report.textBlocksSkipped += r.skipped;
      } catch {
        report.warnings.push(`Modification de texte impossible sur une page (${model.id.slice(0, 6)}).`);
      }
    }

    const imgEdits = state.imageEdits.filter((e) => e.pageId === model.id);
    if (imgEdits.length) {
      try {
        await applyImageEdits(doc, page, imgEdits, async (src) => {
          const embedded = await images.get(src);
          return embedded ? { ref: embedded.ref } : null;
        });
      } catch {
        report.warnings.push("Remplacement d'image impossible sur une page.");
      }
    }

    if (opts.applyRedactions) {
      const marks = state.annots.filter((a) => a.pageId === model.id && a.kind === "redact");
      if (marks.length) {
        const rects: Rect[] = marks.map((a) => frame.rectToPdf(a.rect));
        try {
          const r = await applyRedactions(doc, page, rects);
          report.redactedGlyphs += r.glyphsRemoved;
          report.redactedImages += r.imagesRemoved;
        } catch {
          report.warnings.push("Caviardage partiel : le contenu d'une page n'a pas pu être réécrit.");
        }
      }
    }
  }

  // --- 3. crop and rotate ---------------------------------------------------
  for (const { page, model } of targets) {
    if (model.crop) cropPage(page, model.crop);
    if (model.rotate) rotatePage(page, model.rotate);
  }

  // The markup the model imported from the source is about to be written back
  // from the model — remove the originals so nothing is duplicated.
  if (state.importedAnnots) {
    const { stripImportedAnnots } = await import("./import-annots");
    for (const { page } of targets) {
      try {
        await stripImportedAnnots(page);
      } catch {
        /* leave them rather than break the page */
      }
    }
  }

  // --- 4. markup ------------------------------------------------------------
  step("Écriture des annotations", 0.45);
  const pageRefs: PDFRef[] = doc.getPages().map((p) => p.ref);
  for (const { page, model } of targets) {
    const frame = pageFrame(page);
    const ctx: PaintContext = { doc, frame, fonts, images, measureScale: state.measureScale };
    const mine = state.annots.filter((a) => a.pageId === model.id && !(a.kind === "redact" && !opts.applyRedactions));

    if (!mine.length) continue;
    let toFlatten: Annot[];
    if (opts.interactiveAnnots) {
      toFlatten = await writeAnnots(page, mine, ctx, { defaultAuthor: opts.author, pageRefs });
      report.annotsWritten += mine.length - toFlatten.length;
    } else {
      toFlatten = mine.slice();
    }
    if (toFlatten.length) {
      await flattenAnnots(page, toFlatten, ctx);
      report.annotsFlattened += toFlatten.length;
    }
  }
  // Redaction marks that were applied must not survive as visible annotations.
  if (opts.applyRedactions) {
    report.annotsFlattened +=
      state.annots.filter((a) => a.kind === "redact").length -
      state.annots.filter((a) => a.kind === "redact" && mustFlatten(a.kind)).length;
  }

  // --- 5. forms -------------------------------------------------------------
  step("Champs de formulaire", 0.6);
  if (state.createdFields.length) {
    try {
      const { font } = await fonts.standard();
      report.fieldsCreated = createFields({ doc, font }, state.createdFields, (pageId) => {
        const hit = byPageId.get(pageId);
        return hit ? { page: hit.page, height: hit.page.getCropBox().height } : null;
      });
    } catch {
      report.warnings.push("Certains champs de formulaire n'ont pas pu être créés.");
    }
  }
  if (Object.keys(state.formValues).length) {
    const { font } = await fonts.standard();
    report.fieldsFilled = fillForm(doc, state.formValues, font).filled;
  }
  if (opts.flattenForms) {
    if (!flattenForm(doc)) report.warnings.push("Aplatissement du formulaire impossible.");
  }

  // --- 6. page marks --------------------------------------------------------
  step("Filigrane et en-têtes", 0.72);
  const decorateCtx = {
    doc,
    fonts,
    images,
    tokens: {
      title: state.metadata.title ?? opts.fileName.replace(/\.pdf$/i, ""),
      author: state.metadata.author ?? opts.author,
      filename: opts.fileName,
      total: targets.length,
    },
  };
  for (let i = 0; i < targets.length; i++) {
    const { page } = targets[i];
    const frame = pageFrame(page);
    const bates = state.bates.enabled ? batesLabel(state.bates, i) : undefined;
    await applyWatermark(page, frame, state.watermark, decorateCtx, i, targets.length);
    await applyBand(page, frame, state.header, true, decorateCtx, i, targets.length, bates);
    await applyBand(page, frame, state.footer, false, decorateCtx, i, targets.length, bates);
    if (state.bates.enabled && !state.footer.enabled && !state.header.enabled && bates) {
      await applyBatesStamp(page, frame, state.bates, bates, decorateCtx);
    }
  }

  // --- 7. outline, labels, metadata ----------------------------------------
  step("Signets et métadonnées", 0.84);
  if (state.bookmarks?.length) {
    try {
      writeOutline(doc, toOutlineEntries(state.bookmarks, targets.length));
    } catch {
      report.warnings.push("Les signets n'ont pas pu être écrits.");
    }
  }
  if (state.pages.some((p) => p.label)) {
    try {
      writePageLabels(
        doc,
        targets.map((t) => t.model.label),
      );
    } catch {
      /* labels are cosmetic */
    }
  }

  const meta = state.metadata;
  try {
    if (meta.title !== undefined) doc.setTitle(meta.title ?? "");
    if (meta.author !== undefined) doc.setAuthor(meta.author ?? "");
    if (meta.subject !== undefined) doc.setSubject(meta.subject ?? "");
    if (meta.keywords !== undefined) doc.setKeywords(meta.keywords ? meta.keywords.split(/[,;]\s*/) : []);
    if (meta.language) doc.setLanguage(meta.language);
    doc.setProducer("Elium PDF");
    doc.setCreator(meta.creator ?? "Elium");
    doc.setModificationDate(new Date());
  } catch {
    /* metadata is best-effort */
  }

  if (opts.sanitise) {
    const { removed } = sanitiseDocument(doc);
    if (removed.length) report.warnings.push(`Assaini : ${removed.join(", ")}.`);
  }

  // --- 8. serialise ---------------------------------------------------------
  step("Écriture du fichier", 0.92);
  if (opts.optimise) {
    const { optimiseDocument } = await import("./optimize");
    try {
      await optimiseDocument(doc);
    } catch {
      report.warnings.push("Optimisation ignorée (contenu non compressible).");
    }
  }

  let bytes: Uint8Array;
  if (opts.protect?.userPassword || opts.protect?.ownerPassword) {
    step("Chiffrement", 0.96);
    bytes = await protectDocument(doc, opts.protect);
  } else {
    bytes = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
  }
  report.bytes = bytes.length;
  step("Terminé", 1);
  return { bytes, report };
}

function toOutlineEntries(
  nodes: readonly {
    title: string;
    page: number;
    y?: number;
    bold?: boolean;
    italic?: boolean;
    color?: string;
    closed?: boolean;
    children: readonly unknown[];
  }[],
  pageCount: number,
): OutlineEntry[] {
  const hex = (c?: string) => {
    if (!c) return undefined;
    const h = c.replace("#", "");
    if (h.length !== 6) return undefined;
    const n = parseInt(h, 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  };
  return nodes.map((n) => ({
    title: n.title,
    page: Math.max(0, Math.min(pageCount - 1, (n.page || 1) - 1)),
    y: n.y,
    bold: n.bold,
    italic: n.italic,
    color: hex(n.color),
    closed: n.closed,
    children: toOutlineEntries(n.children as never, pageCount),
  }));
}

/**
 * A quick, faithful "print-ready" flatten: everything baked, no interactive
 * anything. Used by the Print command and by "Save a flattened copy".
 */
export async function buildFlattened(
  sourceBytes: Uint8Array,
  state: PdfState,
  fileName: string,
  author: string,
): Promise<Uint8Array> {
  const { bytes } = await buildPdf(sourceBytes, state, {
    interactiveAnnots: false,
    flattenForms: true,
    applyRedactions: true,
    fileName,
    author,
  });
  return bytes;
}

export { PDFName };
