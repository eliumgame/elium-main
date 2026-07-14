/**
 * Find & Replace for the Elium editor.
 *
 * A self-contained TipTap extension backed by a ProseMirror plugin that keeps
 * the current search term/options, the list of matches, and an inline
 * DecorationSet highlighting them (the active match gets a stronger style).
 * It adds no dependency and stores nothing in the document — matches are
 * derived from the live doc, so they never persist into the `.elium`.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface SearchMatch {
  from: number;
  to: number;
}

export interface SearchOptions {
  caseSensitive: boolean;
  useRegex: boolean;
}

export interface SearchPluginState {
  term: string;
  options: SearchOptions;
  current: number; // index into matches, -1 when none
  matches: SearchMatch[];
  decorations: DecorationSet;
}

interface SearchMeta {
  term?: string;
  options?: SearchOptions;
  current?: number;
}

export const searchPluginKey = new PluginKey<SearchPluginState>("eliumSearch");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    eliumSearch: {
      setSearch: (term: string, options: SearchOptions) => ReturnType;
      searchNext: () => ReturnType;
      searchPrev: () => ReturnType;
      replaceCurrent: (replacement: string) => ReturnType;
      replaceAll: (replacement: string) => ReturnType;
      clearSearch: () => ReturnType;
    };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(term: string, opts: SearchOptions): RegExp | null {
  if (!term) return null;
  try {
    const pattern = opts.useRegex ? term : escapeRegex(term);
    return new RegExp(pattern, opts.caseSensitive ? "g" : "gi");
  } catch {
    return null; // invalid user regex — treat as "no matches"
  }
}

function findMatches(doc: PMNode, term: string, opts: SearchOptions): SearchMatch[] {
  const re = buildRegex(term, opts);
  if (!re) return [];
  const matches: SearchMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const text = node.text;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++; // guard against zero-width matches looping forever
        continue;
      }
      const from = pos + m.index;
      matches.push({ from, to: from + m[0].length });
    }
    return true;
  });
  return matches;
}

function decorate(doc: PMNode, matches: SearchMatch[], current: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const decos = matches.map((mt, i) =>
    Decoration.inline(mt.from, mt.to, {
      class: i === current ? "search-result search-result--current" : "search-result",
    }),
  );
  return DecorationSet.create(doc, decos);
}

function emptyState(): SearchPluginState {
  return {
    term: "",
    options: { caseSensitive: false, useRegex: false },
    current: -1,
    matches: [],
    decorations: DecorationSet.empty,
  };
}

export const Search = Extension.create({
  name: "eliumSearch",

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchPluginState>({
        key: searchPluginKey,
        state: {
          init: () => emptyState(),
          apply(tr: Transaction, value: SearchPluginState, _old: EditorState, newState: EditorState): SearchPluginState {
            const meta = tr.getMeta(searchPluginKey) as SearchMeta | undefined;

            let term = value.term;
            let options = value.options;
            let current = value.current;
            const paramsChanged = !!meta && (meta.term !== undefined || meta.options !== undefined);

            if (meta?.term !== undefined) term = meta.term;
            if (meta?.options !== undefined) options = meta.options;

            let matches = value.matches;
            if (tr.docChanged || paramsChanged) {
              matches = findMatches(newState.doc, term, options);
            }

            if (matches.length === 0) {
              current = -1;
            } else {
              const requested = meta?.current !== undefined ? meta.current : current < 0 ? 0 : current;
              current = ((requested % matches.length) + matches.length) % matches.length; // wrap
            }

            return { term, options, current, matches, decorations: decorate(newState.doc, matches, current) };
          },
        },
        props: {
          decorations(state) {
            return searchPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setSearch:
        (term, options) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchPluginKey, { term, options, current: 0 } satisfies SearchMeta));
          return true;
        },

      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchPluginKey, { term: "" } satisfies SearchMeta));
          return true;
        },

      searchNext:
        () =>
        ({ state, tr, dispatch }) => {
          const s = searchPluginKey.getState(state);
          if (!s || s.matches.length === 0) return false;
          const next = (s.current + 1) % s.matches.length;
          if (dispatch) {
            const m = s.matches[next];
            tr.setMeta(searchPluginKey, { current: next } satisfies SearchMeta);
            tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
            dispatch(tr);
          }
          return true;
        },

      searchPrev:
        () =>
        ({ state, tr, dispatch }) => {
          const s = searchPluginKey.getState(state);
          if (!s || s.matches.length === 0) return false;
          const prev = (s.current - 1 + s.matches.length) % s.matches.length;
          if (dispatch) {
            const m = s.matches[prev];
            tr.setMeta(searchPluginKey, { current: prev } satisfies SearchMeta);
            tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
            dispatch(tr);
          }
          return true;
        },

      replaceCurrent:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const s = searchPluginKey.getState(state);
          if (!s || s.current < 0 || s.matches.length === 0) return false;
          if (dispatch) {
            const m = s.matches[s.current];
            tr.insertText(replacement, m.from, m.to);
            dispatch(tr); // docChanged -> matches recomputed, current clamped
          }
          return true;
        },

      replaceAll:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const s = searchPluginKey.getState(state);
          if (!s || s.matches.length === 0) return false;
          if (dispatch) {
            // Replace from last to first so earlier positions stay valid.
            for (let i = s.matches.length - 1; i >= 0; i--) {
              const m = s.matches[i];
              tr.insertText(replacement, m.from, m.to);
            }
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
