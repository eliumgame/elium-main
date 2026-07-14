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
 */
type Hist<T> = { past: T[]; present: T; future: T[] };
type Action<T> =
  | { type: "set" | "setQuiet"; fn: (p: T) => T }
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
      return { past: [...s.past, s.present].slice(-LIMIT), present: next, future: [] };
    }
    case "setQuiet": {
      const next = a.fn(s.present);
      if (Object.is(next, s.present)) return s;
      return { past: s.past, present: next, future: s.future };
    }
    case "checkpoint":
      return { past: [...s.past, s.present].slice(-LIMIT), present: s.present, future: [] };
    case "undo": {
      if (!s.past.length) return s;
      const prev = s.past[s.past.length - 1];
      return { past: s.past.slice(0, -1), present: prev, future: [s.present, ...s.future].slice(0, LIMIT) };
    }
    case "redo": {
      if (!s.future.length) return s;
      const nxt = s.future[0];
      return { past: [...s.past, s.present].slice(-LIMIT), present: nxt, future: s.future.slice(1) };
    }
    case "reset":
      return { past: [], present: a.value, future: [] };
  }
}

export function useUndoable<T>(initial: T) {
  const [h, dispatch] = useReducer(reducer as (s: Hist<T>, a: Action<T>) => Hist<T>, { past: [], present: initial, future: [] });
  const toFn = (u: T | ((p: T) => T)) => (typeof u === "function" ? (u as (p: T) => T) : () => u);
  return {
    value: h.present,
    set: (u: T | ((p: T) => T)) => dispatch({ type: "set", fn: toFn(u) }),
    setQuiet: (u: T | ((p: T) => T)) => dispatch({ type: "setQuiet", fn: toFn(u) }),
    checkpoint: () => dispatch({ type: "checkpoint" }),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    reset: (v: T) => dispatch({ type: "reset", value: v }),
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  };
}
