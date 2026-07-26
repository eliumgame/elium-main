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
  /** Index of the section the block belongs to (0 when there are none). */
  sectionIndex?: number;
  /** True for a `sectionBreak` marker, which starts a page unless continuous. */
  isSectionBreak?: boolean;
  /** For a section break: does it start a new page (`continuous` does not)? */
  breaksPage?: boolean;
}

/** One rendered sheet: where it sits in the flow and which section it belongs to. */
export interface PlannedPage {
  /** 1-based page number as DISPLAYED (honours per-section restarts). */
  number: number;
  /** Offset of the sheet's top edge in the content flow, in px. */
  top: number;
  /** Full sheet height in px (content box + vertical margins). */
  height: number;
  sectionIndex: number;
}

export interface PagePlan {
  /** A spacer widget goes before the block at `pos`, `height` px tall. */
  spacers: { pos: number; height: number }[];
  /** block pos → 1-based page the block starts on (for the current-page readout). */
  pageStartByPos: Map<number, number>;
  pageCount: number;
  /** Sheets to draw, in order. */
  pages: PlannedPage[];
}

/** Per-section geometry the planner needs, in px. */
export interface SectionMetrics extends PageMetrics {
  /** Full sheet height (content + top/bottom margins), for drawing the sheet. */
  pageTotalPx: number;
  /** Page number this section restarts at, or null to continue. */
  restartAt: number | null;
}

const asSectionMetrics = (m: PageMetrics): SectionMetrics => ({
  ...m,
  pageTotalPx: m.pageContentPx,
  restartAt: null,
});

/**
 * Pure page-break planner. Walks the blocks in document order, tracking the px
 * used on the current page; a block that would overflow starts a new page (with
 * a spacer filling the gap), a manual page-break always does. Blocks taller than
 * a whole page simply span the extra pages. Deterministic and side-effect free.
 *
 * Sections: each block is planned against ITS OWN section's metrics, so a
 * landscape or A5 section breaks at its own height, and a section may restart the
 * page numbering. `metrics` is either one geometry for the whole document or one
 * entry per section.
 */
export function planPages(blocks: MeasuredBlock[], metrics: PageMetrics | SectionMetrics[]): PagePlan {
  const perSection: SectionMetrics[] = Array.isArray(metrics) ? metrics : [asSectionMetrics(metrics)];
  const first = perSection[0];
  const spacers: { pos: number; height: number }[] = [];
  const pageStartByPos = new Map<number, number>();
  const pages: PlannedPage[] = [];
  if (!first || !(first.pageContentPx > 0)) {
    return { spacers, pageStartByPos, pageCount: 1, pages };
  }

  const metricsFor = (i: number | undefined): SectionMetrics => perSection[i ?? 0] ?? first;

  let section = 0;
  let m = metricsFor(0);
  let used = 0;
  /** Sequential page index (1-based), independent of the displayed number. */
  let index = 1;
  /** Displayed number of the current page. */
  let display = m.restartAt ?? 1;
  let top = 0;

  const openPage = (sectionIndex: number, metric: SectionMetrics, displayed: number) => {
    pages.push({ number: displayed, top, height: metric.pageTotalPx, sectionIndex });
  };
  const closePage = (metric: SectionMetrics) => {
    top += metric.pageTotalPx + metric.gapPx;
  };

  openPage(0, m, display);

  for (const b of blocks) {
    // Clamp: a stale index (measurement and section list can be one frame apart)
    // must not invent a section change, and therefore not invent a page.
    const bSection = Math.max(0, Math.min(perSection.length - 1, b.sectionIndex ?? 0));

    // Entering a new section: switch metrics, and start a new page unless the
    // break is continuous.
    if (bSection !== section) {
      const nextMetrics = metricsFor(bSection);
      const startsPage = b.breaksPage !== false;
      if (startsPage) {
        spacers.push({ pos: b.pos, height: Math.max(0, m.pageContentPx - used) + m.gapPx });
        closePage(m);
        index += 1;
        display = nextMetrics.restartAt ?? display + 1;
        used = 0;
        section = bSection;
        m = nextMetrics;
        openPage(section, m, display);
      } else {
        // Continuous: the sheet keeps the geometry it started with, but the
        // following blocks belong to the new section.
        section = bSection;
        m = nextMetrics;
        if (nextMetrics.restartAt != null) display = nextMetrics.restartAt;
      }
      if (b.isSectionBreak) {
        pageStartByPos.set(b.pos, display);
        continue;
      }
    }

    if (b.isSectionBreak) {
      // A continuous break inside the same section index (defensive).
      pageStartByPos.set(b.pos, display);
      continue;
    }

    if (b.isPageBreak) {
      spacers.push({ pos: b.pos, height: Math.max(0, m.pageContentPx - used) + m.gapPx });
      closePage(m);
      index += 1;
      display += 1;
      used = 0;
      openPage(section, m, display);
      pageStartByPos.set(b.pos, display);
      continue;
    }

    if (used > 0 && used + b.height > m.pageContentPx) {
      spacers.push({ pos: b.pos, height: m.pageContentPx - used + m.gapPx });
      closePage(m);
      index += 1;
      display += 1;
      used = b.height;
      openPage(section, m, display);
    } else {
      used += b.height;
    }
    pageStartByPos.set(b.pos, display);
    while (used > m.pageContentPx) {
      used -= m.pageContentPx;
      closePage(m);
      index += 1;
      display += 1;
      openPage(section, m, display);
    }
  }

  return { spacers, pageStartByPos, pageCount: index, pages };
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
  // Section index advances at every top-level `sectionBreak`, mirroring
  // `sectionIndexByBlock` in sections.ts (kept in step by that shared rule).
  let section = 0;
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    const height = dom && dom.nodeType === 1 ? dom.offsetHeight : 0;
    const isSectionBreak = node.type.name === "sectionBreak";
    if (isSectionBreak) section += 1;
    blocks.push({
      pos: offset,
      height,
      isPageBreak: node.type.name === "pageBreak",
      sectionIndex: section,
      ...(isSectionBreak
        ? { isSectionBreak: true, breaksPage: String(node.attrs.kind ?? "nextPage") !== "continuous" }
        : {}),
    });
  });
  return blocks;
}

/**
 * Horizontal padding decorations: each top-level block is inset so its text
 * column is exactly its section's content width, centred inside the widest
 * sheet. ProseMirror APPENDS decoration styles to a node's own style, so this
 * coexists with node views that size themselves (figures, column sections).
 */
function sectionInsetDecorations(state: EditorState, sections: SectionInset[]): Decoration[] {
  if (sections.length < 2) return [];
  const decos: Decoration[] = [];
  let section = 0;
  state.doc.forEach((node, offset) => {
    if (node.type.name === "sectionBreak") section += 1;
    const inset = sections[Math.min(section, sections.length - 1)];
    if (!inset || (inset.leftPx === 0 && inset.rightPx === 0)) return;
    decos.push(
      Decoration.node(offset, offset + node.nodeSize, {
        style: `padding-left:${inset.leftPx}px;padding-right:${inset.rightPx}px`,
      }),
    );
  });
  return decos;
}

/** Extra inset (beyond the sheet's own margins) for one section's blocks. */
export interface SectionInset {
  leftPx: number;
  rightPx: number;
}

function buildDecorations(
  state: EditorState,
  plan: PagePlan,
  m: PageMetrics,
  insets: SectionInset[],
): DecorationSet {
  const decos: Decoration[] = plan.spacers.map((s, i) =>
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
  decos.push(...sectionInsetDecorations(state, insets));
  return DecorationSet.create(state.doc, decos);
}

export interface PaginationOptions {
  /** Read the CURRENT page metrics (page size + margins may change at runtime). */
  getMetrics: () => PageMetrics | null;
  /**
   * Per-section geometry, when the document mixes formats/orientations/margins.
   * Returning null (or a single entry) keeps the uniform single-sheet path.
   */
  getSectionMetrics?: () => SectionMetrics[] | null;
  /** Per-section horizontal insets, so text reflows at each section's width. */
  getSectionInsets?: () => SectionInset[] | null;
  /** Report the live page count + current page to the surrounding UI. */
  onInfo?: (info: PageInfo) => void;
  /**
   * Hand out the freshly computed plan. Features that need the page a given
   * position sits on — cross-references showing a page number, the generated
   * index — resolve it through `pageAt` on this plan rather than re-measuring.
   */
  onPlan?: (plan: PagePlan) => void;
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
            // Per-section geometry when the document mixes formats; otherwise the
            // single uniform geometry (the fast path for most documents).
            const sections = options.getSectionMetrics?.() ?? null;
            const insets = options.getSectionInsets?.() ?? [];
            const plan = planPages(measureBlocks(view), sections && sections.length ? sections : m);
            const currentPage = pageAt(plan, view.state, view.state.selection.head);
            options.onPlan?.(plan);
            options.onInfo?.({ pageCount: plan.pageCount, currentPage });
            const sig =
              plan.spacers.map((s) => `${s.pos}:${Math.round(s.height)}`).join(",") +
              `#${plan.pageCount}` +
              `#${plan.pages.map((p) => `${p.sectionIndex}:${Math.round(p.top)}:${Math.round(p.height)}`).join("|")}` +
              `#${insets.map((i) => `${Math.round(i.leftPx)}/${Math.round(i.rightPx)}`).join(",")}`;
            if (sig === lastSig) return; // stable → don't dispatch again (no loop)
            lastSig = sig;
            const decos = buildDecorations(view.state, plan, m, insets);
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
