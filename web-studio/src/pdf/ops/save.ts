/**
 * The save pipeline: turn the source PDF plus the editing state into real
 * PDF bytes.
 *
 * Order matters, and it is the order Acrobat uses:
 *
 *   decrypt → reorganise pages → crop/rotate → rewrite content (text,
 *   images, redaction) → markup → form fields → page marks → outline & metadata
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

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFPage, PDFRef, PDFString } from "pdf-lib";
import type { PDFObject } from "pdf-lib";
import type { Rect } from "../core/coords";
import type {
  Annot,
  AttachmentEdits,
  Bookmark,
  DestEdits,
  InitialView,
  Page,
  PageLabelDef,
  PdfState,
} from "../model/types";
import { remapBookmarkPages } from "../model/doc";
import { pageFrame, flattenAnnots, mustFlatten, writeAnnots, writeRedactMarks } from "./annots-pdf";
import type { PaintContext } from "./annots-pdf";
import { decoratePage, planMarks, stripPageMarks } from "./decorate";
import { nameKey, readNameTree, uniqueKey, writeNameTree } from "./nametree";
import { FontBook } from "./fonts";
import { FieldFontBook, completeFieldAppearances, flattenFields } from "./formpdf";
import { applyFieldEdits } from "./formedit";
import { dropHybridXfa } from "./xfa";
import { createFields, fillForm } from "./forms";
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
import {
  PAGE_SIZES,
  copyPagesMapped,
  cropPage,
  purgeRemovedPages,
  readPageLabelDefs,
  rotatePage,
  shareCopiedFields,
  writeOutline,
  writePageLabels,
} from "./organize";
import type { OutlineEntry } from "./organize";
import { ALL_HIDDEN_INFO, applyRedactions, removeHiddenInfo, type HiddenInfoOptions } from "./redact";
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
  /**
   * Keep the pages excluded (« Exclure ») — the document itself is being saved:
   * exclusion leaves them out of copies, prints and extractions only.
   */
  keepSkipped?: boolean;
  /** Acrobat's « Nettoyer le document »: every kind of hidden information, form fields flattened. */
  sanitise: boolean;
  /** Only these kinds of hidden information (after a redaction, typically). */
  hiddenInfo?: HiddenInfoOptions;
  /** Recompress and downsample to reduce the file size. */
  optimise: boolean;
  /** How (« Optimisation avancée »): resolution, JPEG quality, what to do. */
  optimiseOptions?: Partial<import("./optimize").OptimiseOptions>;
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
  /** Built to be printed: what does not print (no Print flag, hidden) is left out. */
  forPrint?: boolean;
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
  /** What « Optimiser » did. */
  optimised?: import("./optimize").OptimiseReport;
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
    await crypt.decryptDocument(doc, bytes);
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
  /**
   * Why this save must rewrite the whole file although the state alone would
   * not require it — e.g. the session was recomposed (pages inserted from
   * another PDF) after pages had been deleted: `disk` still holds them.
   */
  forceFullReasons?: readonly string[];
  /**
   * Last step on the working document, after the model is applied and before
   * it is written (pages in their final order): insert pages from another
   * PDF, add an OCR text layer… Whatever it changes is saved like the rest —
   * incrementally, encrypted with the file's key.
   */
  transform?: (doc: PDFDocument, report: BuildReport) => Promise<void>;
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
  opts: Pick<BuildOptions, "applyRedactions" | "optimise" | "sanitise" | "flattenForms" | "keepSkipped" | "hiddenInfo">,
  sourcePageCount: number,
  security?: SecurityChange | null,
): string[] {
  const reasons: string[] = [];
  if (security === "remove") reasons.push("retrait de la protection par mot de passe");
  else if (security) reasons.push("nouvelle protection par mot de passe");
  if (opts.applyRedactions && state.annots.some((a) => a.kind === "redact")) {
    reasons.push("caviardage : le contenu masqué est retiré définitivement, révisions précédentes comprises");
  }
  const used = new Set(
    state.pages.filter((p) => (opts.keepSkipped || !p.skipped) && p.from != null).map((p) => p.from),
  );
  let removed = 0;
  for (let i = 0; i < sourcePageCount; i++) if (!used.has(i)) removed++;
  if (removed) reasons.push(`${removed} page(s) supprimée(s) : retirées définitivement du fichier`);
  if (opts.optimise) reasons.push("optimisation de la taille");
  if (opts.sanitise) reasons.push("assainissement");
  else if (opts.hiddenInfo && Object.values(opts.hiddenInfo).some(Boolean))
    reasons.push("informations masquées supprimées, révisions précédentes comprises");
  if (opts.flattenForms) reasons.push("aplatissement du formulaire");
  return reasons;
}

/**
 * The annotations (not redaction marks) that meet a redaction mark on their
 * page, and the members of their groups: a redaction removes them with the
 * content they cover.
 */
export function annotsUnderRedaction(annots: readonly Annot[]): Set<string> {
  const gone = new Set<string>();
  const marks = annots.filter((a) => a.kind === "redact");
  if (!marks.length) return gone;
  const meets = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const a of annots) {
    if (a.kind !== "redact" && marks.some((m) => m.pageId === a.pageId && meets(a.rect, m.rect))) gone.add(a.id);
  }
  for (const a of annots) if (a.group && gone.has(a.group)) gone.add(a.id);
  return gone;
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
  for (const r of input.forceFullReasons ?? []) if (!reasons.includes(r)) reasons.push(r);
  if (input.mode === "full" && !reasons.length) reasons.push("réécriture complète demandée");
  const full = input.mode === "full" || reasons.length > 0;

  await applyState(doc, state, opts, report, !!input.base);
  if (input.transform) await input.transform(doc, report);

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
        report.optimised = await optimiseDocument(doc, opts.optimiseOptions);
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

async function applyState(
  doc: PDFDocument,
  state: PdfState,
  opts: BuildOptions,
  report: BuildReport,
  formBase: boolean,
): Promise<void> {
  const step = (label: string, ratio: number) => opts.onProgress?.(label, ratio);

  // --- 1. page order -------------------------------------------------------
  step("Organisation des pages", 0.08);
  const wanted = state.pages.filter((p) => opts.keepSkipped || !p.skipped);
  const source = doc.getPages();
  // The file's own labels, by source page, before the pages move.
  let fileLabels: (PageLabelDef | undefined)[] | null = null;
  try {
    fileLabels = readPageLabelDefs(doc);
  } catch {
    fileLabels = null;
  }
  const targets: { page: PDFPage; model: Page }[] = [];
  const seen = new Set<number>();
  const copies: { original: PDFPage; copy: PDFPage }[] = [];

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
      const [copy] = copyPagesMapped(doc, doc, [model.from], true);
      targets.push({ page: copy, model });
      copies.push({ original: src, copy });
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
  // A duplicated page's fields are the same fields; removed pages leave nothing pointing at them.
  try {
    shareCopiedFields(doc, copies);
    const kept = new Set(targets.map((t) => `${t.page.ref.objectNumber} ${t.page.ref.generationNumber}`));
    purgeRemovedPages(doc, source, kept);
  } catch {
    report.warnings.push("Les liens vers les pages retirées n'ont pas tous pu être nettoyés.");
  }

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
  // --- crop and rotate: first, since the model's coordinates (text and image
  // edits, redactions, markup) are those of the page as cropped in Elium.
  for (const { page, model } of targets) {
    if (model.crop) cropPage(page, model.crop);
    if (model.rotate) rotatePage(page, model.rotate);
  }

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
        if (r.missing.length) {
          report.lost.push(
            `${where} : caractère(s) « ${[...new Set(r.missing.join(""))].join("")} » absent(s) des polices disponibles, non écrit(s).`,
          );
        }
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
          report.redactedImages += r.imagesRemoved + (r.imagesEdited ?? 0);
          for (const w of r.warnings ?? []) if (!report.warnings.includes(w)) report.warnings.push(w);
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

  // The markup the model imported from the source is about to be written back
  // from the model — remove the originals so nothing is duplicated. Imported
  // annotations the user did not touch stay as they are in the file.
  // (An imported `/Redact` mark being applied is not kept: it is performed.)
  const pristine = new Set(
    opts.pristineAnnots
      ? state.annots.filter((a) => opts.pristineAnnots!.has(a) && !(a.kind === "redact" && opts.applyRedactions))
      : [],
  );
  // A group member kept as it was would point at its rewritten parent's old object.
  for (const a of [...pristine]) {
    if (!a.group) continue;
    const parent = state.annots.find((x) => x.id === a.group);
    if (!parent || !pristine.has(parent)) pristine.delete(a);
  }
  // Annotations Elium leaves alone that hang on a comment it rewrites (a Caret
  // grouped with a strike-out, a reply to it from another app, their pop-ups).
  const dependents = new Map<
    string,
    { dict: import("pdf-lib").PDFDict; field: "IRT" | "Parent"; ref: PDFRef; page: PDFPage }[]
  >();
  const written = new Map<string, PDFRef>();
  // A large attachment file stays where it is in the source: keep its /FS
  // before the original annotations are removed, for the rewrite to reuse.
  const keptFiles = new Map<string, unknown>();
  for (const a of state.annots) {
    const src = a.kind === "attachment" && !a.file?.data ? a.file?.source : undefined;
    const m = src ? /^(\d+)R(\d*)$/.exec(src) : null;
    if (!m) continue;
    const dict = doc.context.lookup(PDFRef.of(Number(m[1]), Number(m[2] || 0)));
    if (dict instanceof PDFDict && dict.get(PDFName.of("FS"))) keptFiles.set(src!, dict.get(PDFName.of("FS")));
  }
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
        const r = await stripImportedAnnots(page, keep);
        for (const [k, list] of r.dependents)
          dependents.set(
            k,
            list.map((d) => ({ ...d, page })),
          );
        report.annotsKept += keep.size;
      } catch {
        report.lost.push(`page ${index + 1} : les annotations d'origine n'ont pas pu être remplacées.`);
      }
    }
  }

  // --- 4. markup ------------------------------------------------------------
  step("Écriture des annotations", 0.45);
  const pageRefs: PDFRef[] = doc.getPages().map((p) => p.ref);
  const outputIndex = new Map(targets.map((t, i) => [t.model.id, i]));
  // What a redaction covers goes, comments included: a note or a text box over
  // the area is not written back (its replies and pop-up go with it).
  const underRedaction = opts.applyRedactions ? annotsUnderRedaction(state.annots) : new Set<string>();
  for (const { page, model } of targets) {
    const frame = pageFrame(page);
    const ctx: PaintContext = {
      doc,
      frame,
      fonts,
      images,
      measureScale: state.measureScale,
      rotation: page.getRotation().angle,
    };
    const mine = state.annots.filter(
      (a) =>
        a.pageId === model.id &&
        !pristine.has(a) &&
        !underRedaction.has(a.id) &&
        !(a.kind === "redact" && !opts.applyRedactions),
    );
    if (!opts.applyRedactions) {
      // Marks not applied stay marks — `/Redact` annotations, as Acrobat keeps them.
      const pending = state.annots.filter((a) => a.pageId === model.id && a.kind === "redact" && !pristine.has(a));
      if (pending.length) report.annotsWritten += writeRedactMarks(page, pending, ctx, opts.author);
    }

    if (!mine.length) continue;
    let toFlatten: Annot[];
    if (opts.interactiveAnnots) {
      toFlatten = await writeAnnots(page, mine, ctx, {
        defaultAuthor: opts.author,
        pageRefs,
        written,
        keptFiles,
        pageIndexOf: (id) => outputIndex.get(id),
      });
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

  // Text-edit groups, across pages (a Caret may sit on another page than its strike-out).
  {
    const { linkGroups } = await import("./annots-pdf");
    linkGroups(doc, state.annots, written, new Set([...pristine].map((a) => a.id)));
  }
  if (dependents.size) {
    const { keyOfPdfjsId } = await import("./import-annots");
    const rewritten = new Map<string, PDFRef>();
    for (const [id, ref] of written) rewritten.set(keyOfPdfjsId(id), ref);
    for (const [key, list] of dependents) {
      const to = rewritten.get(key);
      for (const d of list) {
        if (to) {
          d.dict.set(PDFName.of(d.field), to);
          continue;
        }
        // Its comment was deleted (or flattened): it goes with it, as in Acrobat.
        const annots = d.page.node.Annots();
        const at = annots?.indexOf(d.ref) ?? -1;
        if (annots && at >= 0) annots.remove(at);
        doc.context.delete(d.ref);
        const popup = d.dict.get(PDFName.of("Popup"));
        if (popup instanceof PDFRef) {
          const pi = annots?.indexOf(popup) ?? -1;
          if (annots && pi >= 0) annots.remove(pi);
          doc.context.delete(popup);
        }
      }
    }
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
  let valuesChanged = 0;
  if (valueCount) {
    const r = fillForm(doc, state.formValues);
    report.fieldsFilled = r.filled;
    valuesChanged = r.changed;
    if (r.skipped.length) {
      report.lost.push(
        `Valeur non enregistrée pour ${r.skipped.length} champ(s) : ${r.skipped.slice(0, 5).join(", ")}.`,
      );
    }
    const unknown = valueCount - r.filled - r.skipped.length;
    if (unknown > 0)
      report.lost.push(`${unknown} valeur(s) de champ n'ont pas pu être enregistrées (champ absent du fichier).`);
  }
  // Appearances: every field this save touched (or pdf.js' own update, when
  // building on it) is drawn now, in a font that shows its value — the file
  // never relies on the next viewer (/NeedAppearances), as with Acrobat.
  // A hybrid XFA form filled through its AcroForm: Acrobat would show the stale XFA data.
  if ((valuesChanged || report.fieldsCreated || state.fieldEdits.length) && dropHybridXfa(doc)) {
    report.warnings.push(
      "Formulaire XFA hybride : la partie XFA a été retirée pour qu'Acrobat affiche les valeurs saisies (mise en page inchangée).",
    );
  }
  if (state.fieldEdits.length) {
    const r = applyFieldEdits(doc, state.fieldEdits);
    for (const problem of r.problems) report.lost.push(`Préparation du formulaire : ${problem}.`);
  }
  if (valuesChanged || report.fieldsCreated || state.fieldEdits.length || opts.flattenForms || formBase) {
    try {
      const ap = await completeFieldAppearances(doc, new FieldFontBook(doc), { refreshStale: true });
      if (ap.failed.length) {
        report.warnings.push(
          `Apparence non dessinée pour ${ap.failed.slice(0, 5).join(", ")} : le lecteur PDF la dessinera (/NeedAppearances).`,
        );
      }
      for (const u of ap.uncovered) {
        report.warnings.push(
          `Champ « ${u.field} » : caractère(s) « ${u.chars} » absent(s) des polices disponibles — son affichage est laissé au lecteur PDF.`,
        );
      }
    } catch {
      report.warnings.push("Apparence des champs non régénérée : le lecteur PDF les redessinera.");
    }
  }
  // « Nettoyer le document » takes the form fields away too: their values become page content.
  if (opts.flattenForms || opts.sanitise) {
    const fr = flattenFields(doc, { printing: opts.forPrint });
    if (fr.notDrawn.length) {
      report.lost.push(`Aplatissement : valeur non dessinée pour ${fr.notDrawn.slice(0, 5).join(", ")}.`);
    }
  }

  // Printing: annotations that do not print (no Print flag, hidden) are left out.
  if (opts.forPrint) {
    for (const page of doc.getPages()) {
      const annots = page.node.lookup(PDFName.of("Annots"));
      if (!(annots instanceof PDFArray)) continue;
      for (let i = annots.size() - 1; i >= 0; i--) {
        const a = annots.lookup(i);
        if (!(a instanceof PDFDict)) continue;
        const f = a.lookup(PDFName.of("F"));
        const flags = f instanceof PDFNumber ? f.asNumber() : 0;
        if (!(flags & 4) || flags & 2) annots.remove(i);
      }
    }
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
  const plan = planMarks(state, targets.length);
  for (let i = 0; i < targets.length; i++) {
    const { page } = targets[i];
    if (state.stripMarks) stripPageMarks(doc, page);
    await decoratePage(page, pageFrame(page), i, state, plan, decorateCtx);
  }

  // --- 7. outline, labels, metadata ----------------------------------------
  step("Signets et métadonnées", 0.84);
  // Untouched bookmarks stay exactly as the file has them (destinations,
  // actions, structure links); edited ones — including "all deleted" — are
  // written from the model.
  if (state.bookmarks && state.bookmarks !== opts.pristineBookmarks) {
    try {
      // Bookmark numbers count the model's pages; the file has only those written.
      const out = new Map(targets.map((t, i) => [t.model.id, i + 1]));
      const toOutput = (n: number): number | null => {
        for (let i = n - 1; i < state.pages.length; i++) {
          const pos = out.get(state.pages[i]?.id ?? "");
          if (pos) return pos;
        }
        return null;
      };
      writeOutline(doc, toOutlineEntries(remapBookmarkPages(state.bookmarks, toOutput), targets.length));
    } catch {
      report.lost.push("Les signets n'ont pas pu être écrits.");
    }
  }
  // Labels follow their pages (the file's, or those set in Elium), then are
  // written back as ranges for the output order.
  const untouched =
    !state.pages.some((p) => p.labelDef) &&
    targets.length === (fileLabels?.length ?? -1) &&
    targets.every((t, i) => t.model.from === i);
  if (!untouched && (fileLabels || state.pages.some((p) => p.labelDef))) {
    try {
      writePageLabels(
        doc,
        targets.map((t) => t.model.labelDef ?? (t.model.from != null ? fileLabels?.[t.model.from] : undefined)),
      );
    } catch {
      report.lost.push("Les numéros de page personnalisés n'ont pas pu être écrits.");
    }
  }

  if (state.destEdits) {
    try {
      writeDestEdits(doc, state.destEdits, (id) => outputIndex.get(id));
    } catch {
      report.lost.push("Les destinations nommées n'ont pas pu être écrites.");
    }
  }

  if (state.attachmentEdits) {
    try {
      await applyAttachmentEdits(doc, state.attachmentEdits);
    } catch {
      report.lost.push("Les modifications des pièces jointes n'ont pas pu être écrites.");
    }
  }

  if (state.initialView) {
    try {
      // The page it opens on counts the model's pages; the file has only those written.
      const model = state.pages[state.initialView.openPage - 1];
      const at = model ? targets.findIndex((t) => t.model.id === model.id) : -1;
      writeInitialView(doc, state.initialView, Math.max(0, at));
    } catch {
      report.lost.push("La vue initiale n'a pas pu être écrite.");
    }
  }

  if (state.ocDefaults) {
    try {
      writeLayerDefaults(doc, state.ocDefaults);
    } catch {
      report.lost.push("La visibilité par défaut des calques n'a pas pu être écrite.");
    }
  }

  try {
    writeMetadata(doc, state);
  } catch {
    report.lost.push("Les propriétés du document (titre, auteur…) n'ont pas pu être écrites.");
  }

  const hidden = opts.sanitise ? ALL_HIDDEN_INFO : opts.hiddenInfo;
  if (hidden) {
    const { removed } = await removeHiddenInfo(doc, hidden);
    report.warnings.push(
      removed.length
        ? `Informations masquées supprimées : ${removed.join(", ")}.`
        : "Aucune information masquée à supprimer n'a été trouvée.",
    );
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

function toOutlineEntries(nodes: readonly Bookmark[], pageCount: number): OutlineEntry[] {
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
    x: n.x,
    fit: n.fit,
    zoom: n.zoom,
    bold: n.bold,
    italic: n.italic,
    color: hex(n.color),
    closed: n.closed,
    action: n.action,
    src: n.src,
    retargeted: n.retargeted,
    children: toOutlineEntries(n.children, pageCount),
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

/**
 * Layer visibility as the file's default (Acrobat's « Enregistrer la
 * visibilité actuelle des calques »): the default configuration's /ON and
 * /OFF lists, /BaseState ON. `vis` is keyed by pdf.js group id ("12R",
 * "12R3" with a generation).
 */
function writeLayerDefaults(doc: PDFDocument, vis: Record<string, boolean>): void {
  const props = doc.catalog.lookup(PDFName.of("OCProperties"));
  if (!(props instanceof PDFDict)) return;
  let d = props.lookup(PDFName.of("D"));
  if (!(d instanceof PDFDict)) {
    d = doc.context.obj({});
    props.set(PDFName.of("D"), d as PDFDict);
  }
  const dict = d as PDFDict;
  // Every group keeps its present default unless `vis` names it (a group the
  // panel does not list — out of /Order — stays as it was).
  const key = (r: PDFRef) => `${r.objectNumber} ${r.generationNumber}`;
  const refsOf = (name: string) => {
    const a = dict.lookup(PDFName.of(name));
    return a instanceof PDFArray ? a.asArray().filter((r): r is PDFRef => r instanceof PDFRef) : [];
  };
  const baseOff = dict.lookup(PDFName.of("BaseState"))?.toString() === "/OFF";
  const offNow = new Set(refsOf("OFF").map(key));
  const onNow = new Set(refsOf("ON").map(key));
  const all = new Map<string, PDFRef>();
  const ocgs = props.lookup(PDFName.of("OCGs"));
  if (ocgs instanceof PDFArray) for (const r of ocgs.asArray()) if (r instanceof PDFRef) all.set(key(r), r);
  for (const r of [...refsOf("ON"), ...refsOf("OFF")]) all.set(key(r), r);
  const wanted = new Map<string, boolean>();
  for (const [id, visible] of Object.entries(vis)) {
    const m = /^(\d+)R(\d*)$/.exec(id);
    if (!m) continue;
    const ref = PDFRef.of(Number(m[1]), m[2] ? Number(m[2]) : 0);
    if (!(doc.context.lookup(ref) instanceof PDFDict)) continue;
    all.set(key(ref), ref);
    wanted.set(key(ref), visible);
  }
  const on: PDFRef[] = [];
  const off: PDFRef[] = [];
  for (const [k, ref] of all) {
    const visible = wanted.get(k) ?? (offNow.has(k) ? false : onNow.has(k) ? true : !baseOff);
    (visible ? on : off).push(ref);
  }
  dict.set(PDFName.of("BaseState"), PDFName.of("ON"));
  dict.set(PDFName.of("ON"), doc.context.obj(on));
  dict.set(PDFName.of("OFF"), doc.context.obj(off));
}

/**
 * The Initial View (Acrobat's Propriétés › Vue initiale): /PageMode,
 * /PageLayout, /OpenAction to page `pageIndex` (0-based, output) with its
 * magnification, and the window options of /ViewerPreferences (the other
 * preferences — print scaling, duplex… — stay as the file has them).
 */
function writeInitialView(doc: PDFDocument, v: InitialView, pageIndex: number): void {
  const cat = doc.catalog;
  const ctx = doc.context;
  if (v.pageMode === "UseNone") cat.delete(PDFName.of("PageMode"));
  else cat.set(PDFName.of("PageMode"), PDFName.of(v.pageMode));
  if (v.pageLayout === "SinglePage") cat.delete(PDFName.of("PageLayout"));
  else cat.set(PDFName.of("PageLayout"), PDFName.of(v.pageLayout));
  const page = doc.getPages()[Math.min(pageIndex, doc.getPageCount() - 1)];
  if (page && v.openChanged) {
    const z = v.openZoom;
    const dest =
      z === "Fit"
        ? [page.ref, PDFName.of("Fit")]
        : z === "FitH"
          ? [page.ref, PDFName.of("FitH"), null]
          : z === "FitV"
            ? [page.ref, PDFName.of("FitV"), null]
            : [page.ref, PDFName.of("XYZ"), null, null, typeof z === "number" ? z : null];
    cat.set(PDFName.of("OpenAction"), ctx.obj(dest as never));
  }
  let prefs = cat.lookup(PDFName.of("ViewerPreferences"));
  if (!(prefs instanceof PDFDict)) prefs = ctx.obj({});
  const p = prefs as PDFDict;
  const flags: [keyof InitialView, string][] = [
    ["hideToolbar", "HideToolbar"],
    ["hideMenubar", "HideMenubar"],
    ["hideWindowUI", "HideWindowUI"],
    ["fitWindow", "FitWindow"],
    ["centerWindow", "CenterWindow"],
    ["displayDocTitle", "DisplayDocTitle"],
  ];
  for (const [key, name] of flags) {
    if (v[key]) p.set(PDFName.of(name), ctx.obj(true));
    else p.delete(PDFName.of(name));
  }
  if (p.keys().length) cat.set(PDFName.of("ViewerPreferences"), p);
  else cat.delete(PDFName.of("ViewerPreferences"));
}

/**
 * The document's attached files as changed in Elium: removed from the
 * /EmbeddedFiles name tree, described anew (/Desc of their file
 * specification), or added. The file's attachments are named by their
 * position in the tree (`#0`, `#1`… — two may share a name); the tree is
 * written back sorted, as one leaf.
 */
async function applyAttachmentEdits(doc: PDFDocument, edits: AttachmentEdits): Promise<void> {
  const ctx = doc.context;
  let names = doc.catalog.lookup(PDFName.of("Names"));
  const entries = readNameTree(names instanceof PDFDict ? names : undefined, "EmbeddedFiles");
  const removed = new Set(edits.removed);
  const kept = entries.filter((e, i) => {
    if (removed.has(`#${i}`)) return false;
    const desc = edits.described[`#${i}`];
    const spec = e.v instanceof PDFRef ? ctx.lookup(e.v) : e.v;
    if (desc !== undefined && spec instanceof PDFDict) {
      if (desc) spec.set(PDFName.of("Desc"), PDFHexString.fromText(desc));
      else spec.delete(PDFName.of("Desc"));
    }
    return true;
  });
  // One encoding for every key (a UTF-16 key sorts after all ASCII ones): nothing points at these by name.
  for (const e of kept) e.k = nameKey(e.key);
  const taken = new Set(kept.map((e) => e.key));
  for (const a of edits.added) {
    const m = /^data:[^,]*;base64,(.*)$/s.exec(a.data);
    if (!m) continue;
    const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    const now = PDFString.fromDate(new Date());
    const file = ctx.register(
      ctx.flateStream(bytes, {
        Type: "EmbeddedFile",
        Subtype: PDFName.of(a.mime || "application/octet-stream"),
        Params: { Size: bytes.length, ModDate: now, CreationDate: now },
      } as never),
    );
    const key = uniqueKey(a.name, taken);
    taken.add(key);
    const spec = ctx.register(
      ctx.obj({
        Type: "Filespec",
        F: PDFString.of(a.name.replace(/[^\x20-\x7e]/g, "_")),
        UF: PDFHexString.fromText(a.name),
        EF: { F: file, UF: file },
        ...(a.description ? { Desc: PDFHexString.fromText(a.description) } : {}),
        AFRelationship: "Unspecified",
      } as never),
    );
    kept.push({ key, k: nameKey(key), v: spec });
  }
  if (!(names instanceof PDFDict)) {
    if (!kept.length) return;
    names = ctx.obj({});
    doc.catalog.set(PDFName.of("Names"), names as PDFDict);
  }
  writeNameTree(doc, names as PDFDict, "EmbeddedFiles", kept);
}

/**
 * Named destinations as changed in Elium: the removed ones leave the catalog's
 * /Dests and the /Names /Dests tree; the added ones join the tree, written
 * back sorted (as ISO 32000 requires).
 */
function writeDestEdits(doc: PDFDocument, edits: DestEdits, indexOf: (pageId: string) => number | undefined): void {
  const ctx = doc.context;
  const removed = new Set([...edits.removed, ...edits.added.map((a) => a.name)]);
  const dests = doc.catalog.lookup(PDFName.of("Dests"));
  if (dests instanceof PDFDict) for (const name of removed) dests.delete(PDFName.of(name));
  let names = doc.catalog.lookup(PDFName.of("Names"));
  const entries = readNameTree(names instanceof PDFDict ? names : undefined, "Dests").filter(
    (e) => !removed.has(e.key),
  );
  const pages = doc.getPages();
  for (const a of edits.added) {
    const at = indexOf(a.pageId);
    const page = at !== undefined ? pages[at] : undefined;
    if (!page) continue;
    const box = page.getCropBox();
    const dest = ctx.obj([
      page.ref,
      PDFName.of("XYZ"),
      a.x != null ? a.x + box.x : null,
      a.y != null ? box.y + box.height - a.y : null,
      a.zoom ?? null,
    ] as never);
    entries.push({ key: a.name, k: nameKey(a.name), v: dest });
  }
  if (!(names instanceof PDFDict)) {
    if (!entries.length) return;
    names = ctx.obj({});
    doc.catalog.set(PDFName.of("Names"), names as PDFDict);
  }
  writeNameTree(doc, names as PDFDict, "Dests", entries);
}
