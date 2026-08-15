/**
 * Injects the generated multilevel-list CSS once per page.
 *
 * The rules are DERIVED from the scheme table (`listSchemes.ts`) rather than
 * hand-written, so the screen, the print/PDF output and the standalone HTML
 * export can never drift from each other — they all render from the same source.
 */
import { schemesCss } from "./listSchemes";
import { dropCapStyleSheet } from "./ornamentExtensions";
import { tableGridlinesCss, tableStylesCss } from "./tableStyles";
import { proofingCss } from "./proofingExtension";

const STYLE_ID = "elium-list-schemes";

export function ensureListSchemeStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // La lettrine passe par `::first-letter`, qui ne peut pas être stylé en ligne :
  // sa règle doit donc vivre dans une feuille, comme les schémas de liste.
  style.textContent =
    schemesCss(".elium-prose") +
    dropCapStyleSheet() +
    tableStylesCss() +
    // Le quadrillage des tableaux : déduit de la même table de styles, donc
    // toujours d'accord avec les filets qu'ils dessinent (ou pas).
    tableGridlinesCss() +
    proofingCss();
  document.head.appendChild(style);
}
