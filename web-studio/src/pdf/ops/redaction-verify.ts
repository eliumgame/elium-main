/**
 * Rapport de vérification de caviardage : « aucune donnée sous le noir ».
 * Après application, on relit le texte du PDF RÉSULTANT (extrait de nouveau,
 * pas celui du modèle en mémoire) et on cherche chaque texte caviardé. La
 * recherche ignore casse, accents, espaces et ponctuation, pour retrouver une
 * donnée même coupée sur deux lignes ou avec un autre espacement.
 */

export interface RedactionVerification {
  ok: boolean;
  checked: number;
  /** Textes encore lisibles dans le fichier, avec les pages concernées (1-based). */
  leaks: { text: string; pages: number[] }[];
  /** Textes trop courts pour être vérifiés sans fausse alerte. */
  skipped: string[];
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

const MIN_CHARS = 3;

export function verifyRedaction(pageTexts: readonly string[], redactedTexts: readonly string[]): RedactionVerification {
  const pages = pageTexts.map(fold);
  const leaks: RedactionVerification["leaks"] = [];
  const skipped: string[] = [];
  let checked = 0;
  for (const text of new Set(redactedTexts.map((t) => t.trim()).filter(Boolean))) {
    const needle = fold(text);
    if (needle.length < MIN_CHARS) {
      skipped.push(text);
      continue;
    }
    checked++;
    const hit = pages.flatMap((p, i) => (p.includes(needle) ? [i + 1] : []));
    if (hit.length) leaks.push({ text, pages: hit });
  }
  return { ok: leaks.length === 0, checked, leaks, skipped };
}

/** Lignes du rapport affiché à l'utilisateur. */
export function describeVerification(v: RedactionVerification): string[] {
  const lines: string[] = [];
  if (v.ok)
    lines.push(
      `Aucune donnée sous le noir : ${v.checked} texte(s) caviardé(s) introuvable(s) dans le fichier enregistré.`,
    );
  for (const l of v.leaks) {
    lines.push(`ATTENTION : « ${l.text} » reste lisible (page${l.pages.length > 1 ? "s" : ""} ${l.pages.join(", ")}).`);
  }
  if (v.skipped.length) {
    lines.push(
      `${v.skipped.length} texte(s) trop court(s) pour être vérifié(s) automatiquement : contrôle visuel conseillé.`,
    );
  }
  lines.push("Cette vérification porte sur le texte du fichier ; une image contenant du texte n'est pas lue.");
  return lines;
}
