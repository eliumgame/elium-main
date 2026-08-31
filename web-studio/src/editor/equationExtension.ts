/**
 * Equations (Elium's minimal equation editor) — a pragmatic v1, not a full
 * equation-editor rewrite:
 *   - a document stores only the LaTeX SOURCE on the node, never a rendered
 *     bitmap or a bespoke expression tree, so the `.elium` stays small and the
 *     equation is trivially re-editable later;
 *   - the RICH rendering (glyphs, fractions, radicals…) is delegated to KaTeX,
 *     the one math-typesetting library light enough to fit this project's
 *     dependency budget (a few hundred KB, MIT-licensed, no runtime DOM
 *     dependency — see `equationExtension.test.ts`/`doc-equation.test.ts` for
 *     why that matters for export too). It is loaded lazily (dynamic
 *     `import()`), so a document with no equation in it never pays for it —
 *     see `vite.config.ts`'s `vendor-katex` chunk;
 *   - at EXPORT (HTML/Markdown/plain text/DOCX), embedding KaTeX's own
 *     stylesheet and web fonts into every exported file would bloat it for a
 *     handful of formulas, and Word has no OMML writer here worth building for
 *     a v1 — so export falls back to the plain LaTeX source, legible on its
 *     own and always round-trippable back into a real equation on re-import
 *     (see `export/exporters.ts` and `format/docx.ts`).
 *
 * Editing: clicking a rendered equation reopens the SAME dialog used to
 * insert one, pre-filled with its current source (see `EquationModal.tsx`).
 * The click is reported through a module-level listener exactly like
 * `TrackChanges.ts`'s `onTrackChangeRequest` — the node view has no route back
 * into the surrounding React tree, so a small pub/sub is the simplest bridge.
 */
import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    equation: {
      /** Insert a new equation at the cursor. */
      insertEquation: (latex: string) => ReturnType;
      /** Update an existing equation's source (`pos` is the node's own position). */
      updateEquation: (pos: number, latex: string) => ReturnType;
    };
  }
}

/** A request to edit one equation, raised by clicking it. */
export interface EquationEditRequest {
  pos: number;
  latex: string;
}

let requestListener: ((request: EquationEditRequest) => void) | null = null;

/** Subscribe to equation-click requests (opens the edit dialog pre-filled). */
export function onEquationEditRequest(fn: (request: EquationEditRequest) => void): () => void {
  requestListener = fn;
  return () => {
    if (requestListener === fn) requestListener = null;
  };
}

export const Equation = Node.create({
  name: "equation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return { latex: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-equation]",
        getAttrs: (el) => ({ latex: (el as HTMLElement).getAttribute("data-latex") ?? "" }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const latex = String(node.attrs.latex ?? "");
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-equation": "true", "data-latex": latex, class: "elium-equation" }),
      latex,
    ];
  },

  addNodeView() {
    return ({ node, getPos }) => {
      const dom = document.createElement("span");
      dom.className = "elium-equation";
      dom.contentEditable = "false";
      dom.setAttribute("data-equation", "true");

      const render = (current: typeof node) => {
        const latex = String(current.attrs.latex ?? "");
        dom.setAttribute("data-latex", latex);
        dom.textContent = latex || "≡"; // placeholder while KaTeX loads, or on failure
        void import("katex")
          .then((mod) => {
            const katex = mod.default ?? mod;
            katex.render(latex || " ", dom, { throwOnError: false, displayMode: false });
          })
          .catch(() => {
            // KaTeX failed to load (offline first run, bundling issue…): the
            // raw source stays visible rather than a blank node.
            dom.textContent = latex;
          });
      };

      render(node);
      dom.addEventListener("click", (e) => {
        e.preventDefault();
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos != null) requestListener?.({ pos, latex: String(node.attrs.latex ?? "") });
      });

      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type.name !== "equation") return false;
          render(updated);
          return true;
        },
      };
    };
  },

  addCommands() {
    return {
      insertEquation:
        (latex) =>
        ({ chain }) =>
          chain().insertContent({ type: "equation", attrs: { latex } }).run(),
      updateEquation:
        (pos, latex) =>
        ({ tr, dispatch }) => {
          const node = tr.doc.nodeAt(pos);
          if (!node || node.type.name !== "equation") return false;
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex });
          return true;
        },
    };
  },
});
