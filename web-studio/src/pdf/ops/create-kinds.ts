/**
 * The files « Créer un PDF depuis un fichier » accepts — kept apart from the
 * converter (`create-from-file.ts`, which pulls in every importer) so the
 * workspace and the Combine dialog can check a file without loading it.
 */

export type CreateSourceKind = "docx" | "xlsx" | "pptx" | "html" | "text" | "markdown" | "elium";

/** What the « Créer depuis un fichier… » picker and the Combine dialog accept. */
export const CREATE_FROM_FILE_ACCEPT = ".docx,.xlsx,.pptx,.html,.htm,.txt,.md,.markdown,.elium";

const KIND_BY_EXT: Record<string, CreateSourceKind> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  html: "html",
  htm: "html",
  xhtml: "html",
  txt: "text",
  text: "text",
  md: "markdown",
  markdown: "markdown",
  elium: "elium",
};

/** The kind of a file a PDF can be made of, from its name; null for anything else. */
export function createSourceKind(name: string): CreateSourceKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";
  return KIND_BY_EXT[ext] ?? null;
}
