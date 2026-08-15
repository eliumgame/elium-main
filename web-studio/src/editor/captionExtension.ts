/**
 * The TipTap side of captions and the table of figures.
 *
 * `caption` is an editable block whose text the author types; the "Figure 3 — "
 * prefix is a node view that recomputes itself from the document, so it can
 * never be stale and is never part of the text the author edits.
 *
 * `tableOfFigures` is an atomic block that rebuilds its list on every edit.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { buildFigureTable, captionInsertPos, captionPrefix, collectCaptions, figureTableTitle } from "./captions";
import { pageOfPos } from "./wordExtensions";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    caption: {
      /** Insert a caption for the object at the cursor. */
      insertCaption: (attrs: { label: string; text?: string; position?: "above" | "below" }) => ReturnType;
      /** Change the label of the caption under the cursor. */
      setCaptionLabel: (label: string) => ReturnType;
    };
    tableOfFigures: {
      /** Insert a table of figures; an empty label lists every caption. */
      insertTableOfFigures: (label?: string) => ReturnType;
    };
  }
}

export const Caption = Node.create({
  name: "caption",
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return {
      label: { default: "Figure" },
      position: { default: "below" },
      /** Anchor stamped when a renvoi points at this caption. */
      refId: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "figcaption[data-caption-label]" }, { tag: "p[data-caption-label]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "p",
      mergeAttributes(HTMLAttributes, {
        "data-caption-label": String(node.attrs.label ?? "Figure"),
        class: "elium-caption",
        ...(node.attrs.refId ? { id: String(node.attrs.refId) } : {}),
      }),
      0,
    ];
  },

  addCommands() {
    return {
      insertCaption:
        (attrs) =>
        ({ tr, state, dispatch, editor }) => {
          const type = editor.schema.nodes[this.name];
          if (!type) return false;
          const position = attrs.position ?? "below";
          const pos = captionInsertPos(state.selection.$from, type, position === "below");
          if (pos === null) return false;
          if (dispatch) {
            const text = attrs.text?.trim();
            const node = type.create({ label: attrs.label, position }, text ? editor.schema.text(text) : null);
            tr.insert(pos, node);
            // Leave the cursor at the end of the caption so the author can keep
            // typing, exactly as Word does after inserting one.
            const end = Math.min(pos + node.nodeSize - 1, tr.doc.content.size);
            tr.setSelection(TextSelection.near(tr.doc.resolve(end)));
            tr.scrollIntoView();
          }
          return true;
        },
      setCaptionLabel:
        (label) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { label }),
    };
  },

  addNodeView() {
    return ({ editor, node, getPos }) => {
      const dom = document.createElement("p");
      dom.className = "elium-caption";
      const prefix = document.createElement("span");
      prefix.className = "elium-caption__prefix";
      prefix.contentEditable = "false";
      const body = document.createElement("span");
      body.className = "elium-caption__text";
      dom.append(prefix, body);

      const render = (current: typeof node) => {
        const label = String(current.attrs.label ?? "Figure");
        dom.setAttribute("data-caption-label", label);
        const pos = typeof getPos === "function" ? getPos() : null;
        const entries = collectCaptions(editor.state.doc);
        const mine = pos == null ? null : entries.find((e) => e.pos === pos);
        // Fall back to the count of same-label captions so a caption still shows
        // a number during the frame where its position is not resolvable yet.
        const number = mine?.number ?? (entries.filter((e) => e.label === label).length || 1);
        prefix.textContent = captionPrefix(label, number);
      };

      render(node);
      let current = node;
      const onUpdate = () => render(current);
      editor.on("update", onUpdate);

      return {
        dom,
        contentDOM: body,
        update: (updated) => {
          if (updated.type.name !== "caption") return false;
          current = updated;
          render(updated);
          return true;
        },
        ignoreMutation: (mutation) => {
          if (mutation.type === "selection") return false;
          // The prefix is ours: its mutations must not reach ProseMirror.
          return mutation.target !== body && !body.contains(mutation.target);
        },
        destroy: () => editor.off("update", onUpdate),
      };
    };
  },
});

export const TableOfFigures = Node.create({
  name: "tableOfFigures",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      /** "" lists every caption family. */
      label: { default: "Figure" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-figure-table]" }];
  },

  renderHTML({ node }) {
    return [
      "div",
      {
        "data-figure-table": String(node.attrs.label ?? ""),
        class: "elium-figtable",
      },
    ];
  },

  addCommands() {
    return {
      insertTableOfFigures:
        (label) =>
        ({ tr, state, dispatch, editor }) => {
          const type = editor.schema.nodes[this.name];
          if (!type) return false;
          // Same reason as insertCaption: the cursor is often inside a caption
          // when the author reaches for this, and a caption takes inline content
          // only, so inserting at the cursor would drop the command.
          const pos = captionInsertPos(state.selection.$from, type, true);
          if (pos === null) return false;
          if (dispatch) {
            tr.insert(pos, type.create({ label: label ?? "Figure" }));
            tr.scrollIntoView();
          }
          return true;
        },
    };
  },

  addNodeView() {
    return ({ editor, node }) => {
      const dom = document.createElement("div");
      dom.className = "elium-figtable";
      dom.contentEditable = "false";

      const render = (current: typeof node) => {
        const label = String(current.attrs.label ?? "");
        dom.setAttribute("data-figure-table", label);
        const rows = buildFigureTable(collectCaptions(editor.state.doc), label || null, (p) => pageOfPos(p));
        dom.replaceChildren();

        const title = document.createElement("div");
        title.className = "elium-figtable__title";
        title.textContent = figureTableTitle(label);
        dom.appendChild(title);

        if (!rows.length) {
          const empty = document.createElement("div");
          empty.className = "elium-figtable__empty";
          empty.textContent = "Ajoutez des légendes pour les voir listées ici.";
          dom.appendChild(empty);
          return;
        }

        const list = document.createElement("ol");
        list.className = "elium-figtable__list";
        for (const row of rows) {
          const li = document.createElement("li");
          li.className = "elium-figtable__row";
          const a = document.createElement("a");
          a.href = "#";
          a.textContent = `${captionPrefix(row.label, row.number, " — ")}${row.text || "(sans titre)"}`;
          a.addEventListener("click", (e) => {
            e.preventDefault();
            if (row.pos >= 0)
              editor
                .chain()
                .focus()
                .setTextSelection(row.pos + 1)
                .scrollIntoView()
                .run();
          });
          li.appendChild(a);
          if (row.page != null) {
            const page = document.createElement("span");
            page.className = "elium-figtable__page";
            page.textContent = String(row.page);
            li.appendChild(page);
          }
          list.appendChild(li);
        }
        dom.appendChild(list);
      };

      render(node);
      let current = node;
      const onUpdate = () => render(current);
      editor.on("update", onUpdate);

      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type.name !== "tableOfFigures") return false;
          current = updated;
          render(updated);
          return true;
        },
        destroy: () => editor.off("update", onUpdate),
      };
    };
  },
});
