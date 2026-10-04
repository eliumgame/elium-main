/**
 * Formules ⇄ fichier XLSX : ce qu'Excel exige dans `<f>` et que l'interface masque.
 *  - fonctions récentes préfixées `_xlfn.` (et `_xlfn._xlws.` pour FILTER/SORT) : sans préfixe, Excel affiche #NOM? ;
 *  - références structurées : `[@Col]` s'écrit `[[#This Row],[Col]]`.
 * Le préfixe est retiré à l'import (xlsx-import.ts : stripXlfnPrefixes).
 */
import { structuredForFile } from "./tables";

const XLFN = new Set([
  "CONCAT",
  "TEXTJOIN",
  "IFS",
  "SWITCH",
  "XLOOKUP",
  "XMATCH",
  "UNIQUE",
  "SEQUENCE",
  "RANDARRAY",
  "SORTBY",
  "TEXTSPLIT",
  "TAKE",
  "DROP",
  "VSTACK",
  "HSTACK",
  "CHOOSECOLS",
  "CHOOSEROWS",
  "WRAPROWS",
  "WRAPCOLS",
  "TOCOL",
  "TOROW",
  "EXPAND",
]);
const XLFN_WS = new Set(["FILTER", "SORT"]);

/** Préfixe les fonctions récentes hors des chaînes entre guillemets. */
export function prefixNewFunctions(formula: string): string {
  let out = "";
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < formula.length && formula[j] !== '"') j++;
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch) && (i === 0 || !/[A-Za-z0-9_.]/.test(formula[i - 1]!))) {
      let j = i + 1;
      while (j < formula.length && /[A-Za-z0-9_.]/.test(formula[j]!)) j++;
      const word = formula.slice(i, j);
      const up = word.toUpperCase();
      if (formula[j] === "(" && XLFN.has(up)) out += `_xlfn.${up}`;
      else if (formula[j] === "(" && XLFN_WS.has(up)) out += `_xlfn._xlws.${up}`;
      else out += word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Corps de formule (sans « = ») tel qu'écrit dans le fichier. */
export function formulaForFile(body: string): string {
  return prefixNewFunctions(structuredForFile(body));
}
