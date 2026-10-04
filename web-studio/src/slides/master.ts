/**
 * Masque et dispositions des diapositives (calcul PUR) : modèle par défaut, application d'une
 * disposition à une diapositive (espaces réservés titre / corps / pied de page / numéro),
 * réinitialisation d'une diapositive, propagation d'un changement du masque à toutes les diapositives.
 *
 * Un élément issu d'un espace réservé porte `ph` (titre, corps, pied, numéro) : c'est ce qui lui permet
 * de suivre la géométrie et le style de sa disposition, et d'être exporté comme vrai placeholder PPTX.
 */
import {
  newElementId,
  type Deck,
  type LayoutPlaceholder,
  type PlaceholderKind,
  type Slide,
  type SlideElement,
  type SlideLayoutDef,
  type SlideMaster,
} from "./model";

export const SLIDE_NUMBER_TOKEN = "‹#›";

const ph = (id: string, kind: PlaceholderKind, x: number, y: number, w: number, h: number, fontSize: number, align: LayoutPlaceholder["align"], valign: LayoutPlaceholder["valign"], bold = false): LayoutPlaceholder => ({
  id,
  kind,
  x,
  y,
  w,
  h,
  fontSize,
  align,
  valign,
  ...(bold ? { bold } : {}),
});
const footer = (): LayoutPlaceholder => ph("ftr", "footer", 6, 92, 60, 5, 13, "left", "middle");
const number = (): LayoutPlaceholder => ph("num", "slideNumber", 88, 92, 6, 5, 13, "right", "middle");

export function defaultMaster(): SlideMaster {
  const layouts: SlideLayoutDef[] = [
    { id: "lay-titre", name: "Diapositive de titre", placeholders: [ph("t", "title", 8, 30, 84, 22, 54, "center", "bottom", true), ph("b", "body", 12, 54, 76, 14, 26, "center", "top"), footer(), number()] },
    { id: "lay-contenu", name: "Titre et contenu", placeholders: [ph("t", "title", 7, 6, 86, 15, 40, "left", "middle", true), ph("b", "body", 7, 24, 86, 66, 24, "left", "top"), footer(), number()] },
    { id: "lay-section", name: "En-tête de section", placeholders: [ph("t", "title", 8, 36, 84, 24, 46, "left", "bottom", true), ph("b", "body", 8, 62, 84, 14, 24, "left", "top"), footer(), number()] },
    { id: "lay-deux", name: "Deux contenus", placeholders: [ph("t", "title", 7, 6, 86, 15, 40, "left", "middle", true), ph("b1", "body", 7, 24, 41, 66, 22, "left", "top"), ph("b2", "body", 52, 24, 41, 66, 22, "left", "top"), footer(), number()] },
    { id: "lay-titre-seul", name: "Titre seul", placeholders: [ph("t", "title", 7, 6, 86, 15, 40, "left", "middle", true), footer(), number()] },
    { id: "lay-vierge", name: "Vierge", placeholders: [footer(), number()] },
  ];
  return {
    name: "Élium",
    fontHeading: "Calibri Light",
    fontBody: "Calibri",
    colorTitle: "#0f172a",
    colorBody: "#334155",
    colorAccent: "#2563eb",
    background: "#ffffff",
    footerText: "",
    showSlideNumber: true,
    layouts,
  };
}

/** Texte d'invite d'un espace réservé vide (visible seulement dans l'éditeur tant qu'il n'est pas rempli). */
export const PLACEHOLDER_PROMPT: Record<PlaceholderKind, string> = {
  title: "Cliquez pour ajouter un titre",
  body: "Cliquez pour ajouter du texte",
  footer: "",
  slideNumber: SLIDE_NUMBER_TOKEN,
};

const layoutOf = (m: SlideMaster, id: string | undefined): SlideLayoutDef | undefined => m.layouts.find((l) => l.id === id);

/** Style de texte d'un espace réservé, déduit du masque (polices, couleurs) et de la disposition. */
export function placeholderStyle(m: SlideMaster, p: LayoutPlaceholder): Partial<SlideElement> {
  const isTitle = p.kind === "title";
  return {
    fontSize: p.fontSize,
    fontFamily: isTitle ? m.fontHeading : m.fontBody,
    color: p.kind === "footer" || p.kind === "slideNumber" ? m.colorBody : isTitle ? m.colorTitle : m.colorBody,
    align: p.align,
    valign: p.valign,
  };
}

const stripTags = (h: string | undefined): string => (h ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
const isEmptyPh = (e: SlideElement): boolean => !stripTags(e.html) || stripTags(e.html) === PLACEHOLDER_PROMPT[e.ph ?? "body"];

/** Espace réservé encore vide (texte d'invite seulement) : visible dans l'éditeur, jamais projeté ni exporté. */
export const isPromptOnly = (e: SlideElement): boolean => !!e.ph && e.type === "text" && isEmptyPh(e) && e.ph !== "slideNumber" && e.ph !== "footer";

/** Élément texte neuf pour un espace réservé. */
function newPlaceholderElement(m: SlideMaster, p: LayoutPlaceholder): SlideElement | null {
  let html: string;
  if (p.kind === "footer") {
    if (!m.footerText.trim()) return null;
    html = `<p>${m.footerText}</p>`;
  } else if (p.kind === "slideNumber") {
    if (m.showSlideNumber === false) return null;
    html = `<p>${SLIDE_NUMBER_TOKEN}</p>`;
  } else html = `<p>${PLACEHOLDER_PROMPT[p.kind]}</p>`;
  return {
    id: newElementId(),
    type: "text",
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    rotation: 0,
    opacity: 1,
    ph: p.kind,
    html,
    ...placeholderStyle(m, p),
    ...(p.bold ? {} : {}),
  };
}

/**
 * Applique une disposition : les éléments-espaces réservés existants prennent la géométrie et le style
 * de la disposition (contenu conservé), les espaces manquants sont créés, les espaces en trop vides sont retirés
 * et ceux qui contiennent du texte deviennent des éléments ordinaires.
 */
export function applyLayout(slide: Slide, m: SlideMaster, layoutId: string): Slide {
  const lay = layoutOf(m, layoutId);
  if (!lay) return slide;
  const els = slide.elements ?? [];
  const used = new Set<string>();
  const out: SlideElement[] = [];
  // 1) éléments non-espaces réservés conservés tels quels, à leur place
  const phEls = els.filter((e) => e.ph);
  const claim = (kind: PlaceholderKind): SlideElement | undefined => {
    const e = phEls.find((x) => x.ph === kind && !used.has(x.id));
    if (e) used.add(e.id);
    return e;
  };
  const placed: SlideElement[] = [];
  for (const p of lay.placeholders) {
    const ex = claim(p.kind);
    if (ex) {
      let html = ex.html;
      // pied et numéro suivent le masque
      if (p.kind === "footer") html = m.footerText.trim() ? `<p>${m.footerText}</p>` : "";
      if (p.kind === "slideNumber") html = m.showSlideNumber === false ? "" : `<p>${SLIDE_NUMBER_TOKEN}</p>`;
      if ((p.kind === "footer" || p.kind === "slideNumber") && !stripTags(html)) continue; // masqué par le masque
      placed.push({ ...ex, x: p.x, y: p.y, w: p.w, h: p.h, rotation: 0, ...placeholderStyle(m, p), html });
    } else {
      const created = newPlaceholderElement(m, p);
      if (created) placed.push(created);
    }
  }
  // espaces réservés restants : texte → éléments ordinaires, vide → retirés
  const leftovers = phEls.filter((e) => !used.has(e.id) && !isEmptyPh(e)).map((e) => ({ ...e, ph: undefined }));
  // ordre : éléments libres d'origine (z-order conservé), espaces réservés en dessous
  const free = els.filter((e) => !e.ph);
  out.push(...placed, ...leftovers, ...free);
  return { ...slide, layoutId, elements: out };
}

/** Remet les espaces réservés de la diapositive dans l'état de sa disposition (géométrie, polices, couleurs). */
export function resetSlide(slide: Slide, m: SlideMaster): Slide {
  const id = slide.layoutId && layoutOf(m, slide.layoutId) ? slide.layoutId : undefined;
  return id ? applyLayout(slide, m, id) : slide;
}

/** Répercute le masque (polices, couleurs, pied de page, numéro, géométrie des dispositions) sur toutes les diapositives liées. */
export function applyMasterToDeck(deck: Deck, m: SlideMaster): Deck {
  return { ...deck, master: m, slides: deck.slides.map((s) => (s.layoutId ? resetSlide(s, m) : s)) };
}

/** Disposition la plus proche d'un type PPTX (`title`, `obj`, `secHead`, `twoObj`, `titleOnly`, `blank`…). */
export function layoutIdForPptxType(m: SlideMaster, type: string | undefined, name: string | undefined): string | undefined {
  const byName = m.layouts.find((l) => l.name.toLowerCase() === (name ?? "").toLowerCase());
  if (byName) return byName.id;
  const want: Record<string, string> = { title: "lay-titre", obj: "lay-contenu", tx: "lay-contenu", secHead: "lay-section", twoObj: "lay-deux", titleOnly: "lay-titre-seul", blank: "lay-vierge" };
  return m.layouts.find((l) => l.id === want[type ?? ""])?.id;
}

// --- Édition du masque (fonctions pures utilisées par l'éditeur) ---------------

export function updatePlaceholder(m: SlideMaster, layoutId: string, phId: string, patch: Partial<LayoutPlaceholder>): SlideMaster {
  return {
    ...m,
    layouts: m.layouts.map((l) => (l.id === layoutId ? { ...l, placeholders: l.placeholders.map((p) => (p.id === phId ? clampPh({ ...p, ...patch }) : p)) } : l)),
  };
}
const clampPh = (p: LayoutPlaceholder): LayoutPlaceholder => {
  const c = (v: number, a: number, b: number) => Math.min(b, Math.max(a, Number.isFinite(v) ? v : a));
  const w = c(p.w, 2, 100);
  const h = c(p.h, 2, 100);
  return { ...p, w, h, x: c(p.x, 0, 100 - w), y: c(p.y, 0, 100 - h), fontSize: Math.round(c(p.fontSize, 8, 160)) };
};

export function addPlaceholder(m: SlideMaster, layoutId: string, kind: PlaceholderKind): SlideMaster {
  const base: Record<PlaceholderKind, LayoutPlaceholder> = {
    title: ph("", "title", 7, 6, 86, 15, 40, "left", "middle", true),
    body: ph("", "body", 7, 24, 86, 66, 24, "left", "top"),
    footer: footer(),
    slideNumber: number(),
  };
  return {
    ...m,
    layouts: m.layouts.map((l) => {
      if (l.id !== layoutId) return l;
      let n = 1;
      while (l.placeholders.some((p) => p.id === `${kind}${n}`)) n++;
      return { ...l, placeholders: [...l.placeholders, { ...base[kind], id: `${kind}${n}` }] };
    }),
  };
}
export function removePlaceholder(m: SlideMaster, layoutId: string, phId: string): SlideMaster {
  return { ...m, layouts: m.layouts.map((l) => (l.id === layoutId ? { ...l, placeholders: l.placeholders.filter((p) => p.id !== phId) } : l)) };
}
export function addLayout(m: SlideMaster, name: string): SlideMaster {
  let n = 1;
  while (m.layouts.some((l) => l.id === `lay-perso-${n}`)) n++;
  return { ...m, layouts: [...m.layouts, { id: `lay-perso-${n}`, name: name.trim() || `Disposition ${m.layouts.length + 1}`, placeholders: [footer(), number()] }] };
}
export function removeLayout(m: SlideMaster, layoutId: string): SlideMaster {
  return m.layouts.length <= 1 ? m : { ...m, layouts: m.layouts.filter((l) => l.id !== layoutId) };
}
export function renameLayout(m: SlideMaster, layoutId: string, name: string): SlideMaster {
  return { ...m, layouts: m.layouts.map((l) => (l.id === layoutId ? { ...l, name: name.trim() || l.name } : l)) };
}

/** Remplace le jeton de numéro de diapositive par le numéro réel (rendu, présentateur, PDF). */
export function withSlideNumber(html: string | undefined, n: number | undefined): string {
  const h = html ?? "";
  return n === undefined ? h : h.split(SLIDE_NUMBER_TOKEN).join(String(n));
}
