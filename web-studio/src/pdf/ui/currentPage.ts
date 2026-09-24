import { useSyncExternalStore } from "react";

/**
 * The page being read (1-based), kept OUTSIDE the workspace's React state.
 *
 * It changes many times a second while scrolling. As workspace state, every
 * change re-rendered the whole workspace — ribbon, panels and the layers of
 * every mounted page — just to update a page number. Only the components that
 * show it subscribe (`useCurrentPage`): the page-number box, the thumbnail
 * pane and the page stack. Code that merely needs its value when something
 * happens (a command, a shortcut) reads `get()`.
 */
export class CurrentPage {
  private value: number;
  private readonly listeners = new Set<() => void>();

  constructor(initial = 1) {
    this.value = initial;
  }

  readonly get = (): number => this.value;

  set(page: number): void {
    if (page === this.value) return;
    this.value = page;
    for (const l of [...this.listeners]) l();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/** The current page, re-rendering the caller when it changes. */
export function useCurrentPage(store: CurrentPage): number {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
