/**
 * Trieuse de diapositives : réordonnancement par glisser-déposer, sections,
 * diapositives masquées. Fonctions PURES (sans React) — partagées par le
 * magasin local et le magasin collaboratif.
 *
 * Une section est ancrée sur l'identifiant de sa première diapositive
 * (`startSlideId`) : c'est ce qui la rend stable face aux réordonnancements
 * concurrents et aux suppressions.
 */
import { newElementId, newSlideId, withElements, type Slide, type SlideSection } from "./model";

export interface SectionRange {
  /** null = diapositives avant la première section (zone « sans section »). */
  section: SlideSection | null;
  from: number; // index inclusif
  to: number; // index inclusif
}

/** Découpe la liste de diapositives en plages de sections (dans l'ordre d'affichage). */
export function sectionRanges(slides: Slide[], sections: SlideSection[] | undefined): SectionRange[] {
  const starts = new Map<number, SlideSection>();
  for (const s of sections ?? []) {
    const i = slides.findIndex((x) => x.id === s.startSlideId);
    if (i >= 0 && !starts.has(i)) starts.set(i, s);
  }
  const out: SectionRange[] = [];
  let curFrom = 0;
  let cur: SlideSection | null = null;
  for (let i = 0; i < slides.length; i++) {
    const s = starts.get(i);
    if (s) {
      if (i > curFrom) out.push({ section: cur, from: curFrom, to: i - 1 });
      curFrom = i;
      cur = s;
    }
  }
  if (slides.length) out.push({ section: cur, from: curFrom, to: slides.length - 1 });
  return out;
}

/** Retire les sections dont la diapositive d'ancrage n'existe plus. */
export function normalizeSections(slides: Slide[], sections: SlideSection[] | undefined): SlideSection[] {
  const seen = new Set<string>();
  const out: SlideSection[] = [];
  for (const s of sections ?? []) {
    if (!slides.some((x) => x.id === s.startSlideId) || seen.has(s.startSlideId)) continue;
    seen.add(s.startSlideId);
    out.push(s);
  }
  return out;
}

/** Ajoute (ou renomme) une section commençant à la diapositive d'index `index`. */
export function addSectionAt(
  slides: Slide[],
  sections: SlideSection[] | undefined,
  index: number,
  name: string,
): SlideSection[] {
  const start = slides[index];
  if (!start) return sections ?? [];
  const list = (sections ?? []).filter((s) => s.startSlideId !== start.id);
  list.push({ id: `sec-${newElementId()}`, name: name.trim() || "Section sans titre", startSlideId: start.id });
  return list;
}

export function renameSection(sections: SlideSection[] | undefined, id: string, name: string): SlideSection[] {
  return (sections ?? []).map((s) => (s.id === id ? { ...s, name: name.trim() || s.name } : s));
}

export function toggleSectionCollapsed(sections: SlideSection[] | undefined, id: string): SlideSection[] {
  return (sections ?? []).map((s) => (s.id === id ? { ...s, collapsed: !s.collapsed } : s));
}

/** Supprime la section (ses diapositives sont conservées et rejoignent la section précédente). */
export function removeSection(sections: SlideSection[] | undefined, id: string): SlideSection[] {
  return (sections ?? []).filter((s) => s.id !== id);
}

/**
 * Déplace la diapositive `from` pour qu'elle arrive à l'index `to` (index final dans la liste résultante).
 * Si elle ouvrait une section qui contient d'autres diapositives, l'ancre de la section passe à la suivante
 * (la diapositive quitte la section, comme dans PowerPoint).
 */
export function reorderSlide(
  slides: Slide[],
  sections: SlideSection[] | undefined,
  from: number,
  to: number,
): { slides: Slide[]; sections: SlideSection[] } {
  if (from === to || from < 0 || to < 0 || from >= slides.length || to >= slides.length)
    return { slides, sections: sections ?? [] };
  const moved = slides[from]!;
  let secs = (sections ?? []).slice();
  const own = secs.find((s) => s.startSlideId === moved.id);
  if (own) {
    const next = slides[from + 1];
    // la section n'avait que cette diapositive → elle la suit ; sinon l'ancre passe à la suivante
    const nextIsAnotherSectionStart = next && secs.some((s) => s.startSlideId === next.id);
    if (next && !nextIsAnotherSectionStart) secs = secs.map((s) => (s === own ? { ...s, startSlideId: next.id } : s));
  }
  const out = slides.slice();
  out.splice(from, 1);
  out.splice(to, 0, moved);
  return { slides: out, sections: normalizeSections(out, secs) };
}

/**
 * Déplace une section entière (toutes ses diapositives) avant la section `beforeId` (null = à la fin).
 */
export function moveSection(
  slides: Slide[],
  sections: SlideSection[] | undefined,
  sectionId: string,
  beforeId: string | null,
): Slide[] {
  const ranges = sectionRanges(slides, sections);
  const src = ranges.find((r) => r.section?.id === sectionId);
  if (!src) return slides;
  const moving = slides.slice(src.from, src.to + 1);
  const rest = [...slides.slice(0, src.from), ...slides.slice(src.to + 1)];
  let at = rest.length;
  if (beforeId) {
    const dst = ranges.find((r) => r.section?.id === beforeId);
    if (!dst || dst === src) return slides;
    const first = slides[dst.from]!;
    at = rest.findIndex((s) => s.id === first.id);
  }
  rest.splice(at, 0, ...moving);
  return rest;
}

/** Duplique une diapositive (nouveaux identifiants ; morphKey conservé pour appairer les transitions Morph). */
export function cloneSlide(slide: Slide): Slide {
  const orig = withElements(slide);
  return {
    ...orig,
    id: newSlideId(),
    elements: orig.elements!.map((e) => ({ ...e, id: newElementId(), morphKey: e.morphKey ?? e.id })),
  };
}

/** Indices des diapositives jouées en diaporama (les masquées sont ignorées). */
export function playableIndices(slides: Slide[]): number[] {
  const out: number[] = [];
  slides.forEach((s, i) => {
    if (!s.hidden) out.push(i);
  });
  return out;
}

/** Prochain index jouable dans le sens `dir` à partir de `from` (exclu) ; null s'il n'y en a plus. */
export function nextPlayable(slides: Slide[], from: number, dir: 1 | -1): number | null {
  for (let i = from + dir; i >= 0 && i < slides.length; i += dir) if (!slides[i]!.hidden) return i;
  return null;
}

/** Première diapositive jouable à partir de `from` (incluse) : `from` elle-même, sinon la suivante, sinon la précédente. */
export function firstPlayableFrom(slides: Slide[], from: number): number | null {
  if (slides[from] && !slides[from]!.hidden) return from;
  return nextPlayable(slides, from, 1) ?? nextPlayable(slides, from, -1);
}

/** Libellé « n masquée(s) » pour l'interface. */
export function hiddenCount(slides: Slide[]): number {
  return slides.reduce((n, s) => n + (s.hidden ? 1 : 0), 0);
}

/** Supprime la diapositive i ; l'ancre d'une section qui la visait passe à la suivante (ou la section disparaît). */
export function removeSlideKeepingSections(
  slides: Slide[],
  sections: SlideSection[] | undefined,
  i: number,
): { slides: Slide[]; sections: SlideSection[] } {
  const gone = slides[i];
  if (!gone || slides.length <= 1) return { slides, sections: sections ?? [] };
  let secs = (sections ?? []).slice();
  const next = slides[i + 1];
  const nextIsStart = next && secs.some((s) => s.startSlideId === next.id);
  secs = secs
    .map((s) => (s.startSlideId === gone.id ? (next && !nextIsStart ? { ...s, startSlideId: next.id } : null) : s))
    .filter((s): s is SlideSection => s !== null);
  const out = slides.filter((_, idx) => idx !== i);
  return { slides: out, sections: normalizeSections(out, secs) };
}
