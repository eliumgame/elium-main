// Documentation Elium — source unique de la page in-app (/documentation).
// Le contenu vit dans `sections/*.md` (un fichier par section, préfixe numérique = ordre
// d'affichage). Éditer ces fichiers, pas celui-ci : il ne fait que les assembler.
// Le sommaire de la page est généré à partir des titres `##` / `###` (aucune table des
// matières à tenir à la main).

const modules = import.meta.glob<string>("./sections/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Sections dans l'ordre de leur nom de fichier (00-, 01-, 04-01-…). */
export const DOC_SECTION_FILES: string[] = Object.keys(modules).sort();

export const DOCUMENTATION_MD: string = DOC_SECTION_FILES.map((k) => modules[k]!.trim()).join("\n\n") + "\n";
