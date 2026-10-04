/**
 * Plan des Réglages : catégories et sections (données pures), et recherche dans
 * les réglages. Chaque section déclare son titre et ses mots-clés (traduits),
 * ce qui permet de la retrouver par un synonyme (« police », « mot de passe »,
 * « port »…) quelle que soit sa catégorie.
 */
import { foldText, queryTerms } from "../../workspace/search/text";
import type { MessageKey } from "../../i18n";

export type CategoryId =
  | "general"
  | "appearance"
  | "editing"
  | "fonts"
  | "shortcuts"
  | "workspace"
  | "security"
  | "updates"
  | "privacy"
  | "about";

export interface Category {
  id: CategoryId;
  labelKey: MessageKey;
}

export const CATEGORIES: Category[] = [
  { id: "general", labelKey: "settings.cat.general" },
  { id: "appearance", labelKey: "settings.cat.appearance" },
  { id: "editing", labelKey: "settings.cat.editing" },
  { id: "fonts", labelKey: "settings.cat.fonts" },
  { id: "shortcuts", labelKey: "settings.cat.shortcuts" },
  { id: "workspace", labelKey: "settings.cat.workspace" },
  { id: "security", labelKey: "settings.cat.security" },
  { id: "updates", labelKey: "settings.cat.updates" },
  { id: "privacy", labelKey: "settings.cat.privacy" },
  { id: "about", labelKey: "settings.cat.about" },
];

export type SectionId =
  | "language"
  | "startup"
  | "theme"
  | "density"
  | "edit_defaults"
  | "edit_autosave"
  | "edit_spell"
  | "fonts_manager"
  | "shortcuts_list"
  | "ws_backup"
  | "ws_restore"
  | "ws_trash"
  | "ws_index"
  | "sec_identity"
  | "sec_recipient"
  | "sec_trust"
  | "sec_vault"
  | "upd_versions"
  | "upd_port"
  | "priv_clear"
  | "priv_log"
  | "about_app";

export interface SectionMeta {
  id: SectionId;
  category: CategoryId;
  titleKey: MessageKey;
  /** Synonymes (une phrase de mots séparés par des espaces) pour la recherche. */
  keywordsKey: MessageKey;
}

export const SECTIONS: SectionMeta[] = [
  { id: "language", category: "general", titleKey: "settings.sec.language", keywordsKey: "settings.kw.language" },
  { id: "startup", category: "general", titleKey: "settings.sec.startup", keywordsKey: "settings.kw.startup" },
  { id: "theme", category: "appearance", titleKey: "settings.sec.theme", keywordsKey: "settings.kw.theme" },
  { id: "density", category: "appearance", titleKey: "settings.sec.density", keywordsKey: "settings.kw.density" },
  {
    id: "edit_defaults",
    category: "editing",
    titleKey: "settings.sec.edit_defaults",
    keywordsKey: "settings.kw.edit_defaults",
  },
  {
    id: "edit_autosave",
    category: "editing",
    titleKey: "settings.sec.edit_autosave",
    keywordsKey: "settings.kw.edit_autosave",
  },
  { id: "edit_spell", category: "editing", titleKey: "settings.sec.edit_spell", keywordsKey: "settings.kw.edit_spell" },
  {
    id: "fonts_manager",
    category: "fonts",
    titleKey: "settings.sec.fonts_manager",
    keywordsKey: "settings.kw.fonts_manager",
  },
  {
    id: "shortcuts_list",
    category: "shortcuts",
    titleKey: "settings.sec.shortcuts_list",
    keywordsKey: "settings.kw.shortcuts_list",
  },
  { id: "ws_backup", category: "workspace", titleKey: "settings.sec.ws_backup", keywordsKey: "settings.kw.ws_backup" },
  {
    id: "ws_restore",
    category: "workspace",
    titleKey: "settings.sec.ws_restore",
    keywordsKey: "settings.kw.ws_restore",
  },
  { id: "ws_trash", category: "workspace", titleKey: "settings.sec.ws_trash", keywordsKey: "settings.kw.ws_trash" },
  { id: "ws_index", category: "workspace", titleKey: "settings.sec.ws_index", keywordsKey: "settings.kw.ws_index" },
  {
    id: "sec_identity",
    category: "security",
    titleKey: "settings.sec.sec_identity",
    keywordsKey: "settings.kw.sec_identity",
  },
  {
    id: "sec_recipient",
    category: "security",
    titleKey: "settings.sec.sec_recipient",
    keywordsKey: "settings.kw.sec_recipient",
  },
  { id: "sec_trust", category: "security", titleKey: "settings.sec.sec_trust", keywordsKey: "settings.kw.sec_trust" },
  { id: "sec_vault", category: "security", titleKey: "settings.sec.sec_vault", keywordsKey: "settings.kw.sec_vault" },
  {
    id: "upd_versions",
    category: "updates",
    titleKey: "settings.sec.upd_versions",
    keywordsKey: "settings.kw.upd_versions",
  },
  { id: "upd_port", category: "updates", titleKey: "settings.sec.upd_port", keywordsKey: "settings.kw.upd_port" },
  { id: "priv_clear", category: "privacy", titleKey: "settings.sec.priv_clear", keywordsKey: "settings.kw.priv_clear" },
  { id: "priv_log", category: "privacy", titleKey: "settings.sec.priv_log", keywordsKey: "settings.kw.priv_log" },
  { id: "about_app", category: "about", titleKey: "settings.sec.about_app", keywordsKey: "settings.kw.about_app" },
];

export function sectionsOf(category: CategoryId): SectionMeta[] {
  return SECTIONS.filter((s) => s.category === category);
}

/**
 * Sections correspondant à la recherche (titre, mots-clés ou nom de catégorie),
 * meilleures d'abord. Requête vide : aucune (l'appelant affiche la catégorie active).
 * `tr` traduit une clé dans la langue active.
 */
export function searchSections(query: string, tr: (key: MessageKey) => string): SectionMeta[] {
  const words = queryTerms(query);
  if (words.length === 0) return [];
  const catLabel = new Map(CATEGORIES.map((c) => [c.id, foldText(tr(c.labelKey))]));
  const scored: { s: SectionMeta; score: number; order: number }[] = [];
  SECTIONS.forEach((s, order) => {
    const title = foldText(tr(s.titleKey));
    const kw = foldText(tr(s.keywordsKey));
    const cat = catLabel.get(s.category) ?? "";
    let score = 0;
    // Tous les mots doivent figurer quelque part (sous-chaîne : « port » ne doit pas trouver « typographie »).
    for (const w of words) {
      let best = 0;
      if (title.includes(w)) best = title.startsWith(w) ? 100 : 80;
      else if (kw.includes(w)) best = 40;
      else if (cat.includes(w)) best = 20;
      if (best === 0) return;
      score += best;
    }
    scored.push({ s, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((x) => x.s);
}
