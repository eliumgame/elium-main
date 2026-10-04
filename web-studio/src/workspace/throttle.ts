/**
 * Limiteur « premier appel immédiat, puis au plus un appel par intervalle »,
 * avec appel final garanti (`flush`). Sert à ne mettre à jour le catalogue de
 * l'espace de travail (taille, date) qu'à intervalle raisonnable pendant que
 * l'éditeur autosauvegarde à chaque frappe.
 */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Exécute tout de suite l'appel en attente, s'il y en a un. */
  flush(): void;
  cancel(): void;
}

export function createThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  timers: Timers = realTimers,
): Throttled<A> {
  let last = -Infinity;
  let pending: A | null = null;
  let handle: unknown = null;

  const run = (args: A) => {
    last = timers.now();
    pending = null;
    handle = null;
    fn(...args);
  };

  const throttled = ((...args: A) => {
    const wait = last + ms - timers.now();
    if (wait <= 0 && handle === null) {
      run(args);
      return;
    }
    pending = args; // seul le DERNIER appel compte
    if (handle === null) handle = timers.set(() => pending && run(pending), Math.max(0, wait));
  }) as Throttled<A>;

  throttled.flush = () => {
    if (handle !== null) timers.clear(handle);
    if (pending) run(pending);
    handle = null;
  };
  throttled.cancel = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    pending = null;
  };
  return throttled;
}
