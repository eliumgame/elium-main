/**
 * Custom TipTap extensions for Elium. Every node/mark here serializes naturally
 * into the ProseMirror JSON stored in a `.elium`, so it round-trips with zero
 * changes to the package format:
 *   - Indent / PageBreak : block layout helpers
 *   - TableOfContents     : auto-updating, clickable heading index
 *   - Figure              : image with editable caption + alignment/wrapping
 *   - Comment             : inline annotation mark (id/author/text/resolved)
 */
import { Extension, Mark, Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

const MAX_INDENT = 8;

export interface CommentAttrs {
  id: string;
  author: string;
  text: string;
  resolved: boolean;
  createdAt: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
    pageBreak: {
      insertPageBreak: () => ReturnType;
    };
    tableOfContents: {
      insertTableOfContents: () => ReturnType;
    };
    figure: {
      setFigure: (attrs: { src: string; alt?: string; caption?: string }) => ReturnType;
      setFigureAlign: (align: "left" | "center" | "right") => ReturnType;
      setFigureWidth: (width: string) => ReturnType;
    };
    comment: {
      setComment: (attrs: CommentAttrs) => ReturnType;
      resolveComment: (id: string, resolved: boolean) => ReturnType;
      removeComment: (id: string) => ReturnType;
    };
    footnote: {
      insertFootnote: (text: string) => ReturnType;
    };
    footnotesList: {
      insertFootnotesList: () => ReturnType;
    };
    bookmark: {
      insertBookmark: (label: string) => ReturnType;
    };
  }
}

function newBookmarkId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `bm-${c.randomUUID()}`;
  return `bm-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

function newFootnoteId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `fn-${c.randomUUID()}`;
  return `fn-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

function docHasFootnotesList(doc: PMNode): boolean {
  let found = false;
  doc.descendants((n) => {
    if (n.type.name === "footnotesList") {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/** Adds an `indent` attribute (0..MAX) to paragraphs and headings, rendered as margin-left. */
export const Indent = Extension.create({
  name: "indent",

  addOptions() {
    return { types: ["paragraph", "heading"] as string[], max: MAX_INDENT };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-indent")) || 0,
            renderHTML: (attrs: Record<string, unknown>) => {
              const n = Number(attrs.indent) || 0;
              return n > 0 ? { "data-indent": n, style: `margin-left:${n * 2}em` } : {};
            },
          },
        },
      },
    ];
  },

  addCommands() {
    const shift = (delta: number) =>
      ({ editor, chain }: { editor: import("@tiptap/core").Editor; chain: () => import("@tiptap/core").ChainedCommands }) => {
        // Lists indent by nesting; other blocks via the indent attribute.
        if (editor.isActive("listItem") || editor.isActive("taskItem")) {
          const item = editor.isActive("taskItem") ? "taskItem" : "listItem";
          return delta > 0 ? chain().sinkListItem(item).run() : chain().liftListItem(item).run();
        }
        const type = editor.isActive("heading") ? "heading" : "paragraph";
        const cur = Number(editor.getAttributes(type).indent) || 0;
        const next = Math.max(0, Math.min(this.options.max, cur + delta));
        return chain().updateAttributes(type, { indent: next }).run();
      };
    return { indent: () => shift(1), outdent: () => shift(-1) };
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.indent(),
      "Shift-Tab": () => this.editor.commands.outdent(),
    };
  },
});

/** An atomic block that forces a page break when printing/exporting. */
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: "div[data-page-break]" }];
  },

  renderHTML() {
    return ["div", { "data-page-break": "true", class: "elium-page-break" }];
  },

  addCommands() {
    return {
      insertPageBreak:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
});

/**
 * Auto table of contents. An atomic block that renders a live, clickable index
 * of the document's H1–H3 headings (rebuilt on every edit). It stores nothing:
 * the list is derived from the current document, so it never goes stale.
 */
export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [{ tag: "div[data-toc]" }];
  },

  renderHTML() {
    return ["div", { "data-toc": "true", class: "elium-toc" }];
  },

  addCommands() {
    return {
      insertTableOfContents:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },

  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement("div");
      dom.className = "elium-toc";
      dom.setAttribute("data-toc", "true");
      dom.contentEditable = "false";

      const render = () => {
        const items: { level: number; text: string; pos: number }[] = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === "heading") {
            const level = Number(node.attrs.level) || 1;
            if (level <= 3) items.push({ level, text: node.textContent || "Sans titre", pos });
          }
          return true;
        });

        dom.replaceChildren();
        const title = document.createElement("div");
        title.className = "elium-toc__title";
        title.textContent = "Table des matières";
        dom.appendChild(title);

        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "elium-toc__empty";
          empty.textContent = "Ajoutez des titres (H1 à H3) pour générer la table des matières.";
          dom.appendChild(empty);
          return;
        }

        const list = document.createElement("ol");
        list.className = "elium-toc__list";
        for (const it of items) {
          const li = document.createElement("li");
          li.className = `elium-toc__item elium-toc__item--h${it.level}`;
          const a = document.createElement("a");
          a.textContent = it.text;
          a.href = "#";
          a.addEventListener("click", (e) => {
            e.preventDefault();
            editor.chain().focus().setTextSelection(it.pos + 1).scrollIntoView().run();
          });
          li.appendChild(a);
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
        update: (node) => node.type.name === "tableOfContents",
        destroy: () => editor.off("update", onUpdate),
      };
    };
  },
});

/**
 * Figure: an image with an editable caption and alignment/wrapping.
 * The image source/alt/align/width live as node attributes; the caption is the
 * node's inline content (so it is fully editable like normal text).
 */
export const Figure = Node.create({
  name: "figure",
  group: "block",
  content: "inline*",
  draggable: true,
  isolating: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      align: { default: "center" }, // left | center | right
      width: { default: "" }, // CSS width, e.g. "60%"
    };
  },

  parseHTML() {
    return [
      {
        tag: "figure[data-elium-figure]",
        getAttrs: (el) => {
          const fig = el as HTMLElement;
          const img = fig.querySelector("img");
          return {
            src: img?.getAttribute("src") || null,
            alt: img?.getAttribute("alt") || "",
            align: fig.getAttribute("data-align") || "center",
            width: fig.getAttribute("data-width") || "",
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const align = String(node.attrs.align || "center");
    const width = String(node.attrs.width || "");
    const attrs: Record<string, string> = {
      "data-elium-figure": "true",
      "data-align": align,
      class: `elium-figure elium-figure--${align}`,
    };
    if (width) {
      attrs["data-width"] = width;
      attrs.style = `width:${width}`;
    }
    return [
      "figure",
      mergeAttributes(attrs),
      ["img", { src: node.attrs.src, alt: node.attrs.alt }],
      ["figcaption", { class: "elium-figure__caption" }, 0],
    ];
  },

  addCommands() {
    return {
      setFigure:
        (attrs) =>
        ({ chain }) =>
          chain()
            .insertContent({
              type: this.name,
              attrs: { src: attrs.src, alt: attrs.alt ?? "", align: "center", width: "" },
              content: attrs.caption ? [{ type: "text", text: attrs.caption }] : [],
            })
            .run(),
      setFigureAlign:
        (align) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { align }),
      setFigureWidth:
        (width) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { width }),
    };
  },

  // DOM node view: renders the image with a drag handle so its width can be
  // adjusted by dragging (the caption stays editable as the contentDOM). The
  // width lands back on the node's `width` attribute, exactly like the presets.
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node as PMNode;
      const figure = document.createElement("figure");
      const imgWrap = document.createElement("div");
      imgWrap.className = "elium-figure__imgwrap";
      const img = document.createElement("img");
      const caption = document.createElement("figcaption");
      caption.className = "elium-figure__caption";
      const handle = document.createElement("span");
      handle.className = "elium-figure__resize";
      handle.contentEditable = "false";
      handle.title = "Glisser pour redimensionner";

      const apply = (n: PMNode) => {
        const align = String(n.attrs.align || "center");
        const width = String(n.attrs.width || "");
        figure.setAttribute("data-elium-figure", "true");
        figure.setAttribute("data-align", align);
        figure.className = `elium-figure elium-figure--${align}`;
        figure.style.width = width;
        if (width) figure.setAttribute("data-width", width);
        else figure.removeAttribute("data-width");
        img.src = n.attrs.src || "";
        img.alt = String(n.attrs.alt || "");
      };

      imgWrap.appendChild(img);
      if (editor.isEditable) imgWrap.appendChild(handle);
      figure.appendChild(imgWrap);
      figure.appendChild(caption);
      apply(current);

      if (editor.isEditable) {
        handle.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const startW = img.getBoundingClientRect().width || 1;
          const parentW = figure.parentElement?.getBoundingClientRect().width || startW;
          let pending = "";
          const onMove = (ev: MouseEvent) => {
            const px = Math.max(40, startW + (ev.clientX - startX));
            const pct = Math.max(10, Math.min(100, Math.round((px / parentW) * 100)));
            pending = `${pct}%`;
            figure.style.width = pending;
          };
          const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            const pos = typeof getPos === "function" ? getPos() : null;
            if (pending && pos != null) {
              editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width: pending }));
            }
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
      }

      return {
        dom: figure,
        contentDOM: caption,
        update: (updated) => {
          if (updated.type.name !== "figure") return false;
          current = updated;
          apply(updated);
          return true;
        },
        ignoreMutation: (mutation) => {
          if (mutation.type === "selection") return false;
          return mutation.target !== caption && !caption.contains(mutation.target);
        },
      };
    };
  },
});

/**
 * Comment: an inline mark anchoring a reviewer annotation on a text range.
 * The annotation body (author/text/resolved/date) rides in the mark attributes,
 * so comments persist inside the document JSON with no package-format change.
 */
export const Comment = Mark.create({
  name: "comment",
  inclusive: false,
  excludes: "", // comments may overlap other comments

  addAttributes() {
    return {
      id: { default: null },
      author: { default: "" },
      text: { default: "" },
      resolved: { default: false },
      createdAt: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const a = HTMLAttributes as Record<string, unknown>;
    const resolved = a.resolved === true || a.resolved === "true";
    return [
      "span",
      mergeAttributes(
        {
          "data-comment-id": a.id == null ? "" : String(a.id),
          "data-comment-author": a.author == null ? "" : String(a.author),
          "data-comment-resolved": resolved ? "true" : "false",
          class: `elium-comment${resolved ? " elium-comment--resolved" : ""}`,
          title: a.text == null ? "" : String(a.text),
        },
      ),
      0,
    ];
  },

  addCommands() {
    return {
      setComment:
        (attrs) =>
        ({ commands }) =>
          commands.setMark(this.name, attrs),

      // Toggle `resolved` on every range carrying this comment id.
      resolveComment:
        (id, resolved) =>
        ({ state, tr, dispatch }) => {
          const markType = state.schema.marks.comment;
          if (!markType) return false;
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const m of node.marks) {
              if (m.type === markType && m.attrs.id === id) {
                tr.addMark(pos, pos + node.nodeSize, markType.create({ ...m.attrs, resolved }));
                changed = true;
              }
            }
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },

      // Strip every range carrying this comment id.
      removeComment:
        (id) =>
        ({ state, tr, dispatch }) => {
          const markType = state.schema.marks.comment;
          if (!markType) return false;
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const m of node.marks) {
              if (m.type === markType && m.attrs.id === id) {
                tr.removeMark(pos, pos + node.nodeSize, markType);
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

/**
 * Footnote: an inline atom carrying the note text. It renders an auto-numbered
 * superscript marker (number derived from document order, recomputed live), and
 * its body is collected by the FootnotesList block. The text rides in the node
 * attributes, so footnotes persist inside the document JSON unchanged.
 */
export const Footnote = Node.create({
  name: "footnote",
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
    return [{ tag: "sup[data-footnote-id]" }];
  },

  renderHTML({ node }) {
    return [
      "sup",
      {
        "data-footnote-id": node.attrs.id == null ? "" : String(node.attrs.id),
        "data-footnote-text": node.attrs.text == null ? "" : String(node.attrs.text),
        class: "elium-fn-ref",
      },
    ];
  },

  addCommands() {
    return {
      insertFootnote:
        (text) =>
        ({ chain, state }) => {
          const id = newFootnoteId();
          const needList = !docHasFootnotesList(state.doc);
          return chain()
            .insertContent({ type: this.name, attrs: { id, text } })
            .command(({ tr, dispatch }) => {
              if (!needList) return true;
              if (dispatch) {
                const type = tr.doc.type.schema.nodes.footnotesList;
                if (type) tr.insert(tr.doc.content.size, type.create());
              }
              return true;
            })
            .run();
        },
    };
  },

  addNodeView() {
    return ({ editor, node, getPos }) => {
      const dom = document.createElement("sup");
      dom.className = "elium-fn-ref";
      dom.setAttribute("data-footnote-id", String(node.attrs.id ?? ""));

      const render = (current: typeof node) => {
        const myPos = typeof getPos === "function" ? getPos() : null;
        let rank = 0;
        let seen = 0;
        editor.state.doc.descendants((nd, pos) => {
          if (nd.type.name === "footnote") {
            seen++;
            if (myPos != null && pos <= myPos) rank = seen;
          }
          return true;
        });
        dom.textContent = String(rank || seen || 1);
        dom.title = String(current.attrs.text ?? "");
      };

      render(node);
      const onUpdate = () => render(node);
      editor.on("update", onUpdate);

      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type.name !== "footnote") return false;
          render(updated);
          return true;
        },
        destroy: () => editor.off("update", onUpdate),
      };
    };
  },
});

/**
 * FootnotesList: an atomic block, like the table of contents, that renders the
 * live, auto-numbered list of every footnote's text at the bottom of the doc.
 * Derived from the document, so it never goes stale; stores nothing itself.
 */
export const FootnotesList = Node.create({
  name: "footnotesList",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [{ tag: "div[data-footnotes]" }];
  },

  renderHTML() {
    return ["div", { "data-footnotes": "true", class: "elium-footnotes" }];
  },

  addCommands() {
    return {
      insertFootnotesList:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },

  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement("div");
      dom.className = "elium-footnotes";
      dom.setAttribute("data-footnotes", "true");
      dom.contentEditable = "false";

      const render = () => {
        const items: string[] = [];
        editor.state.doc.descendants((node) => {
          if (node.type.name === "footnote") items.push(String(node.attrs.text || ""));
          return true;
        });

        dom.replaceChildren();
        const title = document.createElement("div");
        title.className = "elium-footnotes__title";
        title.textContent = "Notes de bas de page";
        dom.appendChild(title);

        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "elium-footnotes__empty";
          empty.textContent = "Insérez des appels de note dans le texte pour les voir listés ici.";
          dom.appendChild(empty);
          return;
        }

        const list = document.createElement("ol");
        list.className = "elium-footnotes__list";
        for (const text of items) {
          const li = document.createElement("li");
          li.className = "elium-footnotes__item";
          li.textContent = text || "(note vide)";
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
        update: (node) => node.type.name === "footnotesList",
        destroy: () => editor.off("update", onUpdate),
      };
    };
  },
});

/**
 * ParagraphStyle: adds a named, reusable style to paragraphs (e.g. "subtitle",
 * "lead"), rendered as a data-attribute + class so it round-trips in the JSON
 * and is themed via CSS. Headings/quotes keep their own block types; this only
 * names paragraph variants the toolbar's style picker can apply.
 */
/**
 * Bookmark: a named, inline anchor (signet) the reader can jump to. Stored as an
 * inline atom carrying { id, label }; the id is mirrored onto the DOM element so
 * internal links (href="#id") scroll to it. Round-trips inside the document JSON.
 */
export const Bookmark = Node.create({
  name: "bookmark",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: null },
      label: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-bookmark-id]" }];
  },

  renderHTML({ node }) {
    const id = node.attrs.id == null ? "" : String(node.attrs.id);
    const label = node.attrs.label == null ? "" : String(node.attrs.label);
    return [
      "span",
      { id, "data-bookmark-id": id, "data-bookmark-label": label, class: "elium-bookmark" },
      `\u{1F516} ${label}`,
    ];
  },

  addCommands() {
    return {
      insertBookmark:
        (label) =>
        ({ chain }) =>
          chain()
            .insertContent({ type: this.name, attrs: { id: newBookmarkId(), label } })
            .run(),
    };
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "elium-bookmark";
      dom.contentEditable = "false";
      const id = String(node.attrs.id ?? "");
      const label = String(node.attrs.label ?? "");
      dom.id = id;
      dom.setAttribute("data-bookmark-id", id);
      dom.textContent = `\u{1F516} ${label}`;
      dom.title = `Signet : ${label}`;
      return { dom, ignoreMutation: () => true };
    };
  },
});

export const ParagraphStyle = Extension.create({
  name: "paragraphStyle",

  addOptions() {
    return { types: ["paragraph"] as string[] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          dataStyle: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-style") || null,
            renderHTML: (attrs: Record<string, unknown>) => {
              const v = attrs.dataStyle;
              return v
                ? { "data-style": String(v), class: `elium-pstyle elium-pstyle--${String(v)}` }
                : {};
            },
          },
        },
      },
    ];
  },
});
