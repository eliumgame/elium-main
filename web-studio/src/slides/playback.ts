/**
 * Animation playback engine (pure). Given a slide's elements + animations and a
 * current click "step", it computes which elements are hidden, which are entering
 * (get an entrance animation), and which are simply visible. Shared by the
 * presenter on both editors so playback is identical everywhere.
 */
import type { SlideAnim, SlideElement, AnimEffect } from "./model";

export const ANIM_EFFECTS: { value: AnimEffect; label: string }[] = [
  { value: "fade", label: "Fondu" },
  { value: "slide-up", label: "Glisser (bas)" },
  { value: "slide-down", label: "Glisser (haut)" },
  { value: "slide-left", label: "Glisser (droite)" },
  { value: "slide-right", label: "Glisser (gauche)" },
  { value: "zoom", label: "Zoom" },
  { value: "flyin", label: "Voler" },
  { value: "spin", label: "Rotation" },
];

/** Highest click step in a slide's animations (0 when none / all with-slide). */
export function maxStep(anims: SlideAnim[] | undefined): number {
  if (!anims || anims.length === 0) return 0;
  return anims.reduce((m, a) => Math.max(m, a.order), 0);
}

export interface RevealState {
  /** Elements not yet revealed at this step (kept in the DOM but hidden). */
  hidden: Set<string>;
  /** Elements entering exactly at this step → apply their entrance animation. */
  entering: Map<string, SlideAnim>;
}

/**
 * Reveal state for a slide at a given step. Elements without an animation are
 * always visible; an animated element is hidden while step < its order, enters at
 * step === order, and stays visible after.
 */
export function revealAt(elements: SlideElement[], anims: SlideAnim[] | undefined, step: number): RevealState {
  const byId = new Map((anims ?? []).map((a) => [a.elementId, a] as const));
  const hidden = new Set<string>();
  const entering = new Map<string, SlideAnim>();
  for (const el of elements) {
    const a = byId.get(el.id);
    if (!a) continue; // no animation → always visible
    if (a.order > step) hidden.add(el.id);
    else if (a.order === step) entering.set(el.id, a);
  }
  return { hidden, entering };
}
