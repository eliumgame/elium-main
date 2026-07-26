/**
 * Word-parity TipTap extensions for Documents.
 *
 * Each node/attribute here serializes naturally into the ProseMirror JSON stored
 * in a `.elium`, so everything round-trips with zero package-format change (the
 * same rule the extensions in `customExtensions.ts` follow):
 *
 *   - ListSchemes   : multilevel numbering schemes on bullet/ordered lists
 *   - ColumnSection : a real multi-column block (newspaper columns)
 *   - SectionBreak  : a section boundary carrying its own page setup
 *   - CrossReference: an auto-updating renvoi to a bookmark/heading/figure/…
 *   - IndexEntry    : an index mark (Word's XE field)
 *   - IndexBlock    : the generated, live alphabetical index
 *   - MergeField    : a mail-merge placeholder (Word's MERGEFIELD)
 */
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { LIST_SCHEMES, schemeById } from "./listSchemes";
import { collectTargets, newAnchorId, referenceLabel, type RefDisplay, type RefTarget } from "./crossref";
import { buildIndex } from "./indexing";
import { sectionBreakLabelFor, type SectionBreakKind } from "./sections";

const LIST_TYPES = ["bulletList", "orderedList"];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    listSchemes: {
      /** Apply a multilevel scheme (or `null` for native markers) to the list
       *  containing the selection, creating the list if there is none. */
      setListScheme: (schemeId: string | null) => ReturnType;
    };
    columnSection: {
      /** Wrap the selected blocks in a multi-column section. */
      setColumns: (attrs: { count: number; gapMm?: number; separator?: boolean }) => ReturnType;
      /** Update the column section containing the selection. */
      updateColumns: (attrs: { count?: number; gapMm?: number; separator?: boolean }) => ReturnType;
      /** Unwrap the column section containing the selection. */
      unsetColumns: () => ReturnType;
    };
    sectionBreak: {
      insertSectionBreak: (attrs: SectionBreakAttrs) => ReturnType;
    };
    crossReference: {
      /** Insert a renvoi to the target at `pos` (from the picker), stamping a
       *  stable anchor id on it first when it has none. */
      insertCrossReference: (attrs: { pos: number; kind: RefTarget["kind"]; display: RefDisplay }) => ReturnType;
    };
    indexEntry: {
      insertIndexEntry: (attrs: { term: string; sub?: string }) => ReturnType;
    };
    indexBlock: {
      insertIndexBlock: () => ReturnType;
    };
    mergeField: {
      insertMergeField: (field: string) => ReturnType;
    };
  }
}

/** A page-number provider: maps a document position to its 1-based page.
 *  Supplied by the editor (the pagination plugin owns the real numbers), so the
 *  pure nodes here never depend on layout. */
export type PageResolver = (pos: number) => number;
let pageResolver: PageResolver | null = null;

/** Register the live page resolver (called by the Documents editor). */
export function setPageResolver(fn: PageResolver | null): void {
  pageResolver = fn;
}
/** 1-based page a document position sits on, or null when unknown. */
export function pageOfPos(pos: number): number | null {
  try {
    return pageResolver ? pageResolver(pos) : null;
  } catch {
    return null;
  }
}
const pageOf = pageOfPos;

// =========================================================================
// Multilevel lists
// =========================================================================

/** The shallowest list enclosing `pos`, resolved against a given document. */
function outerListAt(doc: PMNode, pos: number): { pos: number; node: PMNode } | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = 1; d <= $pos.depth; d++) {
    const node = $pos.node(d);
    if (LIST_TYPES.includes(node.type.name)) return { pos: $pos.before(d), node };
  }
  return null;
}

/**
 * Adds a `listScheme` attribute to bullet/ordered lists. The attribute lands on
 * the OUTERMOST list of a tree; the generated CSS (see `listSchemes.ts`) and the
 * exporters inherit it into descendant lists, so pressing Tab to create a
 * sublist automatically uses the scheme's next level.
 */
export const ListSchemes = Extension.create({
  name: "listSchemes",

  addGlobalAttributes() {
    return [
      {
        types: LIST_TYPES,
        attributes: {
          listScheme: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-list-scheme") || null,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.listScheme ? { "data-list-scheme": String(attrs.listScheme) } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setListScheme:
        (schemeId) =>
        ({ state, tr, dispatch, commands }) => {
          const scheme = schemeById(schemeId);

          // Not in a list yet? Create the matching kind first — Word's gallery
          // turns the current paragraphs into a list. The toggle writes into the
          // SAME transaction, so everything below resolves against `tr.doc`
          // rather than `state.doc` (which still shows the pre-toggle document).
          if (!outerListAt(state.doc, state.selection.from)) {
            const created = scheme?.kind === "bullet" ? commands.toggleBulletList() : commands.toggleOrderedList();
            if (!created) return false;
          }

          // The scheme owns the whole tree, so it lands on the shallowest
          // enclosing list — exactly like applying a multilevel list in Word.
          const found = outerListAt(tr.doc, tr.selection.from);
          if (!found) return false;
          if (!dispatch) return true;

          tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, listScheme: schemeId ?? null });
          // Descendant lists must not carry a competing scheme, or CSS
          // inheritance and the exporters would disagree about their level.
          found.node.descendants((child, offset) => {
            if (LIST_TYPES.includes(child.type.name) && child.attrs.listScheme) {
              tr.setNodeMarkup(found.pos + 1 + offset, undefined, { ...child.attrs, listScheme: null });
            }
            return true;
          });
          dispatch(tr);
          return true;
        },
    };
  },
});

/** The gallery entries the ribbon shows (id, label, preview). */
export const LIST_SCHEME_GALLERY = LIST_SCHEMES;

// =========================================================================
// Columns
// =========================================================================

export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 4;

/**
 * A real multi-column block: content flows across `count` columns via CSS
 * multi-column layout, so it behaves the same on screen, in printed/PDF output
 * and (as a `w:sectPr` with `w:cols`) in DOCX.
 */
export const ColumnSection = Node.create({
  name: "columnSection",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      count: {
        default: 2,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-columns")) || 2,
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-columns": String(attrs.count ?? 2) }),
      },
      gapMm: {
        default: 8,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-column-gap")) || 8,
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-column-gap": String(attrs.gapMm ?? 8) }),
      },
      separator: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-column-rule") === "true",
        renderHTML: (attrs: Record<string, unknown>) => (attrs.separator ? { "data-column-rule": "true" } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-columns]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const count = clampColumns(Number(node.attrs.count));
    const gap = Number(node.attrs.gapMm) || 8;
    const rule = node.attrs.separator ? `;column-rule:1px solid #cbd5e1` : "";
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        class: "elium-columns",
        style: `column-count:${count};column-gap:${gap}mm${rule}`,
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setColumns:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, {
            count: clampColumns(attrs.count),
            gapMm: attrs.gapMm ?? 8,
            separator: attrs.separator ?? false,
          }),
      updateColumns:
        (attrs) =>
        ({ commands, editor }) => {
          const current = editor.getAttributes(this.name);
          return commands.updateAttributes(this.name, {
            count: clampColumns(Number(attrs.count ?? current.count)),
            gapMm: attrs.gapMm ?? current.gapMm ?? 8,
            separator: attrs.separator ?? current.separator ?? false,
          });
        },
      unsetColumns:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});

export function clampColumns(n: number): number {
  if (!Number.isFinite(n)) return 2;
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(n)));
}

// =========================================================================
// Section breaks
// =========================================================================

export type { SectionBreakKind } from "./sections";

export interface SectionBreakAttrs {
  kind: SectionBreakKind;
  /** Page-setup overrides for the section that STARTS at this break. Empty
   *  fields inherit the document's own page settings. */
  format?: string;
  orientation?: "portrait" | "landscape" | "";
  customWidthMm?: number;
  customHeightMm?: number;
  /** Per-section margins in mm; omitted = inherit the document's. */
  margins?: { top: number; right: number; bottom: number; left: number };
  /** Restart page numbering at `startAt` from this section on. */
  restartNumbering?: boolean;
  startAt?: number;
  /** Per-section header/footer override ("" = inherit). */
  header?: string;
  footer?: string;
}

/** Re-exported so the ribbon and the node view share the exporters' wording. */
export const sectionBreakLabel = sectionBreakLabelFor;

/**
 * A section boundary. Everything after it (until the next break) forms a new
 * section whose page setup may differ from the document default — orientation,
 * header/footer, and page-number restart. `continuous` starts a new section
 * without starting a new page.
 */
export const SectionBreak = Node.create({
  name: "sectionBreak",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: "nextPage" as SectionBreakKind },
      format: { default: "" },
      orientation: { default: "" },
      customWidthMm: { default: null },
      customHeightMm: { default: null },
      margins: { default: null },
      restartNumbering: { default: false },
      startAt: { default: 1 },
      header: { default: "" },
      footer: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-section-break]" }];
  },

  renderHTML({ node }) {
    return [
      "div",
      {
        "data-section-break": String(node.attrs.kind ?? "nextPage"),
        "data-section-orientation": String(node.attrs.orientation ?? ""),
        "data-section-restart": node.attrs.restartNumbering ? "true" : "false",
        "data-section-start": String(node.attrs.startAt ?? 1),
        class: "elium-section-break",
      },
    ];
  },

  addCommands() {
    return {
      insertSectionBreak:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { ...attrs } }),
    };
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "elium-section-break";
      dom.contentEditable = "false";
      const render = (n: PMNode) => {
        dom.setAttribute("data-section-break", String(n.attrs.kind ?? "nextPage"));
        const extras: string[] = [];
        if (n.attrs.orientation) extras.push(n.attrs.orientation === "landscape" ? "paysage" : "portrait");
        if (n.attrs.restartNumbering) extras.push(`n° ${Number(n.attrs.startAt) || 1}`);
        const label = sectionBreakLabel(n.attrs.kind) + (extras.length ? ` · ${extras.join(" · ")}` : "");
        dom.setAttribute("data-label", label);
        dom.title = label;
      };
      render(node);
      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type.name !== "sectionBreak") return false;
          render(updated);
          return true;
        },
      };
    };
  },
});

// =========================================================================
// Cross-references (renvois)
// =========================================================================

/**
 * Adds a `refId` anchor to the objects a renvoi can point at but which carry no
 * id of their own. It is stamped lazily, the first time a reference targets the
 * object, so ordinary documents keep a clean JSON — and once stamped the renvoi
 * survives the target being moved or renumbered.
 */
export const RefAnchors = Extension.create({
  name: "refAnchors",

  addGlobalAttributes() {
    return [
      {
        types: ["heading", "figure", "table"],
        attributes: {
          refId: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-ref-id") || null,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.refId ? { "data-ref-id": String(attrs.refId), id: String(attrs.refId) } : {},
          },
        },
      },
    ];
  },
});

/**
 * A renvoi: an inline atom that stores only WHAT it points at, and derives the
 * text it shows from the current document on every render — so it can never go
 * stale (same principle as the table of contents and the footnotes list).
 */
export const CrossReference = Node.create({
  name: "crossReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      targetId: { default: null },
      kind: { default: "bookmark" },
      display: { default: "text" },
      /** Last rendered text, kept only as a fallback for readers that cannot
       *  recompute (plain HTML/DOCX consumers). Never trusted on screen. */
      cached: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "a[data-crossref-target]" }];
  },

  renderHTML({ node }) {
    const target = String(node.attrs.targetId ?? "");
    return [
      "a",
      {
        href: `#${target}`,
        "data-crossref-target": target,
        "data-crossref-kind": String(node.attrs.kind ?? "bookmark"),
        "data-crossref-display": String(node.attrs.display ?? "text"),
        class: "elium-xref",
      },
      String(node.attrs.cached || "…"),
    ];
  },

  addCommands() {
    return {
      insertCrossReference:
        (attrs) =>
        ({ chain, state }) => {
          const target = collectTargets(state.doc).find((t) => t.pos === attrs.pos && t.kind === attrs.kind);
          if (!target) return false;
          const name = this.name;
          // Bookmarks and footnotes already own a stable id; headings, figures
          // and tables get one stamped now (setNodeMarkup keeps every position,
          // so the insert that follows in the same chain stays correct).
          const anchorId = target.anchorId || newAnchorId(target.kind);
          const cached = referenceLabel(target, attrs.display, {
            targetPage: pageOf(target.pos),
            refPos: state.selection.from,
          });
          return chain()
            .command(({ tr, dispatch }) => {
              if (target.anchorId) return true;
              const node = tr.doc.nodeAt(attrs.pos);
              if (!node) return false;
              if (dispatch) tr.setNodeMarkup(attrs.pos, undefined, { ...node.attrs, refId: anchorId });
              return true;
            })
            .insertContent({ type: name, attrs: { targetId: anchorId, kind: attrs.kind, display: attrs.display, cached } })
            .run();
        },
    };
  },

  addNodeView() {
    return ({ editor, node, getPos }) => {
      const dom = document.createElement("a");
      dom.className = "elium-xref";
      dom.contentEditable = "false";

      const render = (current: PMNode) => {
        const id = String(current.attrs.targetId ?? "");
        const display = String(current.attrs.display ?? "text") as RefDisplay;
        const targets = collectTargets(editor.state.doc);
        const target = targets.find((t) => t.anchorId === id);
        dom.href = `#${id}`;
        dom.setAttribute("data-crossref-target", id);
        if (!target) {
          dom.textContent = "Renvoi introuvable";
          dom.classList.add("elium-xref--broken");
          dom.title = "La cible de ce renvoi n'existe plus.";
          return;
        }
        dom.classList.remove("elium-xref--broken");
        const selfPos = typeof getPos === "function" ? getPos() : null;
        const text = referenceLabel(target, display, {
          targetPage: pageOf(target.pos),
          refPage: selfPos == null ? null : pageOf(selfPos),
        });
        dom.textContent = text;
        dom.title = `Renvoi vers : ${target.label}`;
      };

      render(node);
      let current = node;
      const onUpdate = () => render(current);
      editor.on("update", onUpdate);
      editor.on("selectionUpdate", onUpdate);

      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type.name !== "crossReference") return false;
          current = updated;
          render(updated);
          return true;
        },
        destroy: () => {
          editor.off("update", onUpdate);
          editor.off("selectionUpdate", onUpdate);
        },
      };
    };
  },
});

// =========================================================================
// Index
// =========================================================================

/** An index mark (Word's `XE` field): invisible in print, a chip while editing. */
export const IndexEntry = Node.create({
  name: "indexEntry",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      term: { default: "" },
      sub: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-index-term]" }];
  },

  renderHTML({ node }) {
    return [
      "span",
      {
        "data-index-term": String(node.attrs.term ?? ""),
        "data-index-sub": String(node.attrs.sub ?? ""),
        class: "elium-index-mark",
      },
    ];
  },

  addCommands() {
    return {
      insertIndexEntry:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { term: attrs.term, sub: attrs.sub ?? "" },
          }),
    };
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "elium-index-mark";
      dom.contentEditable = "false";
      const term = String(node.attrs.term ?? "");
      const sub = String(node.attrs.sub ?? "");
      dom.setAttribute("data-index-term", term);
      dom.textContent = "⌗";
      dom.title = `Entrée d'index : ${term}${sub ? ` › ${sub}` : ""}`;
      return { dom, ignoreMutation: () => true };
    };
  },
});

/**
 * The generated index: an atomic block that rebuilds itself from the document's
 * index marks on every edit, grouped by initial letter with live page numbers.
 */
export const IndexBlock = Node.create({
  name: "indexBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [{ tag: "div[data-index-block]" }];
  },

  renderHTML() {
    return ["div", { "data-index-block": "true", class: "elium-index" }];
  },

  addCommands() {
    return {
      insertIndexBlock:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },

  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement("div");
      dom.className = "elium-index";
      dom.setAttribute("data-index-block", "true");
      dom.contentEditable = "false";

      const render = () => {
        const groups = buildIndex(editor.state.doc, (pos) => pageOf(pos));
        dom.replaceChildren();
        const title = document.createElement("div");
        title.className = "elium-index__title";
        title.textContent = "Index";
        dom.appendChild(title);

        if (!groups.length) {
          const empty = document.createElement("div");
          empty.className = "elium-index__empty";
          empty.textContent = "Marquez des entrées d'index dans le texte pour les voir listées ici.";
          dom.appendChild(empty);
          return;
        }

        for (const group of groups) {
          const letter = document.createElement("div");
          letter.className = "elium-index__letter";
          letter.textContent = group.letter;
          dom.appendChild(letter);
          const list = document.createElement("ul");
          list.className = "elium-index__list";
          for (const entry of group.entries) {
            const li = document.createElement("li");
            li.className = "elium-index__entry";
            const term = document.createElement("span");
            term.className = "elium-index__term";
            term.textContent = entry.term;
            li.appendChild(term);
            if (entry.pages.length) {
              const pages = document.createElement("span");
              pages.className = "elium-index__pages";
              pages.textContent = entry.pages.join(", ");
              li.appendChild(pages);
            }
            if (entry.subs.length) {
              const subList = document.createElement("ul");
              subList.className = "elium-index__sublist";
              for (const sub of entry.subs) {
                const subLi = document.createElement("li");
                subLi.className = "elium-index__sub";
                const subTerm = document.createElement("span");
                subTerm.textContent = sub.term;
                subLi.appendChild(subTerm);
                if (sub.pages.length) {
                  const subPages = document.createElement("span");
                  subPages.className = "elium-index__pages";
                  subPages.textContent = sub.pages.join(", ");
                  subLi.appendChild(subPages);
                }
                subList.appendChild(subLi);
              }
              li.appendChild(subList);
            }
            list.appendChild(li);
          }
          dom.appendChild(list);
        }
      };

      render();
      const onUpdate = () => render();
      editor.on("update", onUpdate);

      return {
        dom,
        ignoreMutation: () => true,
        update: (node) => node.type.name === "indexBlock",
        destroy: () => editor.off("update", onUpdate),
      };
    };
  },
});

// =========================================================================
// Mail-merge fields
// =========================================================================

/** Live preview record, set by the mail-merge dialog so fields show real data. */
let mergePreview: Record<string, string> | null = null;
const previewListeners = new Set<() => void>();

/**
 * Switch the preview record. Merge-field node views subscribe rather than
 * relying on an editor transaction: ProseMirror only re-runs a node view when
 * its NODE changes, and switching preview record changes no node at all.
 */
export function setMergePreview(record: Record<string, string> | null): void {
  mergePreview = record;
  for (const fn of [...previewListeners]) fn();
}
export function getMergePreview(): Record<string, string> | null {
  return mergePreview;
}
function onMergePreviewChange(fn: () => void): () => void {
  previewListeners.add(fn);
  return () => previewListeners.delete(fn);
}

/** A mail-merge placeholder — Word's `«Champ»` / `MERGEFIELD`. */
export const MergeField = Node.create({
  name: "mergeField",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      field: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-merge-field]" }];
  },

  renderHTML({ node }) {
    const field = String(node.attrs.field ?? "");
    return ["span", { "data-merge-field": field, class: "elium-mergefield" }, `«${field}»`];
  },

  addCommands() {
    return {
      insertMergeField:
        (field) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { field } }),
    };
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "elium-mergefield";
      dom.contentEditable = "false";

      let current = node;
      const render = () => {
        const field = String(current.attrs.field ?? "");
        dom.setAttribute("data-merge-field", field);
        const preview = mergePreview?.[field];
        if (preview != null && preview !== "") {
          dom.textContent = preview;
          dom.classList.add("elium-mergefield--preview");
          dom.title = `Champ de fusion « ${field} » — aperçu`;
        } else {
          dom.textContent = `«${field}»`;
          dom.classList.remove("elium-mergefield--preview");
          dom.title = `Champ de fusion « ${field} »`;
        }
      };

      render();
      const unsubscribe = onMergePreviewChange(render);
      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type.name !== "mergeField") return false;
          current = updated;
          render();
          return true;
        },
        destroy: unsubscribe,
      };
    };
  },
});
