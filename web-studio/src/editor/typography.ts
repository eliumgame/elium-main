/**
 * Typography choices offered by the Documents UI: font families, sizes, line
 * heights and code-block languages.
 *
 * These live in their own module on purpose. They used to sit in
 * `extensions.ts`, which every extension imports — so an extension needing the
 * size list (the character-formatting one, for its grow/shrink steps) created an
 * import CYCLE and read the list before it was initialised. Plain data belongs
 * outside the module that assembles the extensions.
 */
import { BUILTIN_FONTS } from "../ui/fonts";

// Unified with the app-wide font registry (same families everywhere + imports).
export const FONT_FAMILIES = [
  { label: "Par défaut", value: "" },
  ...BUILTIN_FONTS.map((f) => ({ label: f.name, value: f.css })),
];

export const FONT_SIZES = [
  "8px", "9px", "10px", "11px", "12px", "14px", "16px", "18px", "20px",
  "24px", "28px", "32px", "40px", "48px", "64px",
];

export const LINE_HEIGHTS = [
  { label: "Simple", value: "1.3" },
  { label: "1,5", value: "1.6" },
  { label: "Double", value: "2.1" },
];

export const CODE_LANGUAGES = [
  "plaintext",
  "javascript",
  "typescript",
  "python",
  "json",
  "bash",
  "html",
  "css",
  "sql",
  "markdown",
];
