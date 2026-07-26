/**
 * Embedded fonts — the binary of a font travels INSIDE the `.elium`.
 *
 * Until now only the font NAME survived a save, so a document opened on another
 * machine silently fell back to a different typeface. The bytes are now stored as
 * ordinary content-addressed package resources (`kind: "font"`), which means they
 * are covered by the integrity hash and the seal like any other resource, and are
 * encrypted with the document when a protected profile is used.
 *
 * This module is pure: it decides WHICH fonts a document needs and turns the
 * bytes into `@font-face` CSS. Registering them with the browser and reading them
 * out of the package happen in `ui/fonts.ts` and `format/elium-package.ts`.
 */

import { sha256Hex } from "./canonical";
import type { EliumFile, EliumResource, ProseMirrorNode } from "./types";

/** Font formats accepted for embedding, by lowercase extension. */
export const FONT_MIME: Record<string, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

export const FONT_ACCEPT = ".ttf,.otf,.woff,.woff2";

/** `format(...)` hint for `@font-face`, per extension. */
const FONT_FACE_FORMAT: Record<string, string> = {
  ttf: "truetype",
  otf: "opentype",
  woff: "woff",
  woff2: "woff2",
};

export function fontExtension(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return ext in FONT_MIME ? ext : null;
}

/** Strip the extension to get a usable family name. */
export function fontNameFromFilename(filename: string): string {
  return filename.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/, "").trim() || "Police importée";
}

/**
 * Family names actually used by the document: every `fontFamily` seen on a
 * `textStyle` mark. The CSS value can be a stack (`'Nom', sans-serif`), so the
 * first family is taken and unquoted.
 */
export function usedFontFamilies(doc: ProseMirrorNode): string[] {
  const out = new Set<string>();
  const walk = (node: ProseMirrorNode) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== "textStyle") continue;
      const raw = mark.attrs?.fontFamily;
      const first = String(raw ?? "").split(",")[0]?.replace(/['"]/g, "").trim();
      if (first) out.add(first);
    }
    (node.content ?? []).forEach(walk);
  };
  walk(doc);
  return [...out];
}

export interface FontResourceMeta {
  /** Resource id (content hash), as stored in the package. */
  id: string;
  /** Family name to register the face under. */
  family: string;
  /** Lowercase extension, driving the MIME type and the `format()` hint. */
  ext: string;
}

/** The font resources of a package, in index order. */
export function fontResources(index: EliumResource[]): FontResourceMeta[] {
  return index
    .filter((r) => r.kind === "font")
    .map((r) => ({
      id: r.id,
      family: r.name.replace(/\.[^.]+$/, ""),
      ext: (r.name.toLowerCase().split(".").pop() ?? "ttf") in FONT_MIME
        ? (r.name.toLowerCase().split(".").pop() as string)
        : "ttf",
    }));
}

/**
 * Which embedded fonts are still referenced by the document? Saving drops the
 * rest, so deleting the last run in a font stops carrying its binary around.
 */
export function neededFontIds(doc: ProseMirrorNode, index: EliumResource[]): Set<string> {
  const used = new Set(usedFontFamilies(doc).map((f) => f.toLowerCase()));
  const out = new Set<string>();
  for (const font of fontResources(index)) {
    if (used.has(font.family.toLowerCase())) out.add(font.id);
  }
  return out;
}

/** A font the caller can supply for embedding (bytes live in the font registry). */
export interface EmbeddableFont {
  family: string;
  filename: string;
  bytes: Uint8Array;
}

/**
 * Bring a file's font resources in line with what its document actually uses:
 * fonts referenced by the text are added (content-addressed, so re-saving the
 * same font does not duplicate it), fonts no longer referenced are dropped.
 *
 * Returns the same file object when nothing changes, so a save of an unchanged
 * document does not perturb the integrity hash.
 */
export async function syncEmbeddedFonts(file: EliumFile, available: EmbeddableFont[]): Promise<EliumFile> {
  const used = new Set(usedFontFamilies(file.document.doc).map((f) => f.toLowerCase()));
  const keep = new Map<string, { res: EliumResource; bytes: Uint8Array }>();

  // Keep the font resources still referenced by the text.
  for (const res of file.resourceIndex) {
    if (res.kind !== "font") continue;
    const family = res.name.replace(/\.[^.]+$/, "");
    const bytes = file.resources.get(res.id);
    if (bytes && used.has(family.toLowerCase())) keep.set(res.id, { res, bytes });
  }

  // Add the ones the registry can supply and the package does not carry yet.
  for (const font of available) {
    if (!used.has(font.family.toLowerCase())) continue;
    const ext = fontExtension(font.filename) ?? "ttf";
    const id = await sha256Hex(font.bytes);
    if (keep.has(id)) continue;
    keep.set(id, {
      res: {
        id,
        name: `${font.family}.${ext}`,
        mime: FONT_MIME[ext] ?? "font/ttf",
        size: font.bytes.byteLength,
        kind: "font",
      },
      bytes: font.bytes,
    });
  }

  const others = file.resourceIndex.filter((r) => r.kind !== "font");
  const nextIndex = [...others, ...[...keep.values()].map((k) => k.res)];
  const sameFonts =
    nextIndex.length === file.resourceIndex.length &&
    nextIndex.every((r, i) => file.resourceIndex[i]?.id === r.id);
  if (sameFonts) return file;

  const resources = new Map(file.resources);
  // Drop font bytes that are no longer indexed.
  for (const res of file.resourceIndex) {
    if (res.kind === "font" && !keep.has(res.id)) resources.delete(res.id);
  }
  for (const [id, k] of keep) resources.set(id, k.bytes);

  return { ...file, resourceIndex: nextIndex, resources };
}

const cssEscapeFamily = (name: string) => name.replace(/["\\]/g, "");

/**
 * `@font-face` rules from font bytes, as data URLs so the result is a single
 * self-contained stylesheet — used by the editor at open time and by the
 * standalone HTML/PDF export, where no separate file can be shipped.
 */
export function fontFaceCss(
  fonts: { family: string; ext: string; base64: string }[],
): string {
  return fonts
    .map(
      (f) =>
        `@font-face{font-family:"${cssEscapeFamily(f.family)}";` +
        `src:url(data:${FONT_MIME[f.ext] ?? "font/ttf"};base64,${f.base64}) format("${FONT_FACE_FORMAT[f.ext] ?? "truetype"}");` +
        `font-display:swap}`,
    )
    .join("\n");
}
