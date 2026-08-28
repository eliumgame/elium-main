/**
 * Ingestion `.elium` / `.docx` — convertit l'arbre ProseMirror/TipTap (JSON
 * plat relu depuis le disque, aucun éditeur vivant) en `ParagraphModel[]` +
 * `ImageModel[]` pour le Détecteur. Les deux formats source traversent le
 * MÊME schéma ProseMirror (voir `editor/extensions.ts` et la relecture DOCX
 * dans `format/docx.ts`) : il n'y a donc rien de spécifique au format à
 * brancher ici — `sourceFormat` est conservé pour la parité avec
 * `fromPdf.ts` et pour les appelants/signaux qui voudraient savoir quel
 * pipeline a produit l'arbre.
 *
 * Vocabulaire de nœuds/marques vérifié sur les extensions réelles plutôt que
 * deviné : gras/italique/souligné sont leurs propres marques, `textStyle`
 * porte couleur/police/taille (`editor/extensions.ts`, `editor/charFormat.ts`
 * — la taille est stockée en px CSS, ex. "16px"). Le niveau de titre vit sur
 * `heading.attrs.level` (StarterKit). Les éléments de liste sont des nœuds
 * `listItem`/`taskItem` qui enveloppent un `paragraph`/`heading` (voir le
 * `ListBuilder` de `format/docx.ts`). Les images sont soit `image` (insertion
 * fraîche via `@tiptap/extension-image`, attrs.src/alt seulement) soit
 * `figure` (import DOCX et images légendées, `editor/customExtensions.ts`,
 * attrs.src/alt/align/width — `width` y est une chaîne CSS comme "60%", pas
 * un pixel, d'où le filtrage numérique strict plus bas).
 */
import type { ProseMirrorNode } from "../../format/types";
import type { ImageModel, ParagraphModel, RunFormat } from "../types";

export interface ProseMirrorIngestResult {
  paragraphs: ParagraphModel[];
  images: ImageModel[];
}

export function documentModelFromProseMirrorDoc(
  doc: ProseMirrorNode,
  sourceFormat: "elium" | "docx",
): ProseMirrorIngestResult {
  void sourceFormat;
  const state: WalkState = { paragraphs: [], images: [] };
  collectBlock(doc, state, false);
  return { paragraphs: state.paragraphs, images: state.images };
}

interface WalkState {
  paragraphs: ParagraphModel[];
  images: ImageModel[];
  /** Index du dernier paragraphe émis, dans l'ordre du document — sert de
   *  "paragraphe conteneur le plus proche" pour une image qui est un bloc
   *  frère d'un paragraphe plutôt que littéralement imbriquée dedans. */
  lastParagraphIndex?: number;
}

const LIST_CONTAINER_TYPES = new Set(["listItem", "taskItem"]);
const IMAGE_NODE_TYPES = new Set(["image", "figure"]);

function collectBlock(node: ProseMirrorNode, state: WalkState, inListItem: boolean): void {
  if (node.type === "paragraph" || node.type === "heading") {
    const { text, runs } = flattenInline(node.content ?? []);
    const paragraph: ParagraphModel = { index: state.paragraphs.length, text, runs };
    if (node.type === "heading") paragraph.heading = headingLevel(node.attrs);
    if (inListItem) paragraph.listItem = true;
    state.paragraphs.push(paragraph);
    state.lastParagraphIndex = paragraph.index;
    return;
  }

  if (IMAGE_NODE_TYPES.has(node.type)) {
    const image = decodeImageNode(node, state.images.length, state.lastParagraphIndex);
    if (image) state.images.push(image);
    return; // la légende d'une figure n'est pas remontée comme du texte courant
  }

  const nested = inListItem || LIST_CONTAINER_TYPES.has(node.type);
  for (const child of node.content ?? []) collectBlock(child, state, nested);
}

function headingLevel(attrs: Record<string, unknown> | undefined): number {
  const n = Math.round(Number(attrs?.level));
  return Number.isFinite(n) && n >= 1 ? Math.min(6, n) : 1;
}

function flattenInline(content: ProseMirrorNode[]): { text: string; runs: RunFormat[] } {
  let text = "";
  const runs: RunFormat[] = [];
  for (const child of content) {
    if (child.type === "text" && child.text) {
      text += child.text;
      runs.push(runFormat(child.text, child.marks ?? []));
    } else if (child.type === "hardBreak") {
      text += "\n";
      runs.push(runFormat("\n", child.marks ?? []));
    }
    // Les autres atomes en ligne (taquets, appels de note, signets, champs de
    // fusion…) ne portent pas de texte en langue naturelle propre : ignorés.
  }
  return { text, runs };
}

function runFormat(text: string, marks: NonNullable<ProseMirrorNode["marks"]>): RunFormat {
  const run: RunFormat = { text };
  for (const mark of marks) {
    if (mark.type === "bold") run.bold = true;
    else if (mark.type === "italic") run.italic = true;
    else if (mark.type === "underline") run.underline = true;
    else if (mark.type === "textStyle") applyTextStyle(run, mark.attrs ?? {});
  }
  return run;
}

function applyTextStyle(run: RunFormat, attrs: Record<string, unknown>): void {
  const family =
    typeof attrs.fontFamily === "string" ? attrs.fontFamily.split(",")[0].replace(/['"]/g, "").trim() : "";
  if (family) run.fontFamily = family;
  // Stocké en px CSS (editor/typography.ts's FONT_SIZES) ; RunFormat veut des
  // pt, et la conversion px→pt maison du code est ×0.75 (format/docx.ts).
  const px = parseFloat(String(attrs.fontSize ?? ""));
  if (Number.isFinite(px) && px > 0) run.fontSize = Math.round(px * 0.75 * 100) / 100;
  if (typeof attrs.color === "string" && attrs.color) run.color = attrs.color;
}

function decodeImageNode(
  node: ProseMirrorNode,
  index: number,
  paragraphIndex: number | undefined,
): ImageModel | null {
  const src = node.attrs?.src;
  if (typeof src !== "string") return null;
  const decoded = decodeDataUrl(src);
  if (!decoded || !decoded.bytes.length) return null;
  const image: ImageModel = { index, bytes: decoded.bytes, mime: decoded.mime };
  const width = numericAttr(node.attrs?.width);
  const height = numericAttr(node.attrs?.height);
  if (width != null) image.width = width;
  if (height != null) image.height = height;
  if (paragraphIndex != null) image.paragraphIndex = paragraphIndex;
  return image;
}

function numericAttr(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function decodeDataUrl(src: string): { mime: string; bytes: Uint8Array } | null {
  if (!src.startsWith("data:")) return null;
  const marker = ";base64,";
  const at = src.indexOf(marker);
  if (at === -1) return null;
  const mime = src.slice(5, at).split(";")[0].trim().toLowerCase() || "application/octet-stream";
  try {
    return { mime, bytes: base64ToBytes(src.slice(at + marker.length)) };
  } catch {
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}
