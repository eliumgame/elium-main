/**
 * Track changes (suggestion mode) for the Elium editor — OPT-IN, off by default,
 * so it never touches normal editing unless explicitly enabled.
 *
 * Model: two marks ride on the text and persist in the document JSON.
 *   - insertion : text added while suggesting (rendered <ins>, green underline)
 *   - deletion  : text marked for removal instead of being deleted (<del>, struck)
 * Each mark carries an `id`: contiguous text typed/deleted in one sitting by the
 * same author shares an id, so a single click can accept or reject exactly that
 * edit — see `acceptChange`/`rejectChange` — without touching the rest of the
 * document. `acceptAllChanges`/`rejectAllChanges` still resolve everything at once.
 *
 * Paragraph breaks cannot carry a mark (there is no text to attach one to), so
 * Enter (a new break) and Backspace/Delete at a block boundary (removing one) are
 * tracked as a `trackBreak` attribute on the paragraph/heading itself:
 *   - split : the break was just inserted (Enter). The doc already shows two
 *     blocks; rejecting joins them back, accepting just clears the flag.
 *   - merge : the break is proposed for removal (Backspace/Delete at a boundary).
 *     The doc still shows two blocks (nothing joins until accepted); accepting
 *     performs the join, rejecting just clears the flag.
 *   `acceptBreak`/`rejectBreak` resolve one boundary; accept/rejectAllChanges
 *   resolve every one, alongside the character-level marks.
 *
 * Mechanics:
 *   - typing (handleTextInput) inserts text carrying the insertion mark; typing
 *     over a selection also marks that selection for deletion (replacement).
 *   - Backspace/Delete mark the adjacent character for deletion instead of
 *     removing it — unless it is your own pending insertion, which is removed.
 *   - Enter is tracked only in the common case (a plain paragraph/heading, not a
 *     list item, task item or code block): those keep today's untracked
 *     behaviour rather than risk a broken split/lift/indent.
 *
 * Known limitation (documented, not tracked): paste. Determining "what changed"
 * inside an arbitrary pasted fragment — which may itself carry formatting, lists,
 * tables — would need a full structural diff against the surrounding document
 * (essentially reimplementing `compare.ts` on every keystroke's paste), not a
 * local mark-on-insert like typing. `compare.ts` already exists for exactly this
 * ("compare with another version") and is the supported way to review a large
 * external change; suggestion mode stays focused on live editing.
 */
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode, MarkType } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";

interface TrackState {
  suggesting: boolean;
}

export const trackKey = new PluginKey<TrackState>("eliumTrack");

/** A pending, trackable paragraph-break change living on a block's attrs. */
export interface TrackBreak {
  kind: "split" | "merge";
  id: string;
  author: string;
  ts: string;
}

/** Block types Enter/boundary-merge tracking is scoped to (see module header). */
const BREAK_TYPES = ["paragraph", "heading"];
/** Ancestor types that manage their own Enter/Backspace semantics — skip there. */
const BREAK_EXCLUDED_ANCESTORS = new Set(["listItem", "taskItem", "codeBlock", "tableCell", "tableHeader"]);

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    trackChanges: {
      setSuggesting: (on: boolean) => ReturnType;
      toggleSuggesting: () => ReturnType;
      acceptAllChanges: () => ReturnType;
      rejectAllChanges: () => ReturnType;
      /** Resolve ONE change (insertion or deletion) — `pos` is any position inside it. */
      acceptChange: (pos: number) => ReturnType;
      rejectChange: (pos: number) => ReturnType;
      /** Resolve ONE pending paragraph-break — `pos` is the block's own position. */
      acceptBreak: (pos: number) => ReturnType;
      rejectBreak: (pos: number) => ReturnType;
    };
  }
}

export function isSuggesting(state: EditorState): boolean {
  return trackKey.getState(state)?.suggesting ?? false;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function newChangeId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `ch-${c.randomUUID()}`;
  return `ch-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

/** A request to review one change, with the screen point it was raised from. */
export interface TrackChangeRequest {
  x: number;
  y: number;
  kind: "insertion" | "deletion" | "split" | "merge";
  /** For insertion/deletion: a position inside the span. For split/merge: the block's own position. */
  pos: number;
  author: string;
  ts: string;
}

let requestListener: ((request: TrackChangeRequest) => void) | null = null;

/** Subscribe to change-review requests (clicking a tracked change or break marker). */
export function onTrackChangeRequest(fn: (request: TrackChangeRequest) => void): () => void {
  requestListener = fn;
  return () => {
    if (requestListener === fn) requestListener = null;
  };
}

export const Insertion = Mark.create({
  name: "insertion",
  inclusive: true,
  addAttributes() {
    return { author: { default: "" }, ts: { default: "" }, id: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "ins[data-insertion]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["ins", mergeAttributes(HTMLAttributes, { "data-insertion": "true", class: "el-ins" }), 0];
  },
});

export const Deletion = Mark.create({
  name: "deletion",
  inclusive: false,
  addAttributes() {
    return { author: { default: "" }, ts: { default: "" }, id: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "del[data-deletion]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["del", mergeAttributes(HTMLAttributes, { "data-deletion": "true", class: "el-del" }), 0];
  },
});

/** Is there a mark of `markType` by `author` on the character occupying [charPos, charPos+1)? */
function markIdAt(doc: PMNode, charPos: number, markType: MarkType, author: string): string | null {
  if (charPos < 0 || charPos >= doc.content.size) return null;
  let found: string | null = null;
  doc.nodesBetween(charPos, charPos + 1, (node) => {
    if (found || !node.isText) return;
    const m = markType.isInSet(node.marks);
    if (m && String(m.attrs.author ?? "") === author) found = String(m.attrs.id ?? "") || null;
  });
  return found;
}

/** Mark (or, for own insertions, remove) the character adjacent to the cursor. */
function markDelete(editor: Editor, dir: -1 | 1, author: string): boolean {
  const { state } = editor;
  const { selection, schema, doc } = state;
  const del = schema.marks.deletion;
  const ins = schema.marks.insertion;
  if (!del || !ins) return false;

  let from: number;
  let to: number;
  if (!selection.empty) {
    from = selection.from;
    to = selection.to;
  } else {
    const pos = selection.from;
    const $pos = doc.resolve(pos);
    if (dir < 0) {
      if ($pos.parentOffset === 0) return markBoundary(editor, -1, author);
      from = pos - 1;
      to = pos;
    } else {
      if ($pos.parentOffset >= $pos.parent.content.size) return markBoundary(editor, 1, author);
      from = pos;
      to = pos + 1;
    }
  }

  // Is the whole range our own pending insertion? Then truly remove it.
  let allInsertion = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && !ins.isInSet(node.marks)) allInsertion = false;
  });

  const tr = state.tr;
  if (allInsertion) {
    tr.delete(from, to);
  } else {
    const reuse = dir < 0 ? markIdAt(doc, to, del, author) : markIdAt(doc, from - 1, del, author);
    const id = reuse ?? newChangeId();
    tr.addMark(from, to, del.create({ author, ts: nowIso(), id }));
    const cursor = dir < 0 ? from : to;
    tr.setSelection(TextSelection.create(tr.doc, Math.min(cursor, tr.doc.content.size)));
  }
  tr.setMeta(trackKey, { skip: true });
  editor.view.dispatch(tr);
  return true;
}

/**
 * Backspace at a block's start (dir=-1) or Delete at its end (dir=1): flag the
 * boundary with the previous/next sibling as a pending merge, WITHOUT actually
 * joining anything yet (see module header). Falls through to the default,
 * untracked join when the pair is not a plain paragraph/heading of the same
 * type, or lives inside a list item / task item / code block / table cell.
 */
function markBoundary(editor: Editor, dir: -1 | 1, author: string): boolean {
  const { state } = editor;
  const { selection, doc } = state;
  const $pos = selection.$from;
  for (let d = $pos.depth; d >= 0; d--) {
    if (BREAK_EXCLUDED_ANCESTORS.has($pos.node(d).type.name)) return false;
  }
  const here = $pos.parent;
  if (!BREAK_TYPES.includes(here.type.name)) return false;

  // The block whose leading break is at stake is always the LATTER of the pair:
  // the current block for Backspace, the next sibling for Delete.
  const latterPos = dir < 0 ? $pos.before() : $pos.after();
  const latter = doc.nodeAt(latterPos);
  if (!latter || !BREAK_TYPES.includes(latter.type.name)) return false;
  if ((latter.attrs as { trackBreak?: TrackBreak | null }).trackBreak) return true; // already pending

  // The FORMER block (the one merging INTO) must exist and match type, or a
  // later `join` could not succeed.
  const former = dir < 0 ? doc.resolve(latterPos).nodeBefore : doc.nodeAt($pos.before());
  if (!former || former.type !== latter.type) return false;

  const tr = state.tr;
  const trackBreak: TrackBreak = { kind: "merge", id: newChangeId(), author, ts: nowIso() };
  tr.setNodeMarkup(latterPos, undefined, { ...latter.attrs, trackBreak });
  tr.setMeta(trackKey, { skip: true });
  editor.view.dispatch(tr);
  return true;
}

/** Splits the current block, flagging the new (latter) one as a pending insertion. */
function trackedEnter(editor: Editor, author: string): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;
  const $from = selection.$from;
  for (let d = $from.depth; d >= 0; d--) {
    if (BREAK_EXCLUDED_ANCESTORS.has($from.node(d).type.name)) return false;
  }
  if (!BREAK_TYPES.includes($from.parent.type.name)) return false;

  const tr = state.tr;
  const pos = selection.from;
  tr.split(pos);
  // map(pos) (default assoc 1) lands at the START OF THE LATTER BLOCK'S CONTENT
  // (one token past its own position, mirroring `$pos.before()` elsewhere in this
  // file) — back up one to reach the block itself for `nodeAt`/`setNodeMarkup`.
  const latterPos = tr.mapping.map(pos) - 1;
  const latter = tr.doc.nodeAt(latterPos);
  if (!latter) return false;
  const trackBreak: TrackBreak = { kind: "split", id: newChangeId(), author, ts: nowIso() };
  tr.setNodeMarkup(latterPos, undefined, { ...latter.attrs, trackBreak });
  tr.setMeta(trackKey, { skip: true });
  editor.view.dispatch(tr);
  return true;
}

/** The change span (insertion/deletion) at `pos`, if any — for the click popover
 *  and for `acceptChange`/`rejectChange` (a single lookup keeps both in sync:
 *  a separate second scan could pick a different node at an ambiguous boundary). */
function changeSpanAt(
  doc: PMNode,
  pos: number,
): { kind: "insertion" | "deletion"; id: string; author: string; ts: string; from: number; to: number } | null {
  let hit: { kind: "insertion" | "deletion"; id: string; author: string; ts: string; from: number; to: number } | null =
    null;
  doc.nodesBetween(Math.max(0, pos - 1), Math.min(doc.content.size, pos + 1), (node, nodePos) => {
    if (hit || !node.isText) return;
    if (pos < nodePos || pos > nodePos + node.nodeSize) return;
    const insMark = node.marks.find((m) => m.type.name === "insertion");
    const delMark = node.marks.find((m) => m.type.name === "deletion");
    const mark = insMark ?? delMark;
    if (!mark) return;
    hit = {
      kind: insMark ? "insertion" : "deletion",
      id: String(mark.attrs.id ?? ""),
      author: String(mark.attrs.author ?? ""),
      ts: String(mark.attrs.ts ?? ""),
      from: nodePos,
      to: nodePos + node.nodeSize,
    };
  });
  return hit;
}

/** Resolve every node carrying `markType` with a matching `id` — the whole logical change. */
function rangesForId(doc: PMNode, markType: MarkType, id: string): [number, number][] {
  const ranges: [number, number][] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const m = markType.isInSet(node.marks);
    if (m && String(m.attrs.id ?? "") === id) ranges.push([pos, pos + node.nodeSize]);
  });
  return ranges;
}

type PendingEdit = { at: number; run: () => void };

export const TrackChanges = Extension.create<{ author: string }>({
  name: "trackChanges",

  addOptions() {
    return { author: "" };
  },

  addGlobalAttributes() {
    return [
      {
        types: BREAK_TYPES,
        attributes: {
          trackBreak: {
            default: null,
            parseHTML: () => null, // never round-trips through pasted/copied HTML — Elium JSON only
            renderHTML: (attrs: Record<string, unknown>) => {
              const tb = attrs.trackBreak as TrackBreak | null;
              return tb ? { "data-track-break": tb.kind, class: `elium-break-pending elium-break-pending--${tb.kind}` } : {};
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setSuggesting:
        (on) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(trackKey, { suggesting: on }));
          return true;
        },
      toggleSuggesting:
        () =>
        ({ state, tr, dispatch }) => {
          const cur = isSuggesting(state);
          if (dispatch) dispatch(tr.setMeta(trackKey, { suggesting: !cur }));
          return true;
        },
      acceptAllChanges:
        () =>
        ({ state, tr, dispatch }) => {
          const ins = state.schema.marks.insertion;
          const del = state.schema.marks.deletion;
          if (!ins || !del) return false;
          tr.removeMark(0, state.doc.content.size, ins); // accept insertions: keep text (position-preserving, first)
          const edits: PendingEdit[] = [];
          state.doc.descendants((node, pos) => {
            if (node.isText && del.isInSet(node.marks)) edits.push({ at: pos, run: () => tr.delete(pos, pos + node.nodeSize) });
            const tb = (node.attrs as { trackBreak?: TrackBreak | null }).trackBreak;
            if (tb?.kind === "split") {
              edits.push({
                at: pos,
                run: () => {
                  const n = tr.doc.nodeAt(pos);
                  if (n) tr.setNodeMarkup(pos, undefined, { ...n.attrs, trackBreak: null });
                },
              });
            } else if (tb?.kind === "merge") {
              edits.push({ at: pos, run: () => tr.join(pos) });
            }
          });
          edits.sort((a, b) => b.at - a.at).forEach((e) => e.run()); // highest position first: lower ones stay valid
          tr.setMeta(trackKey, { skip: true });
          if (dispatch) dispatch(tr);
          return true;
        },
      rejectAllChanges:
        () =>
        ({ state, tr, dispatch }) => {
          const ins = state.schema.marks.insertion;
          const del = state.schema.marks.deletion;
          if (!ins || !del) return false;
          tr.removeMark(0, state.doc.content.size, del); // reject deletions: keep text (position-preserving, first)
          const edits: PendingEdit[] = [];
          state.doc.descendants((node, pos) => {
            if (node.isText && ins.isInSet(node.marks)) edits.push({ at: pos, run: () => tr.delete(pos, pos + node.nodeSize) });
            const tb = (node.attrs as { trackBreak?: TrackBreak | null }).trackBreak;
            if (tb?.kind === "split") {
              edits.push({ at: pos, run: () => tr.join(pos) });
            } else if (tb?.kind === "merge") {
              edits.push({
                at: pos,
                run: () => {
                  const n = tr.doc.nodeAt(pos);
                  if (n) tr.setNodeMarkup(pos, undefined, { ...n.attrs, trackBreak: null });
                },
              });
            }
          });
          edits.sort((a, b) => b.at - a.at).forEach((e) => e.run());
          tr.setMeta(trackKey, { skip: true });
          if (dispatch) dispatch(tr);
          return true;
        },
      acceptChange:
        (pos) =>
        ({ state, tr, dispatch }) => {
          const ins = state.schema.marks.insertion;
          const del = state.schema.marks.deletion;
          if (!ins || !del) return false;
          const hit = changeSpanAt(state.doc, pos);
          if (!hit) return false;
          const markType = hit.kind === "insertion" ? ins : del;
          // A real id resolves the WHOLE logical change (every run it touched);
          // legacy data with no id (saved before this existed) falls back to
          // just the one node under the cursor rather than a no-op.
          const ranges: [number, number][] = hit.id ? rangesForId(state.doc, markType, hit.id) : [[hit.from, hit.to]];
          if (hit.kind === "insertion") ranges.forEach(([f, t]) => tr.removeMark(f, t, ins));
          else ranges.sort((a, b) => b[0] - a[0]).forEach(([f, t]) => tr.delete(f, t));
          tr.setMeta(trackKey, { skip: true });
          if (dispatch) dispatch(tr);
          return true;
        },
      rejectChange:
        (pos) =>
        ({ state, tr, dispatch }) => {
          const ins = state.schema.marks.insertion;
          const del = state.schema.marks.deletion;
          if (!ins || !del) return false;
          const hit = changeSpanAt(state.doc, pos);
          if (!hit) return false;
          const markType = hit.kind === "insertion" ? ins : del;
          const ranges: [number, number][] = hit.id ? rangesForId(state.doc, markType, hit.id) : [[hit.from, hit.to]];
          if (hit.kind === "insertion") ranges.sort((a, b) => b[0] - a[0]).forEach(([f, t]) => tr.delete(f, t));
          else ranges.forEach(([f, t]) => tr.removeMark(f, t, del));
          tr.setMeta(trackKey, { skip: true });
          if (dispatch) dispatch(tr);
          return true;
        },
      acceptBreak:
        (pos) =>
        ({ state, tr, dispatch }) => {
          const node = state.doc.nodeAt(pos);
          const tb = (node?.attrs as { trackBreak?: TrackBreak | null } | undefined)?.trackBreak;
          if (!node || !tb) return false;
          if (tb.kind === "split") tr.setNodeMarkup(pos, undefined, { ...node.attrs, trackBreak: null });
          else tr.join(pos);
          tr.setMeta(trackKey, { skip: true });
          if (dispatch) dispatch(tr);
          return true;
        },
      rejectBreak:
        (pos) =>
        ({ state, tr, dispatch }) => {
          const node = state.doc.nodeAt(pos);
          const tb = (node?.attrs as { trackBreak?: TrackBreak | null } | undefined)?.trackBreak;
          if (!node || !tb) return false;
          if (tb.kind === "split") tr.join(pos);
          else tr.setNodeMarkup(pos, undefined, { ...node.attrs, trackBreak: null });
          tr.setMeta(trackKey, { skip: true });
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => (isSuggesting(this.editor.state) ? markDelete(this.editor, -1, this.options.author) : false),
      Delete: () => (isSuggesting(this.editor.state) ? markDelete(this.editor, 1, this.options.author) : false),
      Enter: () => (isSuggesting(this.editor.state) ? trackedEnter(this.editor, this.options.author) : false),
      "Mod-Shift-m": () => this.editor.commands.toggleSuggesting(),
    };
  },

  addProseMirrorPlugins() {
    const author = this.options.author;
    return [
      new Plugin<TrackState>({
        key: trackKey,
        state: {
          init: () => ({ suggesting: false }),
          apply(tr, value) {
            const meta = tr.getMeta(trackKey) as { suggesting?: boolean } | undefined;
            if (meta && typeof meta.suggesting === "boolean") return { suggesting: meta.suggesting };
            return value;
          },
        },
        props: {
          handleTextInput(view, from, to, text) {
            if (!isSuggesting(view.state)) return false;
            const { state } = view;
            const insMark = state.schema.marks.insertion;
            const delMark = state.schema.marks.deletion;
            if (!insMark) return false;
            let tr = state.tr;
            if (from < to && delMark) {
              const reuseDel = markIdAt(state.doc, from - 1, delMark, author);
              tr = tr.addMark(from, to, delMark.create({ author, ts: nowIso(), id: reuseDel ?? newChangeId() })); // mark replaced text deleted
            }
            const reuseIns = markIdAt(state.doc, to - 1, insMark, author);
            const node = state.schema.text(text, [insMark.create({ author, ts: nowIso(), id: reuseIns ?? newChangeId() })]);
            tr = tr.insert(to, node);
            const after = to + text.length;
            tr = tr.setSelection(TextSelection.create(tr.doc, after));
            tr.setMeta(trackKey, { skip: true });
            view.dispatch(tr.scrollIntoView());
            return true;
          },
          handleClick(view, pos, event) {
            if (!requestListener || event.button !== 0) return false;
            const hit = changeSpanAt(view.state.doc, pos);
            if (!hit) return false;
            requestListener({ x: event.clientX, y: event.clientY, kind: hit.kind, pos, author: hit.author, ts: hit.ts });
            return false; // never steal the click: cursor placement still happens
          },
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              const tb = (node.attrs as { trackBreak?: TrackBreak | null }).trackBreak;
              if (!tb) return;
              decos.push(
                Decoration.widget(
                  pos + 1,
                  () => {
                    const el = document.createElement("span");
                    el.className = `elium-break-marker elium-break-marker--${tb.kind}`;
                    el.contentEditable = "false";
                    el.textContent = "¶";
                    el.title =
                      tb.kind === "split"
                        ? `Saut de paragraphe ajouté${tb.author ? ` par ${tb.author}` : ""} — clic pour accepter/refuser`
                        : `Fusion de paragraphes proposée${tb.author ? ` par ${tb.author}` : ""} — clic pour accepter/refuser`;
                    el.addEventListener("mousedown", (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    });
                    el.addEventListener("click", (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      requestListener?.({ x: e.clientX, y: e.clientY, kind: tb.kind, pos, author: tb.author, ts: tb.ts });
                    });
                    return el;
                  },
                  { side: -1 },
                ),
              );
            });
            return decos.length ? DecorationSet.create(state.doc, decos) : null;
          },
        },
      }),
    ];
  },
});
