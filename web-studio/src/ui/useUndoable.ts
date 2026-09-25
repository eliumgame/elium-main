import { useReducer } from "react";

/**
 * Generic undo/redo state container (reducer-based, so it's safe under React
 * StrictMode double-invocation — no ref mutation during render).
 *
 * - `set`        : record a new state (clears the redo stack).
 * - `setQuiet`   : update the present WITHOUT pushing history (for transient
 *                  gestures like a drag in progress).
 * - `checkpoint` : push the current state onto the undo stack without changing
 *                  it (call once at the start of a gesture, then `setQuiet`).
 * - `reset`      : replace the state and clear all history (e.g. on load).
 * - `version`    : a stamp of the present state — equal to a remembered stamp
 *                  exactly when the state is the one remembered (undo back to
 *                  a saved state counts as unmodified again).
 * - `amend`      : apply `fn` to the present AND to every state in the undo /
 *                  redo stacks, without adding history — for facts that belong
 *                  to the document itself and arrive late (e.g. the markup a
 *                  file already carries, imported in the background after it
 *                  opened): undoing must not remove them, redoing must keep them.
 */
type Hist<T> = {
  past: T[];
  present: T;
  future: T[];
  /**
   * Version stamps, parallel to past/present/future: every recorded change
   * gets a new stamp, undo/redo bring the stamp of the state they restore,
   * `amend` keeps them. `version` === a remembered stamp therefore means
   * "exactly the state that was saved" — the basis of a modified/saved flag.
   */
  pastIds: number[];
  id: number;
  futureIds: number[];
  seq: number;
};
type Action<T> =
  | { type: "set" | "setQuiet" | "amend"; fn: (p: T) => T }
  | { type: "checkpoint" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; value: T };

const LIMIT = 100;

function reducer<T>(s: Hist<T>, a: Action<T>): Hist<T> {
  switch (a.type) {
    case "set": {
      const next = a.fn(s.present);
      if (Object.is(next, s.present)) return s;
      return {
        past: [...s.past, s.present].slice(-LIMIT),
        pastIds: [...s.pastIds, s.id].slice(-LIMIT),
        present: next,
        id: s.seq + 1,
        seq: s.seq + 1,
        future: [],
        futureIds: [],
      };
    }
    case "setQuiet": {
      const next = a.fn(s.present);
      if (Object.is(next, s.present)) return s;
      return { ...s, present: next, id: s.seq + 1, seq: s.seq + 1 };
    }
    case "amend": {
      const next = a.fn(s.present);
      const past = s.past.map(a.fn);
      const future = s.future.map(a.fn);
      const same = (x: T[], y: T[]) => x.every((v, i) => Object.is(v, y[i]));
      if (Object.is(next, s.present) && same(past, s.past) && same(future, s.future)) return s;
      return { ...s, past, present: next, future };
    }
    case "checkpoint":
      return {
        ...s,
        past: [...s.past, s.present].slice(-LIMIT),
        pastIds: [...s.pastIds, s.id].slice(-LIMIT),
        future: [],
        futureIds: [],
      };
    case "undo": {
      if (!s.past.length) return s;
      return {
        ...s,
        past: s.past.slice(0, -1),
        pastIds: s.pastIds.slice(0, -1),
        present: s.past[s.past.length - 1],
        id: s.pastIds[s.pastIds.length - 1],
        future: [s.present, ...s.future].slice(0, LIMIT),
        futureIds: [s.id, ...s.futureIds].slice(0, LIMIT),
      };
    }
    case "redo": {
      if (!s.future.length) return s;
      return {
        ...s,
        past: [...s.past, s.present].slice(-LIMIT),
        pastIds: [...s.pastIds, s.id].slice(-LIMIT),
        present: s.future[0],
        id: s.futureIds[0],
        future: s.future.slice(1),
        futureIds: s.futureIds.slice(1),
      };
    }
    case "reset":
      return { past: [], pastIds: [], present: a.value, id: s.seq + 1, seq: s.seq + 1, future: [], futureIds: [] };
  }
}

export function useUndoable<T>(initial: T) {
  const [h, dispatch] = useReducer(reducer as (s: Hist<T>, a: Action<T>) => Hist<T>, {
    past: [],
    pastIds: [],
    present: initial,
    id: 0,
    futureIds: [],
    future: [],
    seq: 0,
  });
  const toFn = (u: T | ((p: T) => T)) => (typeof u === "function" ? (u as (p: T) => T) : () => u);
  return {
    value: h.present,
    set: (u: T | ((p: T) => T)) => dispatch({ type: "set", fn: toFn(u) }),
    setQuiet: (u: T | ((p: T) => T)) => dispatch({ type: "setQuiet", fn: toFn(u) }),
    checkpoint: () => dispatch({ type: "checkpoint" }),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    reset: (v: T) => dispatch({ type: "reset", value: v }),
    amend: (fn: (p: T) => T) => dispatch({ type: "amend", fn }),
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    /** Stamp of the present state (see `Hist.id`): compare with a remembered one to know if it changed. */
    version: h.id,
  };
}
