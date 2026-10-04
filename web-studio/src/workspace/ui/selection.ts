/**
 * Sélection multiple et glisser-déposer de la bibliothèque — logique pure.
 */

export interface ClickModifiers {
  ctrl: boolean;
  shift: boolean;
}

export interface SelectionState {
  selected: string[];
  /** Dernier élément cliqué sans Maj : point de départ de la plage Maj+clic. */
  anchor: string | null;
}

export const emptySelection: SelectionState = { selected: [], anchor: null };

/**
 * Clic sur un élément. Sans modificateur : sélection simple. Ctrl/Cmd : bascule
 * l'élément. Maj : plage entre l'ancre et l'élément cliqué (dans l'ordre affiché).
 */
export function clickSelect(state: SelectionState, id: string, order: string[], mod: ClickModifiers): SelectionState {
  if (mod.shift && state.anchor && order.includes(state.anchor)) {
    const a = order.indexOf(state.anchor);
    const b = order.indexOf(id);
    if (b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = order.slice(lo, hi + 1);
      const base = mod.ctrl ? state.selected : [];
      return { selected: [...new Set([...base, ...range])], anchor: state.anchor };
    }
  }
  if (mod.ctrl) {
    const has = state.selected.includes(id);
    return { selected: has ? state.selected.filter((s) => s !== id) : [...state.selected, id], anchor: id };
  }
  return { selected: [id], anchor: id };
}

/** Bascule la case à cocher d'un élément (ajoute/retire sans toucher aux autres). */
export function toggleSelect(state: SelectionState, id: string): SelectionState {
  const has = state.selected.includes(id);
  return { selected: has ? state.selected.filter((s) => s !== id) : [...state.selected, id], anchor: id };
}

export function selectAll(order: string[]): SelectionState {
  return { selected: [...order], anchor: order[0] ?? null };
}

/** Retire de la sélection ce qui n'est plus affiché (après un déplacement, une suppression…). */
export function pruneSelection(state: SelectionState, order: string[]): SelectionState {
  const keep = state.selected.filter((s) => order.includes(s));
  if (keep.length === state.selected.length) return state;
  return { selected: keep, anchor: state.anchor && order.includes(state.anchor) ? state.anchor : null };
}

// --- Glisser-déposer ------------------------------------------------------

export const DRAG_MIME = "application/x-elium-workspace";

export interface DragPayload {
  itemIds: string[];
  folderIds: string[];
}

/**
 * Ce qu'on emporte en glissant `draggedId` : toute la sélection si l'élément
 * glissé en fait partie, sinon lui seul.
 */
export function dragPayload(
  selection: { items: string[]; folders: string[] },
  dragged: { kind: "item" | "folder"; id: string },
): DragPayload {
  const inSel = dragged.kind === "item" ? selection.items.includes(dragged.id) : selection.folders.includes(dragged.id);
  if (inSel) return { itemIds: [...selection.items], folderIds: [...selection.folders] };
  return dragged.kind === "item" ? { itemIds: [dragged.id], folderIds: [] } : { itemIds: [], folderIds: [dragged.id] };
}

export function encodeDrag(p: DragPayload): string {
  return JSON.stringify(p);
}

export function decodeDrag(raw: string | undefined | null): DragPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DragPayload>;
    if (!Array.isArray(v.itemIds) || !Array.isArray(v.folderIds)) return null;
    return {
      itemIds: v.itemIds.filter((x): x is string => typeof x === "string"),
      folderIds: v.folderIds.filter((x): x is string => typeof x === "string"),
    };
  } catch {
    return null;
  }
}
