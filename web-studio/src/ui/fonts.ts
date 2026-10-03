/**
 * Shared font registry for the WHOLE app (Documents, Tableur, Présentations, PDF).
 *
 * One source of truth so the same families — and the user's imported fonts —
 * are offered everywhere. This module is DOM/CSS only (no pdf-lib), so it stays
 * out of the heavy PDF chunk; `pdf/fonts.ts` consumes it for embedding.
 *
 * Built-ins are common system fonts (rendered via CSS). For PDF export, each
 * maps to the closest of the 14 standard PDF fonts (`pdf`); imported .ttf/.otf
 * fonts are embedded exactly and render live via the FontFace API.
 */

import catalog from "./font-catalog.json";

type BundledCategory = "sans" | "serif" | "mono" | "display" | "hand";
interface BundledFont {
  id: string;
  name: string;
  category: BundledCategory;
}
const METRIC_SUBSTITUTES = new Set(["Arimo", "Tinos", "Cousine", "Carlito", "Caladea", "Gelasio"]);

export interface FontDef {
  name: string; // display name + key
  css: string; // CSS font stack for the editors
  pdf: "helvetica" | "times" | "courier"; // closest standard family for PDF export
}

/**
 * Familles système courantes. Chaque pile se termine par un équivalent
 * EMBARQUÉ de même métrique (Arimo≈Arial, Carlito≈Calibri, Tinos≈Times,
 * Caladea≈Cambria, Cousine≈Courier, Gelasio≈Georgia) : sur un poste sans la
 * police système (Linux, macOS sans Office…), la mise en page ne bouge pas.
 */
const SYSTEM_FONTS: FontDef[] = [
  { name: "Arial", css: "Arial, Arimo, Helvetica, sans-serif", pdf: "helvetica" },
  { name: "Helvetica", css: "Helvetica, Arimo, Arial, sans-serif", pdf: "helvetica" },
  { name: "Calibri", css: "Calibri, Carlito, Candara, Segoe, sans-serif", pdf: "helvetica" },
  { name: "Verdana", css: "Verdana, Geneva, 'DM Sans', sans-serif", pdf: "helvetica" },
  { name: "Tahoma", css: "Tahoma, Geneva, 'Open Sans', sans-serif", pdf: "helvetica" },
  { name: "Trebuchet MS", css: "'Trebuchet MS', 'Fira Sans', Helvetica, sans-serif", pdf: "helvetica" },
  { name: "Comic Sans MS", css: "'Comic Sans MS', Kalam, cursive", pdf: "helvetica" },
  { name: "Impact", css: "Impact, Charcoal, Anton, sans-serif", pdf: "helvetica" },
  { name: "Times New Roman", css: "'Times New Roman', Tinos, Times, serif", pdf: "times" },
  { name: "Georgia", css: "Georgia, Gelasio, 'Times New Roman', serif", pdf: "times" },
  { name: "Garamond", css: "Garamond, 'EB Garamond', 'Times New Roman', serif", pdf: "times" },
  { name: "Cambria", css: "Cambria, Caladea, Georgia, serif", pdf: "times" },
  { name: "Courier New", css: "'Courier New', Cousine, Courier, monospace", pdf: "courier" },
];

const GENERIC: Record<BundledCategory, { stack: string; pdf: FontDef["pdf"] }> = {
  sans: { stack: "sans-serif", pdf: "helvetica" },
  serif: { stack: "serif", pdf: "times" },
  mono: { stack: "monospace", pdf: "courier" },
  display: { stack: "sans-serif", pdf: "helvetica" },
  hand: { stack: "cursive", pdf: "helvetica" },
};

/** Polices embarquées dans l'application (voir scripts/gen-fonts.mjs). */
const BUNDLED_FONTS: FontDef[] = (catalog as BundledFont[])
  // Arimo/Tinos/Cousine/Carlito/Caladea/Gelasio servent de substituts métriques
  // aux polices système ci-dessus ; les lister aussi serait un doublon.
  .filter((f) => !METRIC_SUBSTITUTES.has(f.name))
  .map((f) => ({
    name: f.name,
    css: `'${f.name}', ${GENERIC[f.category].stack}`,
    pdf: GENERIC[f.category].pdf,
  }));

export const BUILTIN_FONTS: FontDef[] = [...SYSTEM_FONTS, ...BUNDLED_FONTS];

export const DEFAULT_FONT = BUILTIN_FONTS[0].name;

// Fonts imported by the user (name → file bytes). Embedded into the `.elium`
// itself (see format/embedded-fonts.ts) and into exports; registered as a
// FontFace so they render in the editors.
const customFonts = new Map<string, Uint8Array>();
/** Original filename per family, so the package keeps the real extension. */
const customFontFiles = new Map<string, string>();

export function registerCustomFont(name: string, bytes: Uint8Array, filename?: string): void {
  customFonts.set(name, bytes);
  // Default to .ttf only when the caller has no filename to offer.
  customFontFiles.set(name, filename ?? `${name}.ttf`);
  try {
    const ff = new FontFace(name, bytes as unknown as ArrayBuffer);
    void ff
      .load()
      .then((loaded) => (globalThis as unknown as { document?: Document }).document?.fonts?.add(loaded))
      .catch(() => {});
  } catch {
    /* FontFace unavailable (non-DOM env) */
  }
}

/** Filename a family was imported under (drives the embedded MIME/format). */
export function customFontFilename(name: string): string {
  return customFontFiles.get(name) ?? `${name}.ttf`;
}

/**
 * Re-register every font carried by a freshly opened document, so the text
 * renders in the typeface it was written in even on a machine where that font is
 * not installed. Idempotent: a family already registered is left alone.
 */
export function registerEmbeddedFonts(fonts: { family: string; filename: string; bytes: Uint8Array }[]): void {
  for (const f of fonts) {
    if (customFonts.has(f.family)) continue;
    registerCustomFont(f.family, f.bytes, f.filename);
  }
}

export function isCustomFont(name: string): boolean {
  return customFonts.has(name);
}

export function getCustomFont(name: string): Uint8Array | undefined {
  return customFonts.get(name);
}

export function customFontNames(): string[] {
  return [...customFonts.keys()];
}

export function allFontNames(): string[] {
  return [...BUILTIN_FONTS.map((f) => f.name), ...customFonts.keys()];
}

/** CSS font stack for rendering `name` (built-in stack, custom face, or default). */
export function fontCss(name: string | undefined): string {
  const b = BUILTIN_FONTS.find((f) => f.name === name);
  if (b) return b.css;
  if (name && customFonts.has(name)) return `'${name.replace(/'/g, "")}', sans-serif`;
  return BUILTIN_FONTS[0].css;
}

/** Closest standard PDF family for `name` (for export embedding). */
export function pdfFamilyOf(name: string | undefined): "helvetica" | "times" | "courier" {
  return BUILTIN_FONTS.find((f) => f.name === name)?.pdf ?? "helvetica";
}

/**
 * Every imported font the registry can hand to the package writer. Built-in
 * families are system fonts — there is no binary to embed and no need to.
 */
export function embeddableFonts(): { family: string; filename: string; bytes: Uint8Array }[] {
  return [...customFonts.entries()].map(([family, bytes]) => ({
    family,
    filename: customFontFilename(family),
    bytes,
  }));
}
