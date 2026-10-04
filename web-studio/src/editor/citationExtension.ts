/**
 * TipTap : `citation` (inline atome portant sa source complète — le document
 * reste autonome, sans registre externe) et `bibliography` (bloc atome qui
 * affiche les références triées). Le texte est DÉRIVÉ du style choisi : la
 * commande `refreshCitations` recalcule toutes les citations et toutes les
 * bibliographies du document ; `bibliographyStale` dit si c'est nécessaire.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import {
  BIBLIOGRAPHY_TITLES,
  buildBibliography,
  collectSources,
  formatCitation,
  partsToHtml,
  type BibSource,
  type CitationStyle,
  type RefPart,
} from "./citations";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    citations: {
      insertCitation: (source: BibSource, page: string, style: CitationStyle) => ReturnType;
      insertBibliography: (style: CitationStyle) => ReturnType;
      /** Recalcule le texte de toutes les citations et les entrées de toutes les bibliographies. */
      refreshCitations: (style: CitationStyle) => ReturnType;
    };
  }
}

type PMNodeLike = { type: { name: string }; attrs: Record<string, unknown>; descendants: (cb: (n: PMNodeLike, pos: number) => void) => void; toJSON: () => never };

export const Citation = Node.create({
  name: "citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { source: { default: null }, page: { default: "" }, text: { default: "(?)" } };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-citation]",
        getAttrs: (el) => {
          try {
            return JSON.parse((el as HTMLElement).getAttribute("data-citation") ?? "null");
          } catch {
            return false;
          }
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-citation": JSON.stringify({ source: node.attrs.source, page: node.attrs.page, text: node.attrs.text }),
        class: "elium-citation",
      }),
      String(node.attrs.text ?? ""),
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "elium-citation";
      dom.contentEditable = "false";
      const src = node.attrs.source as BibSource | null;
      dom.title = src ? `${src.title}${src.year ? ` (${src.year})` : ""}` : "Source introuvable";
      dom.textContent = String(node.attrs.text ?? "(?)");
      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type.name !== "citation") return false;
          dom.textContent = String(updated.attrs.text ?? "(?)");
          const s = updated.attrs.source as BibSource | null;
          dom.title = s ? `${s.title}${s.year ? ` (${s.year})` : ""}` : "Source introuvable";
          return true;
        },
      };
    };
  },

  addCommands() {
    return {
      insertCitation:
        (source, page, style) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { source, page, text: formatCitation(source, style, page) } }),
      insertBibliography:
        (style) =>
        ({ chain, editor }) => {
          const sources = collectSources(editor.getJSON() as never);
          return chain()
            .insertContent({ type: "bibliography", attrs: { style, entries: buildBibliography(sources, style) } })
            .run();
        },
      refreshCitations:
        (style) =>
        ({ tr, state, dispatch }) => {
          const sources = collectSources(state.doc.toJSON() as never);
          const entries = buildBibliography(sources, style);
          let changed = false;
          (state.doc as unknown as PMNodeLike).descendants((n, pos) => {
            if (n.type.name === "citation") {
              const s = n.attrs.source as BibSource | null;
              if (!s) return;
              const text = formatCitation(s, style, String(n.attrs.page ?? ""));
              if (text !== n.attrs.text) {
                tr.setNodeMarkup(pos, undefined, { ...n.attrs, text });
                changed = true;
              }
            } else if (n.type.name === "bibliography") {
              if (n.attrs.style !== style || JSON.stringify(n.attrs.entries) !== JSON.stringify(entries)) {
                tr.setNodeMarkup(pos, undefined, { ...n.attrs, style, entries });
                changed = true;
              }
            }
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
    };
  },
});

export const Bibliography = Node.create({
  name: "bibliography",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return { style: { default: "apa" }, entries: { default: [] } };
  },

  parseHTML() {
    return [
      {
        tag: "section[data-bibliography]",
        getAttrs: (el) => {
          try {
            return JSON.parse((el as HTMLElement).getAttribute("data-bibliography") ?? "null");
          } catch {
            return false;
          }
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes, { "data-bibliography": JSON.stringify({ style: node.attrs.style, entries: node.attrs.entries }), class: "elium-bibliography" })];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("section");
      dom.className = "elium-bibliography";
      dom.contentEditable = "false";
      const render = (n: typeof node) => {
        const style = (n.attrs.style as CitationStyle) ?? "apa";
        const entries = (n.attrs.entries as RefPart[][]) ?? [];
        dom.innerHTML =
          `<h2 class="elium-bibliography__title">${BIBLIOGRAPHY_TITLES[style] ?? "Bibliographie"}</h2>` +
          (entries.length
            ? entries.map((e) => `<p class="elium-bibliography__entry">${partsToHtml(e)}</p>`).join("")
            : `<p class="elium-bibliography__empty">Aucune source citée : insérez des citations puis mettez à jour.</p>`);
      };
      render(node);
      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type.name !== "bibliography") return false;
          render(updated);
          return true;
        },
      };
    };
  },
});
