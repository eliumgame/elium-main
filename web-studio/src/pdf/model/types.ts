/**
 * The Elium PDF document model.
 *
 * Everything the user can change about a PDF lives here — page order, markup,
 * comment threads, form values, redaction marks, bookmarks, metadata — as plain
 * serialisable data in *page space* (see `core/coords.ts`). Nothing in this file
 * imports pdf.js or pdf-lib, so it is cheap to load, easy to unit-test and safe
 * to persist inside a sealed `.elium`.
 */

import type { Pt, Quad, Rect, Rotation } from "../core/coords";

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * Every markup kind Acrobat offers. Grouped by how they are edited:
 *  - text markup: anchored to real text runs, stored as quads
 *  - shapes/ink: geometry the user draws
 *  - content: text boxes, stamps, images, signatures
 *  - special: redaction marks, links, measurements
 */
export type AnnotKind =
  // text markup (quad-anchored)
  | "highlight"
  | "underline"
  | "strikeout"
  | "squiggly"
  // Acrobat's text edits: text inserted at a point (with a strike-out: replaced)
  | "caret"
  // notes & text
  | "note"
  // a file carried by the page (Acrobat's « Joindre un fichier »)
  | "attachment"
  | "freetext"
  | "callout"
  | "typewriter"
  // drawing
  | "ink"
  | "square"
  | "circle"
  | "line"
  | "arrow"
  | "polygon"
  | "polyline"
  | "cloud"
  // content
  | "stamp"
  | "image"
  | "signature"
  | "whiteout"
  // special
  | "redact"
  | "link"
  | "distance"
  | "perimeter"
  | "area";

export const TEXT_MARKUP_KINDS: readonly AnnotKind[] = ["highlight", "underline", "strikeout", "squiggly"];
export const MEASURE_KINDS: readonly AnnotKind[] = ["distance", "perimeter", "area"];
export const SHAPE_KINDS: readonly AnnotKind[] = ["square", "circle", "line", "arrow", "polygon", "polyline", "cloud"];
export const TEXT_CONTENT_KINDS: readonly AnnotKind[] = ["freetext", "callout", "typewriter"];

export function isTextMarkup(k: AnnotKind): boolean {
  return TEXT_MARKUP_KINDS.includes(k);
}
export function isMeasure(k: AnnotKind): boolean {
  return MEASURE_KINDS.includes(k);
}
export function isShape(k: AnnotKind): boolean {
  return SHAPE_KINDS.includes(k);
}
export function isTextContent(k: AnnotKind): boolean {
  return TEXT_CONTENT_KINDS.includes(k);
}
/** Kinds whose geometry is a free polyline/polygon rather than a box. */
export function isPolyKind(k: AnnotKind): boolean {
  return k === "polygon" || k === "polyline" || k === "cloud" || k === "perimeter" || k === "area";
}

/** Review state of a comment, mirroring Acrobat's review workflow. */
export type ReviewStatus = "none" | "accepted" | "rejected" | "cancelled" | "completed";

/** A file carried by an annotation. */
export interface AnnotFile {
  name: string;
  mime: string;
  /** The bytes, as a base64 data URL ("" for a large file left in the source PDF). */
  data: string;
  description?: string;
  /**
   * A large file is not copied into the model: it stays in the source PDF, in
   * the annotation whose pdf.js id this is, and the save reuses it from there.
   */
  source?: string;
}

/** A reply in a comment thread (Acrobat `/IRT` + `/RT /R`). */
export interface Reply {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  /** Status change carried by this reply, when it is a review action. */
  status?: ReviewStatus;
}

/** Line ending style for lines, arrows and polylines (PDF `/LE`). */
export type LineEnding = "none" | "arrow" | "openArrow" | "circle" | "square" | "diamond" | "butt" | "slash";

/** Border style (PDF `/BS /S`). */
export type BorderStyle = "solid" | "dashed" | "cloudy";

/** A named unit + real-world ratio used by the measurement tools. */
export interface MeasureScale {
  /** How many real-world units one PDF point represents. */
  unitsPerPoint: number;
  /** Display unit label, e.g. "m", "cm", "ft". */
  unit: string;
  /** Decimals shown in the measurement caption. */
  precision: number;
}

export const DEFAULT_MEASURE_SCALE: MeasureScale = { unitsPerPoint: 25.4 / 72 / 10, unit: "cm", precision: 2 };

/** Where a link goes. */
export type LinkAction =
  /**
   * A view of a page of this document. `pageId` names the page (it follows it
   * when pages move); `page` (1-based) is the fallback of older sessions.
   */
  | { type: "page"; page: number; pageId?: string; x?: number; y?: number; fit?: DestFit; zoom?: number }
  | { type: "url"; url: string }
  /** Acrobat's named actions: NextPage, PrevPage, FirstPage, LastPage, GoBack, GoForward. */
  | { type: "named"; name: string };

/** How a link shows (Acrobat's « Propriétés du lien »): border, its style and width, the click highlight. */
export interface LinkStyle {
  /** A visible rectangle (colour: the annotation's `color`); false: invisible. */
  visible: boolean;
  line: "solid" | "dashed" | "underline";
  width: number;
  /** /H: none, invert, outline, push. */
  highlight: "N" | "I" | "O" | "P";
}

/**
 * A single annotation. Geometry is always in the page's *unrotated* top-left
 * point space, so zoom and rotation are pure view concerns.
 */
export interface Annot {
  id: string;
  /** Id of the `Page` this belongs to (not an index — pages get reordered). */
  pageId: string;
  kind: AnnotKind;

  /** Bounding box. For quad/poly kinds it is derived, but always kept in sync. */
  rect: Rect;
  /** Text-markup geometry, following the real glyph runs. */
  quads?: Quad[];
  /** Ink strokes (each an independent path) or polygon/polyline vertices. */
  paths?: Pt[][];
  /** Callout leader line: [tail, knee?, head]. */
  callout?: Pt[];

  // --- appearance ---------------------------------------------------------
  color: string;
  /** Interior colour; null = transparent. */
  fill?: string | null;
  opacity: number;
  strokeWidth: number;
  borderStyle?: BorderStyle;
  dash?: number[] | null;
  lineStart?: LineEnding;
  lineEnd?: LineEnding;
  /** Rotation of the annotation itself, degrees clockwise (stamps/images/text). */
  rotation?: number;

  // --- text content -------------------------------------------------------
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  vAlign?: "top" | "middle" | "bottom";
  /** Background of a text box; null = transparent. */
  textBg?: string | null;

  // --- images, stamps, signatures ----------------------------------------
  /** Data URL (png/jpeg) for image, stamp and signature annotations. */
  src?: string;
  /** Standard stamp label ("APPROVED", …) when the stamp is generated, not an image. */
  stampLabel?: string;
  stampTone?: "green" | "red" | "blue" | "orange" | "neutral";
  /** PDF `/Name` of a library stamp (« Approved », « #DReceived »…). */
  stampName?: string;
  /** Second line of a dynamic stamp (who and when, frozen at placement). */
  stampSub?: string;

  // --- special ------------------------------------------------------------
  action?: LinkAction;
  linkStyle?: LinkStyle;
  /** Overlay text printed on top of a redaction box, e.g. "[CAVIARDÉ]". */
  redactText?: string;
  redactFill?: string;
  measure?: MeasureScale;
  /**
   * Note icon (PDF `/Name`: Comment, Key, Note, Help, NewParagraph, Paragraph,
   * Insert), or an attachment's (PushPin, Paperclip, Graph, Tag).
   */
  icon?: string;
  /** The file an « attachment » carries (embedded in the PDF at save). */
  file?: AnnotFile;

  /**
   * What the file said about an imported annotation that the model does not
   * edit, written back when it is rewritten: its `/NM`, the `/F` bits other
   * than Hidden / Locked (NoPrint, NoZoom, NoRotate, ReadOnly…), a pop-up's
   * `/Open`, and the rich text `/RC` — kept only while the text is the one it
   * was written for.
   */
  pdf?: { nm?: string; flags?: number; open?: boolean; rc?: string; rcFor?: string };

  // --- review metadata (Acrobat comment pane) -----------------------------
  author: string;
  subject?: string;
  /** The comment body shown in the pane / popup — distinct from on-page `text`. */
  contents?: string;
  createdAt: string;
  modifiedAt: string;
  status?: ReviewStatus;
  /**
   * Part of another comment's group (`/IRT` + `/RT /Group`): the strike-out of
   * a « Remplacer le texte », whose text and thread are its Caret's.
   */
  group?: string;
  /** Acrobat's checkmark (`/StateModel (Marked)`): the reviewer's own tick, not a status. */
  checked?: boolean;
  replies?: Reply[];
  /** Locked annotations cannot be moved or edited, only read. */
  locked?: boolean;
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * A page in the output order. `from` indexes the *source* document; null means
 * a page this session inserted (blank or built from an image).
 */
/** One page's label, the way ISO 32000 /PageLabels describe it (12.4.2). */
export interface PageLabelDef {
  style: "decimal" | "roman" | "ROMAN" | "alpha" | "ALPHA" | "none";
  prefix: string;
  /** This page's number in its range (the range's /St plus its offset). */
  num: number;
}

export interface Page {
  id: string;
  from: number | null;
  /** Extra clockwise rotation the user applied, on top of the source /Rotate. */
  rotate?: Rotation;
  /** Crop, expressed as an inset in points from each edge of the source page. */
  crop?: { top: number; right: number; bottom: number; left: number } | null;
  /** Size for inserted pages (source pages take their own size). */
  size?: { w: number; h: number };
  /** Background image for pages built from a picture. */
  image?: string;
  /** Custom page label shown instead of the ordinal ("i", "A-1", …). */
  label?: string;
  /** What `label` is made of, as a PDF page-label range writes it (style, prefix, number). */
  labelDef?: PageLabelDef;
  /** Excluded from export without losing its annotations. */
  skipped?: boolean;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export type FieldKind = "text" | "checkbox" | "radio" | "dropdown" | "listbox" | "signature" | "button";

/**
 * Value of an AcroForm field (see `core/forms/values.ts`): text / single choice
 * → string; checkbox / radio → the export value of the checked widget, "Off"
 * when none (older sessions stored checkboxes as booleans, still accepted);
 * multi-select list → string[].
 */
export type FormValue = string | boolean | string[];

/**
 * How a text field shows and accepts its value — Acrobat's « Format » tab,
 * written as its own AF* functions (AFNumber_Format…), which every PDF viewer
 * with form JavaScript knows.
 */
export type FieldFormat =
  | { kind: "none" }
  | {
      kind: "number";
      decimals: number;
      /** 0 « 1,234.56 » · 1 « 1234.56 » · 2 « 1.234,56 » · 3 « 1234,56 » · 4 « 1'234.56 » */
      sepStyle: 0 | 1 | 2 | 3 | 4;
      /** 0 « -1 » · 1 red · 2 « (1) » · 3 « (1) » red */
      negStyle: 0 | 1 | 2 | 3;
      currency: string;
      currencyPrepend: boolean;
    }
  | { kind: "percent"; decimals: number; sepStyle: 0 | 1 | 2 | 3 | 4 }
  /** `pattern`: « dd/mm/yyyy », « d mmmm yyyy »… (Acrobat's date masks). */
  | { kind: "date"; pattern: string }
  /** 0 « HH:MM » · 1 « h:MM tt » · 2 « HH:MM:ss » · 3 « h:MM:ss tt » */
  | { kind: "time"; style: 0 | 1 | 2 | 3 }
  | { kind: "custom"; keystroke?: string; format?: string };

/** Acrobat's « Calcul » tab. */
export type FieldCalculation =
  { kind: "simple"; op: "SUM" | "PRD" | "AVG" | "MIN" | "MAX"; fields: string[] } | { kind: "custom"; script: string };

/** Properties shared by fields created in Elium and fields of the file being edited. */
export interface FieldProps {
  /** Tooltip (/TU), also what screen readers announce. */
  tooltip?: string;
  required?: boolean;
  readOnly?: boolean;
  /** Not shown on screen nor printed (widget flag Hidden). */
  hidden?: boolean;
  /** Shown on screen, not printed. */
  noPrint?: boolean;
  multiLine?: boolean;
  password?: boolean;
  maxLen?: number | null;
  /** Characters spread over `maxLen` boxes. */
  comb?: boolean;
  /** 0 = automatic size. */
  fontSize?: number;
  align?: "left" | "center" | "right";
  /** List items: export value and label. */
  options?: { value: string; label: string }[];
  /** A dropdown that also accepts typed text. */
  editable?: boolean;
  multiSelect?: boolean;
  /** Export value (on-state) of a checkbox / radio widget. */
  exportValue?: string;
  /** What « Réinitialiser » restores (/DV). */
  defaultValue?: FormValue;
  format?: FieldFormat;
  /** Range check (AFRange_Validate); null removes it. */
  validate?: { min?: number; max?: number } | null;
  calculate?: FieldCalculation | null;
}

/** A form field the user created in Elium. */
export interface CreatedField extends FieldProps {
  id: string;
  pageId: string;
  name: string;
  kind: FieldKind;
  rect: Rect;
  /** Tab order within the page; lower comes first. */
  tabIndex?: number;
}

/**
 * A change made in « Préparer un formulaire » to a field the FILE already has
 * (addressed by its fully qualified name, its widgets by pdf.js id « 12R »).
 */
export interface FieldEdit {
  name: string;
  deleted?: boolean;
  /** Widgets removed (one button of a group…); all of them removes the field. */
  removeWidgets?: string[];
  /** New fully qualified name. */
  rename?: string;
  /** New position of widgets: top-left, unrotated page space (like annotations). */
  rects?: Record<string, Rect>;
  /** New export value of box widgets (checkbox / radio button), by widget. */
  exportValues?: Record<string, string>;
  props?: FieldProps;
}

// ---------------------------------------------------------------------------
// Real content edits (rewriting the page's own operators)
// ---------------------------------------------------------------------------

/**
 * An edit to a paragraph of the PDF's *own* text. On export the original
 * text-showing operators for the block are removed from the content stream and
 * the new text is laid out in their place — no white box, no hidden original
 * underneath, and the result stays selectable and searchable.
 */
export interface ContentEdit {
  id: string;
  pageId: string;
  /** Block key from `core/text.groupBlocks`, stable for a given page layout. */
  blockKey: string;
  /** The text as extracted, so a stale edit can be detected and skipped. */
  original: string;
  text: string;
  rect: Rect;
  fontSize: number;
  leading: number;
  align: "left" | "center" | "right" | "justify";
  color?: string;
  /** Font resource name to re-use from the page ("F3"); null = substitute. */
  fontResource?: string | null;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  deleted?: boolean;
  /** Where the text now goes when the block was moved or resized (default: `rect`). */
  placement?: Rect;
  /** Family / weight / slant changed by the user: the original font is not reused. */
  restyled?: boolean;
  /** Text added in Elium: nothing on the page to remove. */
  isNew?: boolean;
}

/** An edit to one of the page's own images, or an image added to the page's content. */
export interface ImageEdit {
  id: string;
  pageId: string;
  /** Draw-order index of the XObject (`Do`) on the page; -1 for an added image. */
  occurrence: number;
  /** « move » only moves / resizes; « replace » may move too; « add » draws a new image. */
  action: "delete" | "replace" | "move" | "add";
  /** Replacement (or added) picture as a data URL. */
  src?: string;
  /** New frame, top-left unrotated page space (moved / resized, or where an added image goes). */
  rect?: Rect;
  /** Part of the frame left visible, as fractions of it (top-left origin): « Rogner ». */
  crop?: Rect;
}

// ---------------------------------------------------------------------------
// Bookmarks / outline
// ---------------------------------------------------------------------------

export interface Bookmark {
  id: string;
  title: string;
  /** 1-based page number in the *current* page order. */
  page: number;
  /** Vertical target within the page, page-space points from the top. */
  y?: number;
  /** Horizontal target, page-space points from the left. */
  x?: number;
  /** How the page is shown (ISO 32000 destination types); /XYZ when absent. */
  fit?: DestFit;
  /** /XYZ magnification (1 = 100 %); absent: unchanged. */
  zoom?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  children: Bookmark[];
  /** Collapsed in the sidebar (and /Count negative in the file). */
  closed?: boolean;
  /** Not a page: what the item does instead (then `page` means nothing). */
  action?: BookmarkAction;
  /**
   * Where the item sits in the file's own outline ("0.2.1"): saved, it reuses
   * that item, so what Elium does not model (actions, structure links, the
   * exact destination) is kept.
   */
  src?: string;
  /** The target was set in Elium: the file's destination or action is replaced. */
  retargeted?: boolean;
}

/** Named destinations (Acrobat's Destinations panel) as changed in Elium. */
export interface DestEdits {
  /** New destinations: a view of a page (`pageId`), as bookmarks name them. */
  added: { name: string; pageId: string; x?: number; y?: number; zoom?: number }[];
  /** Names of the file's destinations removed. */
  removed: string[];
}

/** Files attached to the document (not to a comment), as changed in Elium. */
export interface AttachmentEdits {
  added: { id: string; name: string; description?: string; mime: string; /** data: URL */ data: string }[];
  /** Keys (in the file's /EmbeddedFiles name tree) of the attachments removed. */
  removed: string[];
  /** New descriptions of the file's attachments, by key. */
  described: Record<string, string>;
}

/** How the document opens (ISO 32000: /PageMode, /PageLayout, /OpenAction, /ViewerPreferences). */
export interface InitialView {
  pageMode: "UseNone" | "UseOutlines" | "UseThumbs" | "UseAttachments" | "UseOC" | "FullScreen";
  pageLayout: "SinglePage" | "OneColumn" | "TwoColumnLeft" | "TwoColumnRight" | "TwoPageLeft" | "TwoPageRight";
  /** 1-based page it opens on. */
  openPage: number;
  /** Its magnification: a fit, or a zoom (1 = 100 %); absent: the reader's default. */
  openZoom?: "Fit" | "FitH" | "FitV" | number;
  hideToolbar?: boolean;
  hideMenubar?: boolean;
  hideWindowUI?: boolean;
  fitWindow?: boolean;
  centerWindow?: boolean;
  /** The window shows the document's title rather than its file name. */
  displayDocTitle?: boolean;
}

export type DestFit = "XYZ" | "Fit" | "FitH" | "FitV" | "FitB" | "FitBH" | "FitBV" | "FitR";

export type BookmarkAction =
  | { kind: "uri"; url: string }
  | { kind: "named"; name: string }
  /** Another file, a script, a form action…: kept as is, not run. */
  | { kind: "other"; label: string };

// ---------------------------------------------------------------------------
// Document-level settings
// ---------------------------------------------------------------------------

export interface DocMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  language?: string;
}

/** Watermark / background applied at export time. */
export interface Watermark {
  enabled: boolean;
  /** `color`: Acrobat's background — the whole page tinted, under the content. */
  mode: "text" | "image" | "color";
  text: string;
  src?: string;
  fontSize: number;
  fontFamily?: string;
  color: string;
  opacity: number;
  /** Degrees counter-clockwise. */
  angle: number;
  scale: number;
  position: "center" | "top" | "bottom" | "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
  /** Draw under the page content instead of over it. */
  behind: boolean;
  /** 1-based page range spec, empty = all pages. */
  pages: string;
}

export const DEFAULT_WATERMARK: Watermark = {
  enabled: false,
  mode: "text",
  text: "CONFIDENTIEL",
  fontSize: 56,
  color: "#e11d48",
  opacity: 0.18,
  angle: 45,
  scale: 1,
  position: "center",
  behind: false,
  pages: "",
};

/** A header/footer band. Supports the same tokens Acrobat does. */
export interface HeaderFooter {
  enabled: boolean;
  /** `{page}`, `{pages}`, `{date}`, `{time}`, `{title}`, `{author}`, `{filename}`, `{bates}`. */
  left: string;
  center: string;
  right: string;
  fontSize: number;
  fontFamily?: string;
  color: string;
  marginPt: number;
  /** 1-based page range spec, empty = all pages. */
  pages: string;
  /** The number `{page}` shows on the first page of the document (default 1). */
  startPage?: number;
}

export const emptyBand = (): HeaderFooter => ({
  enabled: false,
  left: "",
  center: "",
  right: "",
  fontSize: 9,
  color: "#334155",
  marginPt: 28,
  pages: "",
});

/** Bates (legal sequential) numbering. */
export interface Bates {
  enabled: boolean;
  prefix: string;
  suffix: string;
  start: number;
  digits: number;
  /** 1-based page range spec, empty = all pages; numbers run over these pages only. */
  pages?: string;
}

export const DEFAULT_BATES: Bates = { enabled: false, prefix: "", suffix: "", start: 1, digits: 6 };

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * The whole editable state. This is the object the undo stack snapshots and the
 * `.elium` serialiser persists (minus the source bytes, held separately).
 */
export interface PdfState {
  pages: Page[];
  annots: Annot[];
  /** Rewrites of the PDF's own text, applied to the content stream on export. */
  contentEdits: ContentEdit[];
  /** Edits to the PDF's own images. */
  imageEdits: ImageEdit[];
  /** Values keyed by fully-qualified AcroForm field name. */
  formValues: Record<string, FormValue>;
  /** Fields the user added with the form builder. */
  createdFields: CreatedField[];
  /** Changes to the file's own fields (« Préparer un formulaire »). */
  fieldEdits: FieldEdit[];
  /** null = use the PDF's own outline; an array = user-edited bookmarks. */
  bookmarks: Bookmark[] | null;
  metadata: DocMetadata;
  watermark: Watermark;
  header: HeaderFooter;
  footer: HeaderFooter;
  bates: Bates;
  /**
   * Remove the page marks the file already carries (watermarks, backgrounds,
   * headers/footers added by Elium or Acrobat) before painting the new ones —
   * Acrobat's « Supprimer ». Optional: older sessions have none.
   */
  stripMarks?: boolean;
  /**
   * Layer visibility to save as the file's default (/OCProperties /D /ON
   * /OFF), by pdf.js group id ("12R"); absent: the file's own.
   */
  ocDefaults?: Record<string, boolean>;
  /** The Initial View set in Elium (Acrobat's Propriétés › Vue initiale); absent: the file's own. */
  initialView?: InitialView;
  /** Named destinations added or removed in Elium. */
  destEdits?: DestEdits;
  /** Changes to the document's attached files (/EmbeddedFiles). */
  attachmentEdits?: AttachmentEdits;
  /** Measurement scale used by new measurement annotations. */
  measureScale: MeasureScale;
  /**
   * True when the markup the source PDF already carried was read into `annots`.
   * Export then strips the originals from the page, so a comment imported and
   * then edited is written once, not twice.
   */
  importedAnnots: boolean;
}

export function emptyState(): PdfState {
  return {
    pages: [],
    annots: [],
    contentEdits: [],
    imageEdits: [],
    formValues: {},
    createdFields: [],
    fieldEdits: [],
    bookmarks: null,
    metadata: {},
    watermark: { ...DEFAULT_WATERMARK },
    header: emptyBand(),
    footer: emptyBand(),
    bates: { ...DEFAULT_BATES },
    measureScale: { ...DEFAULT_MEASURE_SCALE },
    importedAnnots: false,
  };
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export function newId(prefix: string): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `${prefix}_${c.randomUUID().slice(0, 18)}`;
  return `${prefix}_${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * What a click on the page currently does. `select` and `hand` are navigation
 * modes; `textSelect` is the default reading mode where dragging selects text.
 */
export type Tool =
  | "select"
  | "hand"
  | "textSelect"
  | "zoomArea"
  | "snapshot"
  | AnnotKind
  | "eraser"
  | "field:text"
  | "field:checkbox"
  | "field:radio"
  | "field:dropdown"
  | "field:listbox"
  | "field:signature";

export function toolIsAnnot(t: Tool): t is AnnotKind {
  return !["select", "hand", "textSelect", "zoomArea", "snapshot", "eraser"].includes(t) && !t.startsWith("field:");
}

/** Style carried by the toolbar and applied to newly created annotations. */
export interface DraftStyle {
  color: string;
  fill: string | null;
  opacity: number;
  strokeWidth: number;
  borderStyle: BorderStyle;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: "left" | "center" | "right";
  lineStart: LineEnding;
  lineEnd: LineEnding;
  textBg: string | null;
  /** Library stamp the Tampon tool places (`model/stamps.ts` id). */
  stamp?: string;
  /** A picture stamp instead (data URL), and its height / width. */
  stampSrc?: string | null;
  stampRatio?: number;
  /** The file the « Joindre un fichier » tool places next. */
  attachFile?: AnnotFile | null;
}

export const DEFAULT_STYLE: DraftStyle = {
  color: "#e11d48",
  fill: null,
  opacity: 1,
  strokeWidth: 2,
  borderStyle: "solid",
  fontSize: 14,
  fontFamily: "Helvetica",
  bold: false,
  italic: false,
  underline: false,
  align: "left",
  lineStart: "none",
  lineEnd: "none",
  textBg: null,
};

/** Per-kind style overrides applied when a tool is picked (Acrobat defaults). */
export const KIND_STYLE: Partial<Record<AnnotKind, Partial<DraftStyle>>> = {
  highlight: { color: "#ffd400", opacity: 0.45 },
  underline: { color: "#e11d48", strokeWidth: 1.5, opacity: 1 },
  strikeout: { color: "#e11d48", strokeWidth: 1.5, opacity: 1 },
  squiggly: { color: "#16a34a", strokeWidth: 1.5, opacity: 1 },
  note: { color: "#fbbf24", opacity: 1 },
  freetext: { color: "#0f172a", fontSize: 14, opacity: 1, textBg: null },
  typewriter: { color: "#0f172a", fontSize: 12, opacity: 1, textBg: null },
  callout: { color: "#e11d48", fontSize: 12, opacity: 1, textBg: "#ffffff", lineEnd: "arrow" },
  ink: { color: "#e11d48", strokeWidth: 2, opacity: 1 },
  square: { color: "#e11d48", strokeWidth: 2, fill: null },
  circle: { color: "#e11d48", strokeWidth: 2, fill: null },
  line: { color: "#e11d48", strokeWidth: 2 },
  arrow: { color: "#e11d48", strokeWidth: 2, lineEnd: "arrow" },
  polygon: { color: "#e11d48", strokeWidth: 2, fill: null },
  polyline: { color: "#e11d48", strokeWidth: 2 },
  cloud: { color: "#e11d48", strokeWidth: 2, fill: null, borderStyle: "cloudy" },
  whiteout: { color: "#ffffff", fill: "#ffffff", opacity: 1, strokeWidth: 0 },
  redact: { color: "#000000", fill: "#000000", opacity: 1, strokeWidth: 0 },
  distance: { color: "#2563eb", strokeWidth: 1.5, fontSize: 10, lineStart: "arrow", lineEnd: "arrow" },
  perimeter: { color: "#2563eb", strokeWidth: 1.5, fontSize: 10 },
  area: { color: "#2563eb", strokeWidth: 1.5, fontSize: 10, fill: "#2563eb", opacity: 0.15 },
  stamp: { opacity: 1 },
  image: { opacity: 1 },
  signature: { opacity: 1 },
  link: { color: "#2563eb", strokeWidth: 1 },
};

export function styleForKind(base: DraftStyle, kind: AnnotKind): DraftStyle {
  return { ...base, ...(KIND_STYLE[kind] ?? {}) };
}

/** Highlighter swatches offered in the toolbar (Acrobat's palette). */
export const HIGHLIGHT_SWATCHES = ["#ffd400", "#7ee787", "#7cc4ff", "#ff9ecd", "#ffab5e", "#c4a7ff"];
export const INK_SWATCHES = ["#e11d48", "#f97316", "#eab308", "#16a34a", "#2563eb", "#7c3aed", "#0f172a", "#ffffff"];
