/**
 * Document themes (Word calls this "Thèmes") — a minimal, one-click version:
 * a few named colour/font presets that re-tint the built-in heading and
 * accent styles, nothing more.
 *
 * Deliberately NOT the full Office theme model (no separate colour/font
 * "schemes" applied independently, no custom user themes): applying one just
 * WRITES concrete overrides for a handful of style ids straight into the
 * document's own `styles` (see `styles.ts` — a document redefining a built-in
 * style is already how per-document formatting works), so every consumer
 * (the editor, HTML/DOCX export, the Styles manager) keeps working with zero
 * changes — nothing needs to know a "theme" exists. `EliumDocumentModel.theme`
 * only remembers which one is active, for the dialog itself.
 */
import { findStyle, mergeStyles, type DocStyle } from "./styles";
import type { EliumDocStyle } from "../format/types";

export interface DocTheme {
  id: string;
  name: string;
  /** Swatch shown in the picker, and the colour applied to headings/accents. */
  accent: string;
  /** Optional heading typeface; body text is left alone (Normal is untouched). */
  headingFont?: string;
}

export const DOC_THEMES: DocTheme[] = [
  { id: "elium", name: "Elium (par défaut)", accent: "#1d4ed8" },
  { id: "ardoise", name: "Ardoise", accent: "#334155", headingFont: "Georgia, serif" },
  { id: "emeraude", name: "Émeraude", accent: "#047857" },
  { id: "ambre", name: "Ambre", accent: "#b45309", headingFont: "Georgia, serif" },
  { id: "aubergine", name: "Aubergine", accent: "#7c3aed" },
];

/** Paragraph styles whose heading colour follows the theme's accent. */
const HEADING_IDS = ["Titre1", "Titre2", "Titre3", "Titre4"];
/** Other built-ins that lean on the SAME accent colour (Word's "highlight"
 *  styles) — kept in sync so the two never visibly disagree. */
const ACCENT_IDS = ["CitationIntense", "EmphaseIntense", "ReferenceIntense"];

export function findTheme(id: string | null | undefined): DocTheme | null {
  return DOC_THEMES.find((t) => t.id === id) ?? null;
}

/**
 * The concrete style overrides a theme implies, based on each style's CURRENT
 * definition in the document — built-in defaults, folded with whatever the
 * user already redefined by hand via the Styles manager (`currentStyles`) —
 * so a theme only ever changes colour/font (the properties it actually owns)
 * and never clobbers an unrelated, manually-set property like font size,
 * weight or spacing on "Titre 2" or "Citation intense".
 */
export function themeStyleOverrides(currentStyles: EliumDocStyle[] | undefined, theme: DocTheme): DocStyle[] {
  // mergeStyles/DocStyle and EliumDocStyle are the same shape on the wire
  // (EliumDocStyle just types char/para loosely for the file format) — see
  // format/types.ts.
  const effective = mergeStyles(currentStyles as DocStyle[] | undefined);
  const out: DocStyle[] = [];
  for (const id of HEADING_IDS) {
    const base = findStyle(effective, id);
    if (!base) continue;
    out.push({
      ...base,
      char: { ...base.char, color: theme.accent, ...(theme.headingFont ? { fontFamily: theme.headingFont } : {}) },
    });
  }
  for (const id of ACCENT_IDS) {
    const base = findStyle(effective, id);
    if (!base) continue;
    out.push({ ...base, char: { ...base.char, color: theme.accent } });
  }
  return out;
}

/**
 * The document's new `styles` array after applying `theme`: the theme's
 * overrides are upserted by id into the document's EXISTING custom styles, so
 * anything the user redefined that a theme does not touch (e.g. "Corps de
 * texte") survives untouched, and switching themes again cleanly replaces the
 * previous theme's values rather than piling up.
 */
export function applyDocTheme(currentStyles: EliumDocStyle[] | undefined, theme: DocTheme): EliumDocStyle[] {
  const out = new Map<string, EliumDocStyle>();
  for (const s of currentStyles ?? []) out.set(s.id, s);
  for (const s of themeStyleOverrides(currentStyles, theme)) out.set(s.id, s as EliumDocStyle);
  return [...out.values()];
}
