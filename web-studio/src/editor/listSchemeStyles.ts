/**
 * Injects the generated multilevel-list CSS once per page.
 *
 * The rules are DERIVED from the scheme table (`listSchemes.ts`) rather than
 * hand-written, so the screen, the print/PDF output and the standalone HTML
 * export can never drift from each other — they all render from the same source.
 */
import { schemesCss } from "./listSchemes";

const STYLE_ID = "elium-list-schemes";

export function ensureListSchemeStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = schemesCss(".elium-prose");
  document.head.appendChild(style);
}
