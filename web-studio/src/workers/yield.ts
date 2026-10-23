/**
 * Cession coopérative du fil principal pour les boucles longues qui ne peuvent pas aller dans un Worker
 * (DOM, canvas, objets non clonables). `createYielder` ne cède qu'au-delà du budget, donc presque
 * gratuit dans une boucle serrée. Gardé volontairement sans dépendance.
 */
export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sched?.yield) return sched.yield();
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Renvoie une fonction `await tick()` à appeler à chaque itération : cède si `budgetMs` ms se sont écoulées. */
export function createYielder(budgetMs = 12): () => Promise<void> {
  let last = now();
  return async () => {
    if (now() - last < budgetMs) return;
    await yieldToMain();
    last = now();
  };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
