/**
 * On-screen pagination for the Documents editor.
 *
 * ProseMirror is a single contiguous contenteditable, so real page sheets are
 * produced by measuring each top-level block and injecting a spacer WIDGET
 * decoration before any block that would overflow the current page (and after a
 * manual page break). The spacer fills the remainder of the outgoing page plus
 * an inter-sheet gap, so content lands on page boundaries exactly where print /
 * PDF / DOCX export break — and the reader sees stacked A4/Letter sheets.
 *
 * The planner (`planPages`) is PURE and keys off each block's INTRINSIC height.
 * Spacers are separate widgets that never change those heights, so the plan is a
 * fixed point of its own output — no measure↔relayout oscillation. A signature
 * guard in the view plugin stops re-dispatching once the plan is stable.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/** CSS spec: `1mm` renders as exactly 96px/25.4, independent of device DPI. */
export const CSS_PX_PER_MM = 96 / 25.4;

export interface PageMetrics {
  /** Printable content height of one page in px (page height minus margins). */
  pageContentPx: number;
  /** Visual gap between two sheets in px. */
  gapPx: number;
  /** Page left/right margins in px, so the gap bar can span the full sheet. */
  marginLeftPx: number;
  marginRightPx: number;
}

export interface PageInfo {
  pageCount: number;
  currentPage: number;
}

export interface MeasuredBlock {
  /** Document position directly before the top-level block. */
  pos: number;
  height: number;
  isPageBreak: boolean;
}

export interface PagePlan {
  /** A spacer widget goes before the block at `pos`, `height` px tall. */
  spacers: { pos: number; height: number }[];
  /** block pos → 1-based page the block starts on (for the current-page readout). */
  pageStartByPos: Map<number, number>;
  pageCount: number;
}

/**
 * Pure page-break planner. Walks the blocks in document order, tracking the px
 * used on the current page; a block that would overflow starts a new page (with
 * a spacer filling the gap), a manual page-break always does. Blocks taller than
 * a whole page simply span the extra pages. Deterministic and side-effect free.
 */
export function planPages(blocks: MeasuredBlock[], m: PageMetrics): PagePlan {
  const spacers: { pos: number; height: number }[] = [];
  const pageStartByPos = new Map<number, number>();
  const H = m.pageContentPx;
  if (!(H > 0)) return { spacers, pageStartByPos, pageCount: 1 };

  let used = 0;
  let page = 1;
  for (const b of blocks) {
    if (b.isPageBreak) {
      spacers.push({ pos: b.pos, height: Math.max(0, H - used) + m.gapPx });
      page += 1;
      used = 0;
      pageStartByPos.set(b.pos, page);
      continue;
    }
    if (used > 0 && used + b.height > H) {
      spacers.push({ pos: b.pos, height: H - used + m.gapPx });
      page += 1;
      used = b.height;
    } else {
      used += b.height;
    }
    pageStartByPos.set(b.pos, page);
    while (used > H) {
      used -= H;
      page += 1;
    }
  }
  return { spacers, pageStartByPos, pageCount: page };
}

/** 1-based page the given document position sits on, per a computed plan. */
export function pageAt(plan: PagePlan, state: EditorState, pos: number): number {
  let start = 0;
  state.doc.forEach((node, offset) => {
    if (pos >= offset && pos < offset + node.nodeSize) start = offset;
  });
  return plan.pageStartByPos.get(start) ?? 1;
}

const paginationKey = new PluginKey<DecorationSet>("eliumPagination");

function measureBlocks(view: EditorView): MeasuredBlock[] {
  const blocks: MeasuredBlock[] = [];
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    const height = dom && dom.nodeType === 1 ? dom.offsetHeight : 0;
    blocks.push({ pos: offset, height, isPageBreak: node.type.name === "pageBreak" });
  });
  return blocks;
}

function buildDecorations(state: EditorState, plan: PagePlan, m: PageMetrics): DecorationSet {
  const decos = plan.spacers.map((s, i) =>
    Decoration.widget(
      s.pos,
      () => {
        const wrap = document.createElement("div");
        wrap.className = "elium-page-gap";
        wrap.style.height = `${s.height}px`;
        wrap.setAttribute("contenteditable", "false");
        const bar = document.createElement("div");
        bar.className = "elium-page-gap__bar";
        bar.style.height = `${m.gapPx}px`;
        bar.style.marginLeft = `-${m.marginLeftPx}px`;
        bar.style.marginRight = `-${m.marginRightPx}px`;
        wrap.appendChild(bar);
        return wrap;
      },
      { side: -1, key: `pg-${i}-${s.pos}-${Math.round(s.height)}`, ignoreSelection: true },
    ),
  );
  return DecorationSet.create(state.doc, decos);
}

export interface PaginationOptions {
  /** Read the CURRENT page metrics (page size + margins may change at runtime). */
  getMetrics: () => PageMetrics | null;
  /** Report the live page count + current page to the surrounding UI. */
  onInfo?: (info: PageInfo) => void;
}

/** The TipTap extension. Enabled only when `getMetrics` is provided. */
export const Pagination = Extension.create<PaginationOptions>({
  name: "eliumPagination",

  addOptions() {
    return { getMetrics: () => null, onInfo: undefined };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<DecorationSet>({
        key: paginationKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(paginationKey) as DecorationSet | undefined;
            if (meta) return meta;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return paginationKey.getState(state);
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | 0 = 0;
          let lastSig = "";
          const recompute = () => {
            timer = 0;
            const m = options.getMetrics();
            if (!m) return;
            const plan = planPages(measureBlocks(view), m);
            const currentPage = pageAt(plan, view.state, view.state.selection.head);
            options.onInfo?.({ pageCount: plan.pageCount, currentPage });
            const sig = plan.spacers.map((s) => `${s.pos}:${Math.round(s.height)}`).join(",") + `#${plan.pageCount}`;
            if (sig === lastSig) return; // stable → don't dispatch again (no loop)
            lastSig = sig;
            const decos = buildDecorations(view.state, plan, m);
            view.dispatch(view.state.tr.setMeta(paginationKey, decos).setMeta("addToHistory", false));
          };
          // A short debounce coalesces rapid edits. setTimeout (not rAF) so it
          // still fires when the editor's tab is not the foreground tab.
          const schedule = () => {
            if (timer) return;
            timer = setTimeout(recompute, 50);
          };
          // Images/tables loading, window/pane resizes and font swaps all change
          // intrinsic heights — re-measure whenever the content box resizes.
          const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
          ro?.observe(view.dom);
          schedule();
          return {
            update: schedule,
            destroy() {
              if (timer) clearTimeout(timer);
              ro?.disconnect();
            },
          };
        },
      }),
    ];
  },
});
