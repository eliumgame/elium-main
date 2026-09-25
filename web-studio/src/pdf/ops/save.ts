/**
 * The save pipeline: turn the source PDF plus the editing state into real
 * PDF bytes.
 *
 * Order matters, and it is the order Acrobat uses:
 *
 *   decrypt → reorganise pages → rewrite content (text, images, redaction)
 *   → crop/rotate → markup → form fields → page marks → outline & metadata
 *   → sanitise → write (incremental update, or full rewrite + optimise/protect)
 *
 * Content rewriting happens *before* markup so a redaction can delete the very
 * text a highlight sits on without the highlight losing its place, and markup
 * happens before form fields so flattening a form does not swallow comments.
 *
 * Writing, like Acrobat's « Enregistrer », is INCREMENTAL by default
 * (`ops/incremental.ts`): only what changed is appended, the original bytes —
 * and therefore digital signatures, tags, XMP, everything we do not model —
 * stay intact, and a protected file keeps its protection (new objects are
 * encrypted with the file's own key). A FULL rewrite happens only when it is
 * required: applying redactions or removing pages (earlier revisions would
 * still hold what was removed), changing the password, optimising or
 * sanitising, or when the file's own structure is too broken to append to.
 */

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFPage, PDFRef, PDFString } from "pdf-lib";
import type { PDFObject } from "pdf-lib";
import type { Rect } from "../core/coords";
import type { Annot, Bookmark, Page, PdfState } from "../model/types";
import { pageFrame, flattenAnnots, mustFlatten, writeAnnots } from "./annots-pdf";
import type { PaintContext } from "./annots-pdf";
import { applyBand, applyBatesStamp, applyWatermark, batesLabel } from "./decorate";
import { FontBook } from "./fonts";
import { createFields, fillForm, flattenForm } from "./forms";
import { ImageBank } from "./images";
import {
  fingerprint,
  pruneUnreachable,
  readXrefTail,
  trailerId0,
  writeIncrementalUpdate,
  type Fingerprints,
  type XrefTail,
} from "./incremental";
import { PAGE_SIZES, cropPage, rotatePage, writeOutline, writePageLabels } from "./organize";
import type { OutlineEntry } from "./organize";
import { applyRedactions, sanitiseDocument } from "./redact";
import { createCrypt, openCrypt, writeEncrypted } from "./security";
import type { PdfCrypt, ProtectOptions } from "./security";
import { applyImageEdits, applyTextEdits } from "./textedit";
import { syncXmp, type XmpChanges } from "./xmp";

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
  /** Password-protect the result (new protection → full rewrite). */
  protect?: ProtectOptions;
  author: string;
  fileName: string;
  onProgress?: (label: string, ratio: number) => void;
  /** Password the source opens with (user or owner; "" or null for files that open freely). */
  password?: string | null;
  /** When the source is protected: keep that protection in the output (default) or drop it. */
  encryption?: "keep" | "remove";
  /**
   * Imported annotations still identical (same object) to what was read from
   * the file: they are left in the file byte for byte instead of being
   * rewritten from the model.
   */
  pristineAnnots?: ReadonlySet<Annot>;
  /** The bookmarks as read from the file: while `state.bookmarks` is this very array, the outline is left alone. */
  pristineBookmarks?: readonly Bookmark[] | null;
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
  /** Imported annotations left untouched in the file. */
  annotsKept: number;
  redactedGlyphs: number;
  redactedImages: number;
  textBlocksNative: number;
  textBlocksSubstituted: number;
  textBlocksSkipped: number;
  fieldsCreated: number;
  fieldsFilled: number;
  bytes: number;
  /** How the file was written. */
  mode: "incremental" | "full";
  /** Why a full rewrite was needed (empty for an incremental save). */
  fullReasons: string[];
  /** Objects written (incremental: the changed ones). */
  objectsWritten: number;
  /** Bytes appended by an incremental save. */
  bytesAdded: number;
  /** What happened to the file's password protection. */
  encryption: "none" | "kept" | "added" | "changed" | "removed";
  /** Scheme of the protection of the written file ("AES-256"…). */
  scheme?: string;
  durationMs: number;
  /** Informative notes (substituted fonts, kept protection…). */
  warnings: string[];
  /**
   * Edits the screen shows that could NOT be carried into the file. Never
   * report a plain success while this is non-empty.
   */
  lost: string[];
}

function emptyReport(): BuildReport {
  return {
    pages: 0,
    annotsWritten: 0,
    annotsFlattened: 0,
    annotsKept: 0,
    redactedGlyphs: 0,
    redactedImages: 0,
    textBlocksNative: 0,
    textBlocksSubstituted: 0,
    textBlocksSkipped: 0,
    fieldsCreated: 0,
    fieldsFilled: 0,
    bytes: 0,
    mode: "full",
    fullReasons: [],
    objectsWritten: 0,
    bytesAdded: 0,
    encryption: "none",
    durationMs: 0,
    warnings: [],
    lost: [],
  };
}

// ---------------------------------------------------------------------------
// The destination file
// ---------------------------------------------------------------------------

/**
 * What the destination file holds now — everything an incremental save needs
 * to append to it: its bytes, where its last cross-reference section is, its
 * security handler, and the plaintext serialisation of its objects (to tell
 * what changed). Returned by every save for the next one.
 */
export interface DiskState {
  bytes: Uint8Array;
  /** Null when the file's tail is unusable: the next save must be a full rewrite. */
  tail: XrefTail | null;
  crypt: PdfCrypt | null;
  encryptRef: PDFRef | null;
  id0: Uint8Array | null;
  fingerprints: Fingerprints;
  /**
   * First object number new objects may take. Fixed for a session (so the
   * objects an earlier save created keep their numbers and are not rewritten
   * when unchanged), moved up only by a full rewrite.
   */
  floor: number;
}

interface Working {
  doc: PDFDocument;
  crypt: PdfCrypt | null;
  encryptRef: PDFRef | null;
}

/** Load bytes for editing: parsed, decrypted in place, `/Encrypt` detached. */
async function openWorking(bytes: Uint8Array, password: string | null | undefined): Promise<Working> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const crypt = openCrypt(doc, password ?? "");
  const ref = doc.context.trailerInfo.Encrypt;
  const encryptRef = ref instanceof PDFRef ? ref : null;
  if (crypt) {
    await crypt.decryptDocument(doc);
    // The working copy is plaintext; the writer adds the target protection.
    if (encryptRef) doc.context.delete(encryptRef);
    doc.context.trailerInfo.Encrypt = undefined;
  }
  return { doc, crypt, encryptRef };
}

function diskFromWorking(bytes: Uint8Array, w: Working): DiskState {
  const tail = readXrefTail(bytes);
  return {
    bytes,
    tail,
    crypt: w.crypt,
    encryptRef: w.encryptRef,
    id0: trailerId0(w.doc),
    fingerprints: fingerprint(w.doc),
    floor: Math.max(tail?.size ?? 0, w.doc.context.largestObjectNumber + 1),
  };
}

/** Describe a file on disk (parses and decrypts it once). */
export async function readDiskState(bytes: Uint8Array, password?: string | null): Promise<DiskState> {
  return diskFromWorking(bytes, await openWorking(bytes, password));
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export type SecurityChange = { protect: ProtectOptions } | "remove";

export interface SaveInput {
  /** The bytes the editing state refers to — the file as it was opened. */
  source: Uint8Array;
  /**
   * Bytes to build on instead of `source`: the output of pdf.js
   * `pdfDocument.saveDocument()` (the source plus pdf.js's own update — form
   * values from the annotationStorage). The Elium model is applied on top and
   * everything lands in ONE update of the destination file.
   */
  base?: Uint8Array;
  /** The destination as it is now. Omitted: the destination still holds `source` (first save). */
  disk?: DiskState | null;
  state: PdfState;
  options?: Partial<BuildOptions>;
  /** "auto": incremental unless something requires a full rewrite. */
  mode?: "auto" | "incremental" | "full";
  /** Change of protection (forces a full rewrite). */
  security?: SecurityChange | null;
}

export interface SaveResult {
  bytes: Uint8Array;
  report: BuildReport;
  /** The destination after this save — pass it to the next save. */
  disk: DiskState;
}

/** Why the state cannot be written as an incremental update (empty = it can). */
export function fullRewriteReasons(
  state: PdfState,
  opts: Pick<BuildOptions, "applyRedactions" | "optimise" | "sanitise" | "flattenForms">,
  sourcePageCount: number,
  security?: SecurityChange | null,
): string[] {
  const reasons: string[] = [];
  if (security === "remove") reasons.push("retrait de la protection par mot de passe");
  else if (security) reasons.push("nouvelle protection par mot de passe");
  if (opts.applyRedactions && state.annots.some((a) => a.kind === "redact")) {
    reasons.push("caviardage : le contenu masqué est retiré définitivement, révisions précédentes comprises");
  }
  const used = new Set(state.pages.filter((p) => !p.skipped && p.from != null).map((p) => p.from));
  let removed = 0;
  for (let i = 0; i < sourcePageCount; i++) if (!used.has(i)) removed++;
  if (removed) reasons.push(`${removed} page(s) supprimée(s) : retirées définitivement du fichier`);
  if (opts.optimise) reasons.push("optimisation de la taille");
  if (opts.sanitise) reasons.push("assainissement");
  if (opts.flattenForms) reasons.push("aplatissement du formulaire");
  return reasons;
}

/**
 * Save the document. Incremental when possible (see the file header), full
 * rewrite otherwise; the report says which and why.
 */
export async function savePdf(input: SaveInput): Promise<SaveResult> {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const opts: BuildOptions = { ...DEFAULT_BUILD, ...(input.options ?? {}) };
  const report = emptyReport();
  const step = (label: string, ratio: number) => opts.onProgress?.(label, ratio);
  const state = input.state;

  step("Ouverture du document", 0.02);
  const buildBytes = input.base ?? input.source;
  const work = await openWorking(buildBytes, opts.password);
  const { doc } = work;
  const sourcePageCount = doc.getPageCount();

  // The destination: given, or — first save — the source itself.
  let disk = input.disk ?? null;
  if (!disk) {
    disk =
      buildBytes === input.source
        ? diskFromWorking(input.source, work)
        : await readDiskState(input.source, opts.password);
  }
  // New objects are numbered past everything the destination (and the build
  // base) already uses: object-stream containers and xref streams are not in
  // pdf-lib's context, so its own counter can be too low.
  const baseTail = input.base ? readXrefTail(input.base) : null;
  doc.context.largestObjectNumber = Math.max(
    doc.context.largestObjectNumber,
    disk.floor - 1,
    (baseTail?.size ?? 0) - 1,
  );

  const security =
    input.security ?? (opts.protect?.userPassword || opts.protect?.ownerPassword ? { protect: opts.protect } : null);
  const reasons = fullRewriteReasons(state, opts, sourcePageCount, security);
  if (!disk.tail) reasons.push("structure du fichier d'origine irrégulière : fichier réparé");
  if (opts.encryption === "remove" && disk.crypt) reasons.push("copie sans protection");
  if (input.mode === "full" && !reasons.length) reasons.push("réécriture complète demandée");
  const full = input.mode === "full" || reasons.length > 0;

  await applyState(doc, state, opts, report);

  step("Écriture du fichier", 0.92);
  await doc.flush();
  let bytes: Uint8Array;
  let next: DiskState;

  if (!full) {
    const res = writeIncrementalUpdate({
      disk: disk.bytes,
      tail: disk.tail!,
      doc,
      before: disk.fingerprints,
      crypt: disk.crypt,
      encryptRef: disk.encryptRef,
      id0: disk.id0,
    });
    bytes = res.bytes;
    report.mode = "incremental";
    report.objectsWritten = res.written;
    report.bytesAdded = res.added;
    report.encryption = disk.crypt ? "kept" : "none";
    report.scheme = disk.crypt?.scheme;
    next = { ...disk, bytes: res.bytes, tail: res.tail, fingerprints: res.after };
  } else {
    report.mode = "full";
    report.fullReasons = reasons;
    if (opts.optimise) {
      step("Optimisation", 0.94);
      const { optimiseDocument } = await import("./optimize");
      try {
        await optimiseDocument(doc);
      } catch {
        report.warnings.push("Optimisation ignorée (contenu non compressible).");
      }
    }
    pruneUnreachable(doc);
    // Target protection: a new one, none, or the destination's current one.
    let crypt: PdfCrypt | null;
    if (security === "remove" || opts.encryption === "remove") crypt = null;
    else if (security) crypt = createCrypt(security.protect);
    else crypt = disk.crypt;
    report.encryption = !crypt
      ? disk.crypt
        ? "removed"
        : "none"
      : crypt === disk.crypt
        ? "kept"
        : disk.crypt
          ? "changed"
          : "added";
    report.scheme = crypt?.scheme;
    const prints = fingerprint(doc);
    let encryptRef: PDFRef | null = null;
    let id0: Uint8Array | null;
    if (crypt) {
      step("Chiffrement", 0.96);
      bytes = await writeEncrypted(doc, crypt);
      encryptRef = (doc.context.trailerInfo.Encrypt as PDFRef | undefined) ?? null;
      id0 = crypt.id0;
    } else {
      id0 = trailerId0(doc) ?? randomBytes(16);
      doc.context.trailerInfo.ID = doc.context.obj([
        PDFHexString.of(toHex(id0)),
        PDFHexString.of(toHex(randomBytes(16))),
      ] as never);
      bytes = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
    }
    report.objectsWritten = prints.size;
    const tail = readXrefTail(bytes);
    next = {
      bytes,
      tail,
      crypt,
      encryptRef,
      id0,
      fingerprints: prints,
      floor: Math.max(tail?.size ?? 0, doc.context.largestObjectNumber + 1),
    };
  }

  report.bytes = bytes.length;
  report.durationMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
  step("Terminé", 1);
  return { bytes, report, disk: next };
}

/**
 * Build the output PDF as a complete new file (exports, print, extraction,
 * signing). `sourceBytes` may be protected: pass `options.password`; the
 * protection is kept unless `options.encryption` is "remove" or
 * `options.protect` sets a new one.
 */
export async function buildPdf(
  sourceBytes: Uint8Array,
  state: PdfState,
  options: Partial<BuildOptions> = {},
): Promise<{ bytes: Uint8Array; report: BuildReport }> {
  const { bytes, report } = await savePdf({ source: sourceBytes, state, options, mode: "full" });
  return { bytes, report };
}

// ---------------------------------------------------------------------------
// Applying the model
// ---------------------------------------------------------------------------

async function applyState(doc: PDFDocument, state: PdfState, opts: BuildOptions, report: BuildReport): Promise<void> {
  const step = (label: string, ratio: number) => opts.onProgress?.(label, ratio);

  // --- 1. page order -------------------------------------------------------
  step("Organisation des pages", 0.08);
  const wanted = state.pages.filter((p) => !p.skipped);
  const source = doc.getPages();
  const targets: { page: PDFPage; model: Page }[] = [];
  const seen = new Set<number>();

  for (const model of wanted) {
    if (model.from == null) {
      const size = model.size ?? { w: PAGE_SIZES.A4[0], h: PAGE_SIZES.A4[1] };
      const created = PDFPage.create(doc); // placed in the page tree below
      created.setSize(size.w, size.h);
      targets.push({ page: created, model });
      continue;
    }
    const src = source[model.from];
    if (!src) {
      report.lost.push(`Page introuvable dans le fichier source (n° ${model.from + 1}).`);
      continue;
    }
    if (!seen.has(model.from)) {
      seen.add(model.from);
      targets.push({ page: src, model });
    } else {
      const [copy] = await doc.copyPages(doc, [model.from]);
      targets.push({ page: copy, model });
    }
  }

  if (!targets.length) {
    const blank = PDFPage.create(doc);
    blank.setSize(PAGE_SIZES.A4[0], PAGE_SIZES.A4[1]);
    applyPageOrder(doc, [blank], source);
    report.warnings.push("Aucune page à exporter : une page blanche a été produite.");
  } else {
    applyPageOrder(
      doc,
      targets.map((t) => t.page),
      source,
    );
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
    if (!img) {
      report.lost.push("Image d'une page insérée illisible : la page est restée blanche.");
      continue;
    }
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
  for (const [index, { page, model }] of targets.entries()) {
    const frame = pageFrame(page);
    const where = `page ${index + 1}`;

    const edits = state.contentEdits.filter((e) => e.pageId === model.id);
    if (edits.length) {
      try {
        const r = await applyTextEdits(doc, page, edits, frame, fonts);
        report.textBlocksNative += r.native;
        report.textBlocksSubstituted += r.substituted;
        report.textBlocksSkipped += r.skipped;
        if (r.skipped) {
          report.lost.push(
            `${where} : ${r.skipped} paragraphe(s) modifié(s) à l'écran n'ont pas pu être réécrits dans le fichier (texte introuvable dans le flux de la page).`,
          );
        }
      } catch {
        report.lost.push(`${where} : modification de texte impossible (${edits.length} paragraphe(s)).`);
      }
    }

    const imgEdits = state.imageEdits.filter((e) => e.pageId === model.id);
    if (imgEdits.length) {
      try {
        const done = await applyImageEdits(doc, page, imgEdits, async (src) => {
          const embedded = await images.get(src);
          return embedded ? { ref: embedded.ref } : null;
        });
        if (typeof done === "number" && done < imgEdits.length) {
          report.lost.push(`${where} : ${imgEdits.length - done} modification(s) d'image non appliquée(s).`);
        }
      } catch {
        report.lost.push(`${where} : remplacement ou suppression d'image impossible.`);
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
          report.lost.push(`${where} : caviardage partiel, le contenu de la page n'a pas pu être réécrit.`);
        }
      }
    }
  }
  if (report.textBlocksSubstituted) {
    report.warnings.push(
      `${report.textBlocksSubstituted} paragraphe(s) réécrit(s) avec une police de substitution (police d'origine non réutilisable).`,
    );
  }

  // --- 3. crop and rotate ---------------------------------------------------
  for (const { page, model } of targets) {
    if (model.crop) cropPage(page, model.crop);
    if (model.rotate) rotatePage(page, model.rotate);
  }

  // The markup the model imported from the source is about to be written back
  // from the model — remove the originals so nothing is duplicated. Imported
  // annotations the user did not touch stay as they are in the file.
  const pristine = new Set(opts.pristineAnnots ? state.annots.filter((a) => opts.pristineAnnots!.has(a)) : []);
  if (state.importedAnnots) {
    const { stripImportedAnnots } = await import("./import-annots");
    for (const [index, { page, model }] of targets.entries()) {
      const keep = new Set<string>();
      for (const a of pristine) {
        if (a.pageId !== model.id) continue;
        const m = /^(\d+)R(\d*)$/.exec(a.id);
        if (m) keep.add(`${m[1]} ${m[2] || "0"}`);
      }
      try {
        await stripImportedAnnots(page, keep);
        report.annotsKept += keep.size;
      } catch {
        report.lost.push(`page ${index + 1} : les annotations d'origine n'ont pas pu être remplacées.`);
      }
    }
  }

  // --- 4. markup ------------------------------------------------------------
  step("Écriture des annotations", 0.45);
  const pageRefs: PDFRef[] = doc.getPages().map((p) => p.ref);
  for (const { page, model } of targets) {
    const frame = pageFrame(page);
    const ctx: PaintContext = { doc, frame, fonts, images, measureScale: state.measureScale };
    const mine = state.annots.filter(
      (a) => a.pageId === model.id && !pristine.has(a) && !(a.kind === "redact" && !opts.applyRedactions),
    );

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
      if (report.fieldsCreated < state.createdFields.length) {
        report.lost.push(
          `${state.createdFields.length - report.fieldsCreated} champ(s) de formulaire n'ont pas pu être créés.`,
        );
      }
    } catch {
      report.lost.push("Les champs de formulaire créés n'ont pas pu être écrits.");
    }
  }
  const valueCount = Object.keys(state.formValues).length;
  if (valueCount) {
    const { font } = await fonts.standard();
    report.fieldsFilled = fillForm(doc, state.formValues, font).filled;
    if (report.fieldsFilled < valueCount) {
      report.lost.push(`${valueCount - report.fieldsFilled} valeur(s) de champ n'ont pas pu être enregistrées.`);
    }
  }
  if (opts.flattenForms) {
    if (!flattenForm(doc)) report.lost.push("Aplatissement du formulaire impossible.");
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
  // Untouched bookmarks stay exactly as the file has them (destinations,
  // actions, structure links); edited ones — including "all deleted" — are
  // written from the model.
  if (state.bookmarks && state.bookmarks !== opts.pristineBookmarks) {
    try {
      writeOutline(doc, toOutlineEntries(state.bookmarks, targets.length));
    } catch {
      report.lost.push("Les signets n'ont pas pu être écrits.");
    }
  }
  if (state.pages.some((p) => p.label)) {
    try {
      writePageLabels(
        doc,
        targets.map((t) => t.model.label),
      );
    } catch {
      report.lost.push("Les numéros de page personnalisés n'ont pas pu être écrits.");
    }
  }

  try {
    writeMetadata(doc, state);
  } catch {
    report.lost.push("Les propriétés du document (titre, auteur…) n'ont pas pu être écrites.");
  }

  if (opts.sanitise) {
    const { removed } = sanitiseDocument(doc);
    if (removed.length) report.warnings.push(`Assaini : ${removed.join(", ")}.`);
  }
}

const PAGES = PDFName.of("Pages");
const KIDS = PDFName.of("Kids");
const TYPE = PDFName.of("Type");
const PARENT = PDFName.of("Parent");
const INHERITED = ["Resources", "MediaBox", "CropBox", "Rotate"].map((k) => PDFName.of(k));

function invalidatePages(doc: PDFDocument): void {
  // pdf-lib's removePage() does not drop its cached page list (insertPage does).
  (doc as unknown as { pageCache: { invalidate(): void } }).pageCache.invalidate();
}

/**
 * Put the page tree in the `desired` order touching as few objects as
 * possible — an incremental save then carries only what really moved:
 *  - same relative order (pages inserted and/or removed): pdf-lib's own
 *    insert/remove, which only update the tree nodes on the path;
 *  - a pure permutation: the tree keeps its shape, its leaf slots are
 *    reassigned (a page that changes parent gets its inherited attributes
 *    written on itself first);
 *  - anything else: the tree is rebuilt.
 */
function applyPageOrder(doc: PDFDocument, desired: PDFPage[], existing: PDFPage[]): void {
  const inTree = new Set(existing);
  const wanted = new Set(desired);
  const keptExisting = existing.filter((p) => wanted.has(p));
  const keptDesired = desired.filter((p) => inTree.has(p));
  if (keptExisting.length === keptDesired.length && keptExisting.every((p, i) => p === keptDesired[i])) {
    for (let i = existing.length - 1; i >= 0; i--) if (!wanted.has(existing[i])) doc.removePage(i);
    invalidatePages(doc);
    desired.forEach((p, i) => {
      if (!inTree.has(p)) doc.insertPage(i, p);
    });
    return;
  }
  if (desired.length === existing.length && keptDesired.length === desired.length && permuteLeaves(doc, desired)) {
    invalidatePages(doc);
    return;
  }
  for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
  invalidatePages(doc);
  for (const p of desired) doc.addPage(p);
}

/** Reassign the leaf slots of the page tree to `desired` (same pages, new order). False = tree not walkable. */
function permuteLeaves(doc: PDFDocument, desired: PDFPage[]): boolean {
  const ctx = doc.context;
  const slots: { kids: PDFArray; idx: number; parent: PDFRef }[] = [];
  const seen = new Set<string>();
  const walk = (ref: PDFRef, depth: number): boolean => {
    if (depth > 64 || seen.has(String(ref))) return false;
    seen.add(String(ref));
    const node = ctx.lookup(ref);
    if (!(node instanceof PDFDict)) return false;
    const kids = node.lookup(KIDS);
    if (!(kids instanceof PDFArray)) return false;
    for (let i = 0; i < kids.size(); i++) {
      const kidRef = kids.get(i);
      if (!(kidRef instanceof PDFRef)) return false;
      const kid = ctx.lookup(kidRef);
      if (kid instanceof PDFDict && kid.lookup(TYPE) === PAGES) {
        if (!walk(kidRef, depth + 1)) return false;
      } else slots.push({ kids, idx: i, parent: ref });
    }
    return true;
  };
  const root = doc.catalog.get(PAGES);
  if (!(root instanceof PDFRef) || !walk(root, 0) || slots.length !== desired.length) return false;
  desired.forEach((page, i) => {
    const slot = slots[i];
    const leaf = page.node;
    const parent = leaf.get(PARENT);
    if (!(parent instanceof PDFRef) || parent !== slot.parent) {
      for (const name of INHERITED) {
        if (leaf.has(name)) continue;
        const value = (
          leaf as unknown as { getInheritableAttribute(n: PDFName): PDFObject | undefined }
        ).getInheritableAttribute(name);
        if (value !== undefined) leaf.set(name, value);
      }
      leaf.set(PARENT, slot.parent);
    }
    if (slot.kids.get(slot.idx) !== page.ref) slot.kids.set(slot.idx, page.ref);
  });
  return true;
}

/** Info dictionary: only what the user changed, plus the producer and modification date. */
function writeMetadata(doc: PDFDocument, state: PdfState): void {
  const meta = state.metadata;
  const same = (a: string | undefined, b: string | undefined) => (a ?? "") === (b ?? "");
  const xmp: XmpChanges = {};
  if (meta.title !== undefined && !same(meta.title, doc.getTitle())) {
    doc.setTitle(meta.title ?? "");
    xmp.title = meta.title ?? "";
  }
  if (meta.author !== undefined && !same(meta.author, doc.getAuthor())) {
    doc.setAuthor(meta.author ?? "");
    xmp.author = meta.author ?? "";
  }
  if (meta.subject !== undefined && !same(meta.subject, doc.getSubject())) {
    doc.setSubject(meta.subject ?? "");
    xmp.subject = meta.subject ?? "";
  }
  // Kept verbatim (pdf-lib would join a split list with spaces).
  if (meta.keywords !== undefined && !same(meta.keywords, doc.getKeywords())) {
    doc.setKeywords(meta.keywords ? [meta.keywords] : []);
    xmp.keywords = meta.keywords ?? "";
  }
  if (meta.language) {
    const lang = doc.catalog.lookup(PDFName.of("Lang"));
    const current = lang instanceof PDFString || lang instanceof PDFHexString ? lang.decodeText() : undefined;
    if (current !== meta.language) doc.setLanguage(meta.language);
  }
  // The authoring application stays the original one; Elium is the producer.
  if (meta.creator !== undefined && !same(meta.creator, doc.getCreator())) doc.setCreator(meta.creator ?? "");
  else if (!doc.getCreator()) doc.setCreator("Elium");
  const now = new Date();
  doc.setProducer("Elium PDF");
  doc.setModificationDate(now);
  // Acrobat reads the XMP packet first: keep it saying the same thing.
  syncXmp(doc, { ...xmp, producer: "Elium PDF", modified: now });
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
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
 * anything, no protection (it only lives in memory). Used by the Print command
 * and by "Save a flattened copy".
 */
export async function buildFlattened(
  sourceBytes: Uint8Array,
  state: PdfState,
  fileName: string,
  author: string,
  password?: string | null,
): Promise<Uint8Array> {
  const { bytes } = await buildPdf(sourceBytes, state, {
    interactiveAnnots: false,
    flattenForms: true,
    applyRedactions: true,
    fileName,
    author,
    password,
    encryption: "remove",
  });
  return bytes;
}

export { PDFName };
