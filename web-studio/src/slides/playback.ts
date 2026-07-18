/**
 * Animation playback engine (pure). Given a slide's elements + animations and a
 * current click "step", it computes which elements are hidden, which are entering
 * (get an entrance animation), and which are simply visible. Shared by the
 * presenter on both editors so playback is identical everywhere.
 *
 * Triggers (PowerPoint-style) decide how each animation relates to the play
 * sequence: `onClick` waits for a click before playing, `withPrevious` plays on
 * the same click as the animation before it, and `afterPrevious` also shares that
 * click but starts only once the previous animations of the step have finished.
 * So `order` is the play SEQUENCE; the number of clicks depends on the triggers.
 */
import type { SlideAnim, SlideElement, AnimEffect, AnimTrigger } from "./model";

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

export const ANIM_TRIGGERS: { value: AnimTrigger; label: string }[] = [
  { value: "onClick", label: "Au clic" },
  { value: "withPrevious", label: "Avec la précédente" },
  { value: "afterPrevious", label: "Après la précédente" },
];

const DEFAULT_DURATION_MS = 500;

/** A resolved animation: which click reveals it and its effective start delay. */
export interface AnimPlan {
  elementId: string;
  effect: AnimEffect;
  /** Click that reveals this element (0 = plays with the slide's entrance). */
  clickStep: number;
  /** Effective entrance delay in ms (afterPrevious accumulates prior durations). */
  delayMs: number;
  durationMs: number;
}

/**
 * Resolve every animation to a concrete click step + start delay, honoring the
 * trigger of each. Animations play in `order`; `onClick` opens a new click step,
 * `withPrevious`/`afterPrevious` stay on the current one (afterPrevious is offset
 * so it begins after the earlier animations of that step have finished).
 */
export function planAnimations(anims: SlideAnim[] | undefined): AnimPlan[] {
  const sorted = [...(anims ?? [])].sort((a, b) => a.order - b.order);
  const plans: AnimPlan[] = [];
  let step = 0;
  let stepEndMs = 0; // when the latest animation of the current step finishes
  sorted.forEach((a, i) => {
    const trigger: AnimTrigger = a.trigger ?? "onClick";
    const own = Math.max(0, a.delayMs ?? 0);
    const durationMs = a.durationMs ?? DEFAULT_DURATION_MS;
    let delayMs: number;
    if (i === 0) {
      // First animation: order 0 keeps the legacy "with the slide" meaning
      // (step 0, no click); anything else opens the click sequence at step 1.
      // A withPrevious/afterPrevious with nothing before it just starts here.
      step = a.order === 0 ? 0 : 1;
      delayMs = own;
      stepEndMs = delayMs + durationMs;
    } else if (trigger === "onClick") {
      step += 1;
      delayMs = own;
      stepEndMs = delayMs + durationMs;
    } else if (trigger === "withPrevious") {
      delayMs = own; // starts alongside the previous animation
      stepEndMs = Math.max(stepEndMs, delayMs + durationMs);
    } else {
      // afterPrevious: same click, but only once the step's prior anims ended.
      delayMs = stepEndMs + own;
      stepEndMs = delayMs + durationMs;
    }
    plans.push({ elementId: a.elementId, effect: a.effect, clickStep: step, delayMs, durationMs });
  });
  return plans;
}

/** Highest click step in a slide's animations (0 when none / all with-slide). */
export function maxStep(anims: SlideAnim[] | undefined): number {
  return planAnimations(anims).reduce((m, p) => Math.max(m, p.clickStep), 0);
}

export interface RevealState {
  /** Elements not yet revealed at this step (kept in the DOM but hidden). */
  hidden: Set<string>;
  /** Elements entering exactly at this step → apply their entrance animation.
   *  The carried anim has its EFFECTIVE delay/duration resolved (see plan). */
  entering: Map<string, SlideAnim>;
}

/**
 * Reveal state for a slide at a given step. Elements without an animation are
 * always visible; an animated element is hidden while its click step is ahead,
 * enters when the step matches, and stays visible after. The entering anim
 * carries the resolved (trigger-aware) delay so afterPrevious plays sequentially.
 */
export function revealAt(elements: SlideElement[], anims: SlideAnim[] | undefined, step: number): RevealState {
  const byId = new Map(planAnimations(anims).map((p) => [p.elementId, p] as const));
  const hidden = new Set<string>();
  const entering = new Map<string, SlideAnim>();
  for (const el of elements) {
    const p = byId.get(el.id);
    if (!p) continue; // no animation → always visible
    if (p.clickStep > step) hidden.add(el.id);
    else if (p.clickStep === step) {
      entering.set(el.id, {
        elementId: p.elementId,
        effect: p.effect,
        order: p.clickStep,
        delayMs: p.delayMs,
        durationMs: p.durationMs,
      });
    }
  }
  return { hidden, entering };
}
