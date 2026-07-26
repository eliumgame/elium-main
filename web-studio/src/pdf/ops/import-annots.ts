/**
 * Reading the markup a PDF already carries into Elium's own model.
 *
 * Without this, comments made in Acrobat would only be *painted* by pdf.js:
 * visible, but not listed in the comment pane, not repliable, not editable and
 * silently dropped on export. Importing them makes a review started elsewhere
 * a first-class Elium review — which is the whole point of interoperability.
 */

import type { Pt, Quad, Rect } from "../core/coords";
import { rectOfPoints, rectOfQuads } from "../core/coords";
import type { Annot, AnnotKind, BorderStyle, LineEnding, Reply, ReviewStatus } from "../model/types";
import { newId } from "../model/types";

/** The shape pdf.js hands back from `page.getAnnotations()`. */
export interface RawAnnotation {
  id?: string;
  subtype?: string;
  rect?: number[];
  color?: Uint8ClampedArray | number[] | null;
  interiorColor?: Uint8ClampedArray | number[] | null;
  opacity?: number;
  quadPoints?: Float32Array | number[] | null;
  inkLists?: (Float32Array | number[])[];
  vertices?: Float32Array | number[] | null;
  lineCoordinates?: number[] | null;
  lineEndings?: string[];
  contentsObj?: { str?: string };
  titleObj?: { str?: string };
  subject?: string;
  creationDate?: string | null;
  modificationDate?: string | null;
  borderStyle?: { width?: number; style?: number; dashArray?: number[] };
  annotationFlags?: number;
  name?: string;
  inReplyTo?: string;
  replyType?: string;
  fieldType?: string;
  it?: string;
  defaultAppearanceData?: { fontSize?: number; fontColor?: Uint8ClampedArray | number[] };
  url?: string;
  dest?: unknown;
}

const KIND: Record<string, AnnotKind> = {
  Highlight: "highlight",
  Underline: "underline",
  StrikeOut: "strikeout",
  Squiggly: "squiggly",
  Text: "note",
  FreeText: "freetext",
  Ink: "ink",
  Square: "square",
  Circle: "circle",
  Line: "line",
  Polygon: "polygon",
  PolyLine: "polyline",
  Stamp: "stamp",
};

const LINE_ENDING: Record<string, LineEnding> = {
  None: "none",
  ClosedArrow: "arrow",
  OpenArrow: "openArrow",
  Circle: "circle",
  Square: "square",
  Diamond: "diamond",
  Butt: "butt",
  Slash: "slash",
};

const BORDER: Record<number, BorderStyle> = { 1: "solid", 2: "dashed", 3: "solid", 4: "solid", 5: "solid" };

function hex(c: Uint8ClampedArray | number[] | null | undefined, fallback: string): string {
  if (!c || c.length < 3) return fallback;
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** `D:YYYYMMDDHHmmSS…` → ISO. Falls back to the epoch so sorting stays stable. */
function parsePdfDate(raw: string | null | undefined): string {
  if (!raw) return new Date(0).toISOString();
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw.trim());
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
  }
  const [, y, mo = "01", da = "01", h = "00", mi = "00", s = "00"] = m;
  const d = new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

const flip = (pageHeight: number) => (x: number, y: number): Pt => ({ x, y: pageHeight - y });

function rectFrom(raw: number[] | undefined, pageHeight: number): Rect {
  if (!raw || raw.length < 4) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.min(raw[0], raw[2]);
  const x2 = Math.max(raw[0], raw[2]);
  const y1 = Math.min(raw[1], raw[3]);
  const y2 = Math.max(raw[1], raw[3]);
  return { x: x1, y: pageHeight - y2, w: x2 - x1, h: y2 - y1 };
}

/** `/QuadPoints` is UL, UR, LL, LR — reorder into our reading-order quads. */
function quadsFrom(raw: Float32Array | number[] | null | undefined, pageHeight: number): Quad[] {
  if (!raw || raw.length < 8) return [];
  const f = flip(pageHeight);
  const out: Quad[] = [];
  for (let i = 0; i + 7 < raw.length; i += 8) {
    out.push([
      f(raw[i], raw[i + 1]),       // upper-left
      f(raw[i + 2], raw[i + 3]),   // upper-right
      f(raw[i + 6], raw[i + 7]),   // lower-right
      f(raw[i + 4], raw[i + 5]),   // lower-left
    ]);
  }
  return out;
}

function pointsFrom(raw: Float32Array | number[] | null | undefined, pageHeight: number): Pt[] {
  if (!raw) return [];
  const f = flip(pageHeight);
  const out: Pt[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push(f(raw[i], raw[i + 1]));
  return out;
}

export interface ImportResult {
  annots: Annot[];
  /** Annotations we could see but not model (widgets, media, 3D…). */
  skipped: number;
}

/**
 * Convert one page's annotations. `pageId` is the model page they belong to and
 * `pageHeight` its unrotated height, used to flip into page space.
 */
export function importPageAnnots(
  raw: readonly RawAnnotation[],
  pageId: string,
  pageHeight: number,
  fallbackAuthor: string,
): ImportResult {
  const annots: Annot[] = [];
  const replies: { parent: string; reply: Reply }[] = [];
  let skipped = 0;

  for (const a of raw) {
    const subtype = a.subtype ?? "";
    // Widgets are form fields (handled by the form layer) and popups are just
    // the little windows attached to a parent comment.
    if (subtype === "Widget" || subtype === "Popup" || subtype === "Link") continue;
    const kind = KIND[subtype];
    if (!kind) { skipped++; continue; }

    const created = parsePdfDate(a.creationDate);
    const modified = parsePdfDate(a.modificationDate ?? a.creationDate);
    const contents = a.contentsObj?.str ?? "";
    const author = a.titleObj?.str || fallbackAuthor;

    // A reply carries `/IRT`; attach it to its parent instead of showing a
    // second icon on the page.
    if (a.inReplyTo) {
      replies.push({
        parent: a.inReplyTo,
        reply: { id: a.id || newId("rp"), author, text: contents, createdAt: created },
      });
      continue;
    }

    const annot: Annot = {
      id: a.id || newId("an"),
      pageId,
      kind,
      rect: rectFrom(a.rect, pageHeight),
      color: hex(a.color, kind === "highlight" ? "#ffd400" : "#e11d48"),
      fill: a.interiorColor ? hex(a.interiorColor, "#ffffff") : null,
      opacity: typeof a.opacity === "number" ? a.opacity : 1,
      strokeWidth: a.borderStyle?.width ?? 1.5,
      borderStyle: BORDER[a.borderStyle?.style ?? 1] ?? "solid",
      author,
      subject: a.subject || undefined,
      contents: contents || undefined,
      createdAt: created,
      modifiedAt: modified,
      status: "none" as ReviewStatus,
      replies: [],
      // Flag bit 8 (value 128) is "Locked"; bit 2 (value 2) is "Hidden".
      locked: !!((a.annotationFlags ?? 0) & 128),
      hidden: !!((a.annotationFlags ?? 0) & 2),
    };

    switch (kind) {
      case "highlight":
      case "underline":
      case "strikeout":
      case "squiggly": {
        const quads = quadsFrom(a.quadPoints, pageHeight);
        if (quads.length) {
          annot.quads = quads;
          annot.rect = rectOfQuads(quads);
        }
        if (kind === "highlight" && typeof a.opacity !== "number") annot.opacity = 0.4;
        break;
      }
      case "ink": {
        const paths = (a.inkLists ?? []).map((list) => pointsFrom(list, pageHeight)).filter((p) => p.length);
        if (paths.length) {
          annot.paths = paths;
          annot.rect = rectOfPoints(paths.flat());
        }
        break;
      }
      case "line": {
        const l = a.lineCoordinates;
        if (l && l.length >= 4) {
          const f = flip(pageHeight);
          annot.paths = [[f(l[0], l[1]), f(l[2], l[3])]];
        }
        annot.lineStart = LINE_ENDING[a.lineEndings?.[0] ?? "None"] ?? "none";
        annot.lineEnd = LINE_ENDING[a.lineEndings?.[1] ?? "None"] ?? "none";
        if (annot.lineEnd !== "none" && annot.lineStart === "none") annot.kind = "arrow";
        if (a.it === "LineDimension") annot.kind = "distance";
        break;
      }
      case "polygon":
      case "polyline": {
        const pts = pointsFrom(a.vertices, pageHeight);
        if (pts.length) {
          annot.paths = [pts];
          annot.rect = rectOfPoints(pts);
        }
        if (a.it === "PolygonDimension") annot.kind = "area";
        if (a.it === "PolyLineDimension") annot.kind = "perimeter";
        break;
      }
      case "freetext": {
        annot.text = contents;
        annot.contents = undefined;
        annot.fontSize = a.defaultAppearanceData?.fontSize || 12;
        annot.color = hex(a.defaultAppearanceData?.fontColor, "#0f172a");
        annot.textBg = a.color ? hex(a.color, "#ffffff") : null;
        annot.strokeWidth = a.borderStyle?.width ?? 0;
        if (a.it === "FreeTextCallout") annot.kind = "callout";
        break;
      }
      case "note":
        annot.rect = { ...annot.rect, w: 20, h: 20 };
        break;
      case "stamp":
        // The stamp's own appearance stream is what pdf.js paints; we keep the
        // box and its metadata so it can be moved, commented and re-exported.
        annot.stampLabel = a.name || a.subject || "TAMPON";
        break;
      default:
        break;
    }

    annots.push(annot);
  }

  for (const { parent, reply } of replies) {
    const target = annots.find((a) => a.id === parent);
    if (target) target.replies = [...(target.replies ?? []), reply];
    else skipped++;
  }

  return { annots, skipped };
}

/** True when a page carries markup worth importing (cheap pre-check). */
export function hasImportableAnnots(raw: readonly RawAnnotation[]): boolean {
  return raw.some((a) => a.subtype && KIND[a.subtype]);
}

/** Subtypes that were imported into the model and must not be written twice. */
const IMPORTED_SUBTYPES = new Set([...Object.keys(KIND), "Popup"]);

/**
 * Drop the markup the model now owns from a page's `/Annots`, leaving form
 * widgets and links alone. Called at export time when `importedAnnots` is set,
 * so an imported-then-edited comment appears once in the output.
 */
export async function stripImportedAnnots(page: import("pdf-lib").PDFPage): Promise<number> {
  const { PDFArray, PDFDict, PDFName, PDFRef } = await import("pdf-lib");
  const annots = page.node.Annots();
  if (!(annots instanceof PDFArray)) return 0;
  let removed = 0;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const ref = annots.get(i);
    const dict = annots.lookup(i);
    if (!(dict instanceof PDFDict)) continue;
    const sub = dict.lookup(PDFName.of("Subtype"));
    const name = sub instanceof PDFName ? sub.asString().replace(/^\//, "") : "";
    if (!IMPORTED_SUBTYPES.has(name)) continue;
    annots.remove(i);
    if (ref instanceof PDFRef) page.doc.context.delete(ref);
    removed++;
  }
  return removed;
}
