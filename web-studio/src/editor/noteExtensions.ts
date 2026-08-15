/**
 * Les deux familles de notes côté TipTap, construites depuis une seule fabrique.
 *
 * `footnote`/`endnote` sont des atomes en ligne qui ne portent que leur texte et
 * leur identifiant ; le marqueur affiché (« 3 », « iii ») est recalculé depuis
 * l'ordre du document, donc il ne peut pas être périmé. `footnotesList` et
 * `endnotesList` sont des blocs atomiques qui reconstruisent leur liste à chaque
 * édition.
 *
 * Tout passe par une fabrique paramétrée par la famille : deux définitions
 * copiées auraient fini par divergerapide, et c'est précisément la numérotation
 * qui doit rester commune (cf. `notes.ts`).
 */
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NOTE_LIST_TYPE,
  NOTE_TITLES,
  collectNotes,
  convertNotes,
  hasNotesList,
  noteMarker,
  type NoteKind,
} from "./notes";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    notes: {
      /** Insère un appel de note de bas de page au curseur. */
      insertFootnote: (text: string) => ReturnType;
      /** Insère (ou révèle) la liste des notes de bas de page. */
      insertFootnotesList: () => ReturnType;
      /** Insère un appel de note de fin au curseur. */
      insertEndnote: (text: string) => ReturnType;
      /** Insère (ou révèle) la liste des notes de fin. */
      insertEndnotesList: () => ReturnType;
      /** Convertit toutes les notes d'une famille dans l'autre. */
      convertNotesTo: (to: NoteKind) => ReturnType;
    };
  }
}

/** Classe CSS de l'appel de note, par famille. */
const REF_CLASS: Record<NoteKind, string> = {
  footnote: "elium-fn-ref",
  endnote: "elium-en-ref",
};

/** Classe CSS du bloc de liste, par famille. */
const LIST_CLASS: Record<NoteKind, string> = {
  footnote: "elium-footnotes",
  endnote: "elium-endnotes",
};

/** Attribut de repérage HTML, par famille. */
const DATA_ATTR: Record<NoteKind, string> = {
  footnote: "data-footnote-id",
  endnote: "data-endnote-id",
};

const LIST_DATA_ATTR: Record<NoteKind, string> = {
  footnote: "data-footnotes",
  endnote: "data-endnotes",
};

let seq = 0;

/** Identifiant stable pour une nouvelle note. */
export function newNoteId(kind: NoteKind): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${kind === "endnote" ? "en" : "fn"}-${Date.now().toString(36)}-${seq}-${rand}`;
}

/**
 * Le nœud d'appel de note d'une famille.
 *
 * Le texte voyage dans les attributs : les notes survivent donc telles quelles
 * dans le JSON du document, sans partie annexe à tenir synchronisée.
 */
export function makeNoteNode(kind: NoteKind) {
  return Node.create({
    name: kind,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        id: { default: null },
        text: { default: "" },
      };
    },

    parseHTML() {
      return [{ tag: `sup[${DATA_ATTR[kind]}]` }];
    },

    renderHTML({ node }) {
      return [
        "sup",
        mergeAttributes({
          [DATA_ATTR[kind]]: node.attrs.id == null ? "" : String(node.attrs.id),
          [`data-${kind}-text`]: node.attrs.text == null ? "" : String(node.attrs.text),
          class: REF_CLASS[kind],
        }),
      ];
    },

    addNodeView() {
      return ({ editor, node, getPos }) => {
        const dom = document.createElement("sup");
        dom.className = REF_CLASS[kind];
        dom.setAttribute(DATA_ATTR[kind], String(node.attrs.id ?? ""));

        const render = (current: typeof node) => {
          const pos = typeof getPos === "function" ? getPos() : null;
          const entries = collectNotes(editor.state.doc, kind);
          const mine = pos == null ? null : entries.find((e) => e.pos === pos);
          // À défaut de position résolvable (le temps d'une frame), le nombre de
          // notes de la famille donne un marqueur plausible plutôt que du vide.
          dom.textContent = mine?.marker ?? noteMarker(kind, entries.length || 1);
          dom.title = String(current.attrs.text ?? "");
        };

        render(node);
        let current = node;
        const onUpdate = () => render(current);
        editor.on("update", onUpdate);

        return {
          dom,
          ignoreMutation: () => true,
          update: (updated) => {
            if (updated.type.name !== kind) return false;
            current = updated;
            render(updated);
            return true;
          },
          destroy: () => editor.off("update", onUpdate),
        };
      };
    },
  });
}

/** Le bloc de liste d'une famille : dérivé du document, il ne stocke rien. */
export function makeNotesListNode(kind: NoteKind) {
  return Node.create({
    name: NOTE_LIST_TYPE[kind],
    group: "block",
    atom: true,
    selectable: true,
    draggable: false,

    parseHTML() {
      return [{ tag: `div[${LIST_DATA_ATTR[kind]}]` }];
    },

    renderHTML() {
      return ["div", { [LIST_DATA_ATTR[kind]]: "true", class: LIST_CLASS[kind] }];
    },

    addNodeView() {
      return ({ editor }) => {
        const dom = document.createElement("div");
        dom.className = LIST_CLASS[kind];
        dom.setAttribute(LIST_DATA_ATTR[kind], "true");
        dom.contentEditable = "false";

        const render = () => {
          const entries = collectNotes(editor.state.doc, kind);
          dom.replaceChildren();

          const title = document.createElement("div");
          title.className = `${LIST_CLASS[kind]}__title`;
          title.textContent = NOTE_TITLES[kind];
          dom.appendChild(title);

          if (!entries.length) {
            const empty = document.createElement("div");
            empty.className = `${LIST_CLASS[kind]}__empty`;
            empty.textContent = "Insérez des appels de note dans le texte pour les voir listés ici.";
            dom.appendChild(empty);
            return;
          }

          const list = document.createElement("ol");
          list.className = `${LIST_CLASS[kind]}__list`;
          for (const entry of entries) {
            const li = document.createElement("li");
            li.className = `${LIST_CLASS[kind]}__item`;
            // Le marqueur est écrit à la main : les notes de fin sont en romains
            // minuscules, ce qu'aucun `list-style` CSS ne fait en français.
            const mark = document.createElement("span");
            mark.className = `${LIST_CLASS[kind]}__mark`;
            mark.textContent = entry.marker;
            const body = document.createElement("span");
            body.className = `${LIST_CLASS[kind]}__text`;
            body.textContent = entry.text || "(note vide)";
            li.append(mark, body);
            // Cliquer une entrée ramène à son appel dans le texte.
            if (entry.pos >= 0) {
              li.classList.add("is-linked");
              li.addEventListener("click", () => {
                editor.chain().focus().setTextSelection(entry.pos).scrollIntoView().run();
              });
            }
            list.appendChild(li);
          }
          dom.appendChild(list);
        };

        render();
        const onUpdate = () => render();
        editor.on("update", onUpdate);

        return {
          dom,
          ignoreMutation: () => true,
          update: (node) => node.type.name === NOTE_LIST_TYPE[kind],
          destroy: () => editor.off("update", onUpdate),
        };
      };
    },
  });
}

export const Footnote = makeNoteNode("footnote").extend({
  addCommands() {
    return {
      insertFootnote:
        (text) =>
        ({ chain, state }) => {
          const needList = !hasNotesList(state.doc, "footnote");
          return chain()
            .insertContent({ type: "footnote", attrs: { id: newNoteId("footnote"), text } })
            .command(({ tr, dispatch }) => {
              if (!needList) return true;
              if (dispatch) {
                const type = tr.doc.type.schema.nodes[NOTE_LIST_TYPE.footnote];
                if (type) tr.insert(tr.doc.content.size, type.create());
              }
              return true;
            })
            .run();
        },
    };
  },
});

export const FootnotesList = makeNotesListNode("footnote").extend({
  addCommands() {
    return {
      insertFootnotesList:
        () =>
        ({ tr, state, dispatch }) => {
          if (hasNotesList(state.doc, "footnote")) return false;
          const type = state.schema.nodes[NOTE_LIST_TYPE.footnote];
          if (!type) return false;
          if (dispatch) tr.insert(tr.doc.content.size, type.create());
          return true;
        },
    };
  },
});

export const Endnote = makeNoteNode("endnote").extend({
  addCommands() {
    return {
      insertEndnote:
        (text) =>
        ({ chain, state }) => {
          const needList = !hasNotesList(state.doc, "endnote");
          return chain()
            .insertContent({ type: "endnote", attrs: { id: newNoteId("endnote"), text } })
            .command(({ tr, dispatch }) => {
              if (!needList) return true;
              if (dispatch) {
                const type = tr.doc.type.schema.nodes[NOTE_LIST_TYPE.endnote];
                // La liste vit en fin de document : c'est la définition même
                // d'une note de fin.
                if (type) tr.insert(tr.doc.content.size, type.create());
              }
              return true;
            })
            .run();
        },
      convertNotesTo:
        (to) =>
        ({ editor, tr, dispatch }) => {
          const from: NoteKind = to === "endnote" ? "footnote" : "endnote";
          const before = editor.getJSON();
          const after = convertNotes(before as { type: string; content?: unknown[] | null }, from, to);
          if (after === before) return false;
          if (dispatch) {
            const node = editor.schema.nodeFromJSON(after);
            tr.replaceWith(0, tr.doc.content.size, node.content);
          }
          return true;
        },
    };
  },
});

export const EndnotesList = makeNotesListNode("endnote").extend({
  addCommands() {
    return {
      insertEndnotesList:
        () =>
        ({ tr, state, dispatch }) => {
          if (hasNotesList(state.doc, "endnote")) return false;
          const type = state.schema.nodes[NOTE_LIST_TYPE.endnote];
          if (!type) return false;
          if (dispatch) tr.insert(tr.doc.content.size, type.create());
          return true;
        },
    };
  },
});
