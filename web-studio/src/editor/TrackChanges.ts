/**
 * Track changes (suggestion mode) for the Elium editor — OPT-IN, off by default,
 * so it never touches normal editing unless explicitly enabled.
 *
 * Model: two marks ride on the text and persist in the document JSON.
 *   - insertion : text added while suggesting (rendered <ins>, green underline)
 *   - deletion  : text marked for removal instead of being deleted (<del>, struck)
 *
 * Mechanics:
 *   - typing (handleTextInput) inserts text carrying the insertion mark; typing
 *     over a selection also marks that selection for deletion (replacement).
 *   - Backspace/Delete mark the adjacent character for deletion instead of
 *     removing it — unless it is your own pending insertion, which is removed.
 *   - acceptAllChanges / rejectAllChanges resolve every change.
 *
 * Known v1 limitations (documented): Enter (new block), paste and block-boundary
 * merges are not tracked. Suggestion mode being opt-in contains any rough edges.
 */
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";

interface TrackState {
  suggesting: boolean;
}

export const trackKey = new PluginKey<TrackState>("eliumTrack");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    trackChanges: {
      setSuggesting: (on: boolean) => ReturnType;
      toggleSuggesting: () => ReturnType;
      acceptAllChanges: () => ReturnType;
      rejectAllChanges: () => ReturnType;
    };
  }
}

export function isSuggesting(state: EditorState): boolean {
  return trackKey.getState(state)?.suggesting ?? false;
}

function nowIso(): string {
  return new Date().toISOString();
}

export const Insertion = Mark.create({
  name: "insertion",
  inclusive: true,
  addAttributes() {
    return { author: { default: "" }, ts: { default: "" } };
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
    return { author: { default: "" }, ts: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "del[data-deletion]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["del", mergeAttributes(HTMLAttributes, { "data-deletion": "true", class: "el-del" }), 0];
  },
});

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
      if ($pos.parentOffset === 0) return false; // block start → let default merge happen
      from = pos - 1;
      to = pos;
    } else {
      if ($pos.parentOffset >= $pos.parent.content.size) return false; // block end
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
    tr.addMark(from, to, del.create({ author, ts: nowIso() }));
    const cursor = dir < 0 ? from : to;
    tr.setSelection(TextSelection.create(tr.doc, Math.min(cursor, tr.doc.content.size)));
  }
  tr.setMeta(trackKey, { skip: true });
  editor.view.dispatch(tr);
  return true;
}

export const TrackChanges = Extension.create<{ author: string }>({
  name: "trackChanges",

  addOptions() {
    return { author: "" };
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
          const ranges: [number, number][] = [];
          state.doc.descendants((node, pos) => {
            if (node.isText && del.isInSet(node.marks)) ranges.push([pos, pos + node.nodeSize]);
          });
          tr.removeMark(0, state.doc.content.size, ins); // accept insertions: keep text
          ranges.sort((a, b) => b[0] - a[0]).forEach(([f, t]) => tr.delete(f, t)); // drop deletions
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
          const ranges: [number, number][] = [];
          state.doc.descendants((node, pos) => {
            if (node.isText && ins.isInSet(node.marks)) ranges.push([pos, pos + node.nodeSize]);
          });
          tr.removeMark(0, state.doc.content.size, del); // reject deletions: keep text
          ranges.sort((a, b) => b[0] - a[0]).forEach(([f, t]) => tr.delete(f, t)); // drop insertions
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
              tr = tr.addMark(from, to, delMark.create({ author, ts: nowIso() })); // mark replaced text deleted
            }
            const node = state.schema.text(text, [insMark.create({ author, ts: nowIso() })]);
            tr = tr.insert(to, node);
            const after = to + text.length;
            tr = tr.setSelection(TextSelection.create(tr.doc, after));
            tr.setMeta(trackKey, { skip: true });
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
