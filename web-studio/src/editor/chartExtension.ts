/**
 * Graphique insérable dans un document : nœud bloc « atome » dont les attributs
 * portent TOUTES les données (type, titre, libellés, séries, options). Rendu par
 * la même mise en page que le Tableur (sheet/chart-layout.ts), exporté en vrai
 * graphique Word (`c:chart`) et en SVG pour l'HTML/PDF. Un clic ouvre la boîte
 * d'édition (ChartModal) via un petit bus, comme pour les équations.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { chartDataOf, chartSvg, type DocChartData } from "./chartData";

export { DEFAULT_CHART, chartDataOf, chartSvg, type DocChartData } from "./chartData";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docChart: {
      insertChart: (data: DocChartData) => ReturnType;
      updateChart: (pos: number, data: DocChartData) => ReturnType;
    };
  }
}

export interface ChartEditRequest {
  pos: number;
  data: DocChartData;
}

let listener: ((r: ChartEditRequest) => void) | null = null;
export function onChartEditRequest(fn: (r: ChartEditRequest) => void): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

export const DocChart = Node.create({
  name: "docChart",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      chartType: { default: "bar" },
      title: { default: "" },
      labels: { default: [] },
      series: { default: [] },
      opts: { default: null },
      widthMm: { default: 150 },
      heightMm: { default: 90 },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-doc-chart]",
        getAttrs: (el) => {
          try {
            return JSON.parse((el as HTMLElement).getAttribute("data-doc-chart") ?? "{}");
          } catch {
            return false;
          }
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-doc-chart": JSON.stringify(chartDataOf(node.attrs)),
        class: "elium-doc-chart",
      }),
    ];
  },

  addCommands() {
    const toAttrs = (d: DocChartData) => ({ ...d, opts: d.opts ?? null });
    return {
      insertChart:
        (data) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: toAttrs(data) }),
      updateChart:
        (pos, data) =>
        ({ tr, dispatch }) => {
          const node = tr.doc.nodeAt(pos);
          if (!node || node.type.name !== this.name) return false;
          if (dispatch) tr.setNodeMarkup(pos, undefined, toAttrs(data));
          return true;
        },
    };
  },

  addNodeView() {
    return ({ node, getPos }) => {
      const dom = document.createElement("div");
      dom.className = "elium-doc-chart";
      dom.contentEditable = "false";
      dom.setAttribute("data-doc-chart", "true");
      const render = (n: typeof node) => {
        dom.innerHTML = chartSvg(chartDataOf(n.attrs));
      };
      render(node);
      dom.addEventListener("click", (e) => {
        e.preventDefault();
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos != null) listener?.({ pos, data: chartDataOf(node.attrs) });
      });
      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type.name !== "docChart") return false;
          node = updated;
          render(updated);
          return true;
        },
      };
    };
  },
});
