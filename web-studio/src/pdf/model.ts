/** PDF editor model: annotations (overlay markup) and page ordering. */

export type Tool = "select" | "text" | "highlight" | "draw" | "rect" | "ellipse" | "line" | "image" | "whiteout";
export type AnnoType = Exclude<Tool, "select">;

/**
 * An overlay annotation. Geometry is stored in the page's *unrotated* display
 * coordinates at scale 1 (top-left origin, PDF points), so it converts cleanly
 * both to screen pixels (× current scale) and to pdf-lib's bottom-left space
 * (y → pageHeight − y) on save.
 */
export interface Anno {
  id: string;
  type: AnnoType;
  x: number; y: number; w: number; h: number;
  color: string;        // text / stroke / highlight colour (hex)
  strokeWidth: number;
  fontSize: number;     // text size in points
  text?: string;        // text annotation content
  points?: { x: number; y: number }[]; // freehand path (scale-1 coords)
  src?: string;         // image data URL
  // Rich text (text annotations): font family + Word-like styling.
  fontFamily?: string;  // built-in name or imported font name
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/**
 * An editable line of EXISTING PDF text (Adobe-style "Edit text" mode). Geometry
 * is the original line's bounding box in scale-1 top-left page points. When
 * `text` differs from `original`, export covers the original line (white) and
 * redraws `text` at the same baseline.
 */
export interface EditedText {
  key: string; // stable per page (line index)
  x: number; y: number; w: number; h: number;
  fontSize: number;
  text: string;
  original: string;
  color?: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
}

/** A page in the (editable) output order. `from` indexes the source doc; null = inserted blank. */
export interface PageRef {
  id: string;
  from: number | null;
  /** Extra clockwise rotation applied by the user (0/90/180/270), on top of the source page's own /Rotate. */
  rotate?: number;
}

/**
 * Serializable PDF document, persisted inside a sealed/encrypted `.elium`
 * (marker node `eliumPdf`): the original PDF (base64) plus the editable page
 * order and overlay annotations. Re-opening rebuilds the exact editing state,
 * so an annotated PDF is durable, re-editable, signable and sealable.
 */
export interface PdfDoc {
  v: 1;
  name: string;
  pdf: string; // base64 of the original PDF bytes
  pages: PageRef[];
  annos: Record<string, Anno[]>;
  /** Edited lines of the original text, per page (Adobe-style text editing). */
  textEdits?: Record<string, EditedText[]>;
  /** Imported fonts referenced by text annotations (name → base64 ttf/otf), so they survive a round-trip. */
  fonts?: Record<string, string>;
}

export function newId(prefix: string): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `${prefix}-${c.randomUUID()}`;
  return `${prefix}-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

/** Chunk-safe base64 of binary (the PDF can be megabytes). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Build the serializable document from the live editor state. `fonts` carries any imported font bytes referenced by text. */
export function serializePdfDoc(
  name: string,
  bytes: Uint8Array,
  pages: PageRef[],
  annos: Record<string, Anno[]>,
  textEdits?: Record<string, EditedText[]>,
  fonts?: Record<string, string>,
): PdfDoc {
  // Persist only lines actually changed, to keep the payload small.
  const edits: Record<string, EditedText[]> = {};
  for (const [pid, list] of Object.entries(textEdits ?? {})) {
    const changed = list.filter((e) => e.text !== e.original);
    if (changed.length) edits[pid] = changed;
  }
  return {
    v: 1, name, pdf: bytesToBase64(bytes), pages, annos,
    ...(Object.keys(edits).length ? { textEdits: edits } : {}),
    ...(fonts && Object.keys(fonts).length ? { fonts } : {}),
  };
}

export const TOOL_DEFAULTS = { color: "#e11d48", strokeWidth: 2, fontSize: 16 };

/** Highlight uses a translucent fill; whiteout an opaque one. */
export const HIGHLIGHT_COLOR = "#fde047";
export const WHITEOUT_COLOR = "#ffffff";
