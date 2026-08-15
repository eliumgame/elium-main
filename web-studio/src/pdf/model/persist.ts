/**
 * Persisting a PDF editing session inside a sealed/encrypted `.elium`.
 *
 * The envelope carries the untouched source bytes plus the whole editable
 * state, so re-opening restores the exact session — markup, comment threads,
 * page order, form values, redaction marks still pending, bookmarks — and the
 * document remains signable and sealable as one unit.
 *
 * `v1` files (the previous PDF module) are migrated on read: the old flat
 * annotation shapes become real annotations, and the old line-level text edits
 * become the white-cover + text-box pair they used to be baked into, so a
 * migrated document renders exactly as it did before.
 */

import { quadFromRect } from "../core/coords";
import type { Annot, PdfState } from "./types";
import { emptyState, newId } from "./types";

// ---------------------------------------------------------------------------
// base64 (chunk-safe: a PDF is routinely several megabytes)
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
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

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface PdfFile {
  v: 2;
  name: string;
  /** base64 of the ORIGINAL pdf bytes — edits are always re-applied on top. */
  pdf: string;
  state: PdfState;
  /** Imported .ttf/.otf fonts referenced by the markup (name → base64). */
  fonts?: Record<string, string>;
  /** Signatures/initials the user drew, so they are offered again next time. */
  signatures?: string[];
  /** Password the source PDF was opened with, when the user asked to remember. */
  sourcePassword?: string;
}

export function serialize(
  name: string,
  bytes: Uint8Array,
  state: PdfState,
  opts: { fonts?: Record<string, string>; signatures?: string[]; sourcePassword?: string } = {},
): PdfFile {
  return {
    v: 2,
    name,
    pdf: bytesToBase64(bytes),
    state,
    ...(opts.fonts && Object.keys(opts.fonts).length ? { fonts: opts.fonts } : {}),
    ...(opts.signatures?.length ? { signatures: opts.signatures } : {}),
    ...(opts.sourcePassword ? { sourcePassword: opts.sourcePassword } : {}),
  };
}

export interface LoadedFile {
  name: string;
  bytes: Uint8Array;
  state: PdfState;
  fonts: Record<string, string>;
  signatures: string[];
  sourcePassword?: string;
}

/** Read either envelope version into the current model. */
export function deserialize(raw: unknown): LoadedFile {
  const o = (raw ?? {}) as Record<string, unknown>;
  const version = typeof o.v === "number" ? o.v : 1;
  const name = typeof o.name === "string" ? o.name : "document.pdf";
  const bytes = base64ToBytes(typeof o.pdf === "string" ? o.pdf : "");
  const fonts = (o.fonts ?? {}) as Record<string, string>;
  const signatures = Array.isArray(o.signatures) ? (o.signatures as string[]) : [];
  const sourcePassword = typeof o.sourcePassword === "string" ? o.sourcePassword : undefined;

  if (version >= 2 && o.state && typeof o.state === "object") {
    return { name, bytes, state: normalise(o.state as Partial<PdfState>), fonts, signatures, sourcePassword };
  }
  return { name, bytes, state: migrateV1(o), fonts, signatures, sourcePassword };
}

/** Fill in fields added after a file was written, so old v2 files keep loading. */
function normalise(s: Partial<PdfState>): PdfState {
  const base = emptyState();
  return {
    ...base,
    ...s,
    pages: s.pages ?? [],
    annots: (s.annots ?? []).map((a) => ({ ...a, replies: a.replies ?? [] })),
    contentEdits: s.contentEdits ?? [],
    imageEdits: s.imageEdits ?? [],
    formValues: s.formValues ?? {},
    createdFields: s.createdFields ?? [],
    bookmarks: s.bookmarks ?? null,
    metadata: s.metadata ?? {},
    watermark: { ...base.watermark, ...(s.watermark ?? {}) },
    header: { ...base.header, ...(s.header ?? {}) },
    footer: { ...base.footer, ...(s.footer ?? {}) },
    bates: { ...base.bates, ...(s.bates ?? {}) },
    measureScale: { ...base.measureScale, ...(s.measureScale ?? {}) },
    importedAnnots: s.importedAnnots ?? false,
  };
}

// ---------------------------------------------------------------------------
// v1 migration
// ---------------------------------------------------------------------------

interface V1Anno {
  id: string;
  type: "text" | "highlight" | "draw" | "rect" | "ellipse" | "line" | "image" | "whiteout";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  strokeWidth: number;
  fontSize: number;
  text?: string;
  points?: { x: number; y: number }[];
  src?: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface V1EditedText {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  text: string;
  original: string;
  color?: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
}

const V1_KIND: Record<V1Anno["type"], Annot["kind"]> = {
  text: "freetext",
  highlight: "highlight",
  draw: "ink",
  rect: "square",
  ellipse: "circle",
  line: "line",
  image: "image",
  whiteout: "whiteout",
};

function migrateV1(o: Record<string, unknown>): PdfState {
  const state = emptyState();
  const when = new Date(0).toISOString();
  const author = "Import";

  const rawPages = Array.isArray(o.pages) ? (o.pages as { id: string; from: number | null; rotate?: number }[]) : [];
  state.pages = rawPages.map((p) => ({
    id: p.id || newId("pg"),
    from: p.from ?? null,
    rotate: ((p.rotate ?? 0) % 360) as 0 | 90 | 180 | 270,
  }));

  const base = (a: V1Anno) => ({
    id: a.id || newId("an"),
    rect: { x: a.x, y: a.y, w: a.w, h: a.h },
    color: a.color || "#e11d48",
    opacity: 1,
    strokeWidth: a.strokeWidth ?? 2,
    author,
    createdAt: when,
    modifiedAt: when,
    replies: [],
  });

  const annos = (o.annos ?? {}) as Record<string, V1Anno[]>;
  for (const [pageId, list] of Object.entries(annos)) {
    for (const a of list ?? []) {
      const kind = V1_KIND[a.type];
      if (!kind) continue;
      const annot: Annot = {
        ...base(a),
        pageId,
        kind,
        ...(kind === "highlight"
          ? { quads: [quadFromRect({ x: a.x, y: a.y, w: a.w, h: a.h })], color: "#fde047", opacity: 0.4 }
          : {}),
        ...(kind === "ink" && a.points?.length ? { paths: [a.points.map((p) => ({ ...p }))] } : {}),
        ...(kind === "whiteout" ? { fill: "#ffffff", strokeWidth: 0 } : {}),
        ...(a.text !== undefined ? { text: a.text } : {}),
        ...(a.src !== undefined ? { src: a.src } : {}),
        ...(a.fontSize ? { fontSize: a.fontSize } : {}),
        ...(a.fontFamily ? { fontFamily: a.fontFamily } : {}),
        ...(a.bold ? { bold: true } : {}),
        ...(a.italic ? { italic: true } : {}),
        ...(a.underline ? { underline: true } : {}),
      };
      state.annots.push(annot);
    }
  }

  // v1 baked a changed line as "white cover + redrawn text" at export time.
  // Reproduce that pair so the migrated document looks identical, and stays
  // editable with the new tools.
  const edits = (o.textEdits ?? {}) as Record<string, V1EditedText[]>;
  for (const [pageId, list] of Object.entries(edits)) {
    for (const e of list ?? []) {
      if (e.text === e.original) continue;
      state.annots.push({
        id: newId("an"),
        pageId,
        kind: "whiteout",
        rect: { x: e.x, y: e.y, w: e.w, h: e.h + 2 },
        color: "#ffffff",
        fill: "#ffffff",
        opacity: 1,
        strokeWidth: 0,
        author,
        createdAt: when,
        modifiedAt: when,
        replies: [],
      });
      state.annots.push({
        id: newId("an"),
        pageId,
        kind: "freetext",
        rect: { x: e.x, y: e.y, w: e.w, h: e.h },
        color: e.color ?? "#000000",
        opacity: 1,
        strokeWidth: 0,
        text: e.text,
        fontSize: e.fontSize,
        fontFamily: e.fontFamily,
        bold: e.bold,
        italic: e.italic,
        textBg: null,
        author,
        createdAt: when,
        modifiedAt: when,
        replies: [],
      });
    }
  }

  const formValues = (o.formValues ?? {}) as Record<string, string | boolean>;
  state.formValues = { ...formValues };
  return state;
}
