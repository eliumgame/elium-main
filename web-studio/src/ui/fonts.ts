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

export interface FontDef {
  name: string; // display name + key
  css: string;  // CSS font stack for the editors
  pdf: "helvetica" | "times" | "courier"; // closest standard family for PDF export
}

export const BUILTIN_FONTS: FontDef[] = [
  { name: "Arial", css: "Arial, Helvetica, sans-serif", pdf: "helvetica" },
  { name: "Helvetica", css: "Helvetica, Arial, sans-serif", pdf: "helvetica" },
  { name: "Inter", css: "Inter, system-ui, sans-serif", pdf: "helvetica" },
  { name: "Calibri", css: "Calibri, Candara, Segoe, sans-serif", pdf: "helvetica" },
  { name: "Verdana", css: "Verdana, Geneva, sans-serif", pdf: "helvetica" },
  { name: "Tahoma", css: "Tahoma, Geneva, sans-serif", pdf: "helvetica" },
  { name: "Trebuchet MS", css: "'Trebuchet MS', Helvetica, sans-serif", pdf: "helvetica" },
  { name: "Comic Sans MS", css: "'Comic Sans MS', cursive", pdf: "helvetica" },
  { name: "Impact", css: "Impact, Charcoal, sans-serif", pdf: "helvetica" },
  { name: "Times New Roman", css: "'Times New Roman', Times, serif", pdf: "times" },
  { name: "Georgia", css: "Georgia, 'Times New Roman', serif", pdf: "times" },
  { name: "Garamond", css: "Garamond, 'Times New Roman', serif", pdf: "times" },
  { name: "Cambria", css: "Cambria, Georgia, serif", pdf: "times" },
  { name: "Courier New", css: "'Courier New', Courier, monospace", pdf: "courier" },
];

export const DEFAULT_FONT = BUILTIN_FONTS[0].name;

// Fonts imported by the user this session (name → file bytes). Embedded into
// exports; registered as a FontFace so they also render in the editors.
const customFonts = new Map<string, Uint8Array>();

export function registerCustomFont(name: string, bytes: Uint8Array): void {
  customFonts.set(name, bytes);
  try {
    const ff = new FontFace(name, bytes as unknown as ArrayBuffer);
    void ff.load().then((loaded) => (globalThis as unknown as { document?: Document }).document?.fonts?.add(loaded)).catch(() => {});
  } catch { /* FontFace unavailable (non-DOM env) */ }
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
