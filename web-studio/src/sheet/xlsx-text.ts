/** Petits utilitaires de texte OOXML partagés par l'import DOM (xlsx-import.ts) et le lecteur en flux (xlsx-stream.ts). */

/** Décode les échappements OOXML `_xHHHH_` (ex. `_x000D_`) ; `_x005F_` désigne un « _ » littéral. */
export function decodeOoxmlEscapes(s: string): string {
  if (!s.includes("_x")) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Excel >= 2010 écrit les fonctions récentes avec un préfixe de compatibilité (`_xlfn.`, `_xlws.`) : on le retire. */
export function stripXlfnPrefixes(formula: string): string {
  return formula.replace(/\b_xlfn\.(?:_xlws\.)?|\b_xlws\./g, "");
}
