/**
 * Les styles de tableau côté TipTap.
 *
 * Le style et l'ajustement sont des attributs du nœud `table` ; les classes de
 * trame sont posées sur chaque ligne par un plugin de décoration, **déduites de
 * la position**. Stocker la trame dans chaque cellule aurait voulu dire la
 * recalculer à chaque insertion de ligne — et l'oublier une fois suffit pour que
 * le tableau se retrouve avec deux lignes grises côte à côte.
 *
 * Le tri réordonne les vrais nœuds de ligne, avec toute leur mise en forme :
 * `sortRowOrder` ne rend qu'une permutation d'indices, précisément pour cela.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  DEFAULT_TABLE_STYLE,
  isBandedColumn,
  normalizeFit,
  normalizeVAlign,
  rowClasses,
  sortRowOrder,
  tableStyleById,
  type CellVAlign,
  type SortDir,
  type TableFit,
  type TableStyleId,
} from "./tableStyles";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableStyles: {
      /** Applique un style au tableau courant. */
      setTableStyle: (id: TableStyleId) => ReturnType;
      /** Change le mode d'ajustement du tableau courant. */
      setTableFit: (fit: TableFit) => ReturnType;
      /** Aligne verticalement les cellules sélectionnées. */
      setCellVAlign: (v: CellVAlign) => ReturnType;
      /** Trie les lignes du tableau courant sur une colonne. */
      sortTableRows: (colIndex: number, dir: SortDir) => ReturnType;
    };
  }
}

interface TableInfo {
  pos: number;
  node: {
    nodeSize: number;
    childCount: number;
    child: (i: number) => { type: { name: string }; childCount: number; child: (j: number) => { textContent: string } };
    attrs: Record<string, unknown>;
    type: { name: string };
  };
}

/** Le tableau qui contient le curseur, avec sa position. */
function tableAt(state: {
  selection: {
    $from: { depth: number; node: (d: number) => { type: { name: string } }; before: (d: number) => number };
  };
}): TableInfo | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "table") return { pos: $from.before(d), node: node as never };
  }
  return null;
}

const tableStyleKey = new PluginKey("eliumTableStyle");

export const TableStyles = Extension.create({
  name: "eliumTableStyles",

  addGlobalAttributes() {
    return [
      {
        types: ["table"],
        attributes: {
          tableStyle: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-table-style"),
            renderHTML: (attrs: Record<string, unknown>) => {
              const id = tableStyleById(attrs.tableStyle).id;
              return { "data-table-style": id };
            },
          },
          tableFit: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-table-fit"),
            renderHTML: (attrs: Record<string, unknown>) => {
              const fit = normalizeFit(attrs.tableFit);
              return fit === "auto" ? {} : { "data-table-fit": fit };
            },
          },
        },
      },
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          vAlign: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-valign"),
            renderHTML: (attrs: Record<string, unknown>) => {
              const v = normalizeVAlign(attrs.vAlign);
              return v === "top" ? {} : { "data-valign": v };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setTableStyle:
        (id) =>
        ({ tr, state, dispatch }) => {
          const info = tableAt(state as never);
          if (!info) return false;
          if (dispatch) tr.setNodeMarkup(info.pos, null, { ...info.node.attrs, tableStyle: id });
          return true;
        },
      setTableFit:
        (fit) =>
        ({ tr, state, dispatch }) => {
          const info = tableAt(state as never);
          if (!info) return false;
          if (dispatch) tr.setNodeMarkup(info.pos, null, { ...info.node.attrs, tableFit: normalizeFit(fit) });
          return true;
        },
      setCellVAlign:
        (v) =>
        ({ tr, state, dispatch }) => {
          const { from, to } = state.selection;
          let touched = false;
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name !== "tableCell" && node.type.name !== "tableHeader") return;
            touched = true;
            if (dispatch) tr.setNodeMarkup(pos, null, { ...node.attrs, vAlign: normalizeVAlign(v) });
          });
          return touched;
        },
      sortTableRows:
        (colIndex, dir) =>
        ({ tr, state, dispatch }) => {
          const info = tableAt(state as never);
          if (!info) return false;
          const table = state.doc.nodeAt(info.pos);
          if (!table) return false;

          // Matrice de textes pour le comparateur, et les nœuds pour la
          // réécriture : le tri porte sur le texte, le résultat déplace les
          // VRAIS nœuds, donc rien de la mise en forme n'est perdu.
          const rowNodes: unknown[] = [];
          const matrix: string[][] = [];
          let hasHeader = false;
          table.forEach((row, _off, index) => {
            rowNodes.push(row);
            const cells: string[] = [];
            row.forEach((cell) => {
              cells.push(cell.textContent.trim());
              if (index === 0 && cell.type.name === "tableHeader") hasHeader = true;
            });
            matrix.push(cells);
          });
          if (matrix.length < 2) return false;

          const order = sortRowOrder(matrix, colIndex, dir, hasHeader);
          const unchanged = order.every((v, i) => v === i);
          if (unchanged) return false;
          if (dispatch) {
            const reordered = order.map((i) => rowNodes[i]);
            const start = info.pos + 1;
            tr.replaceWith(start, start + table.content.size, reordered as never);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: tableStyleKey,
        props: {
          // Les trames sont des DÉCORATIONS : elles se recalculent à chaque
          // transaction depuis la position des lignes, donc insérer ou supprimer
          // une ligne réattribue les bandes sans toucher au document.
          decorations: (state) => {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "table") return true;
              const style = tableStyleById(node.attrs.tableStyle ?? DEFAULT_TABLE_STYLE);
              // Rien n'est décoré sur le TABLEAU : sa vue de nœud (tableau
              // redimensionnable) reconstruit son `<table>` et ignore les
              // attributs de décoration. Le style et l'ajustement voyagent donc
              // en classes sur les lignes, que le CSS remonte avec `:has()`.
              const fit = normalizeFit(node.attrs.tableFit);
              let hasHeader = false;
              node.forEach((row, _o, index) => {
                if (index !== 0) return;
                row.forEach((cell) => {
                  if (cell.type.name === "tableHeader") hasHeader = true;
                });
              });
              node.forEach((row, offset, index) => {
                const rowPos = pos + 1 + offset;
                const classes = rowClasses(style, index, hasHeader);
                if (fit !== "auto") classes.push(`tfit-${fit}`);
                if (classes.length) {
                  decos.push(Decoration.node(rowPos, rowPos + row.nodeSize, { class: classes.join(" ") }));
                }
                if (style.band === "cols") {
                  row.forEach((cell, cellOffset, cellIndex) => {
                    if (!isBandedColumn(style, cellIndex)) return;
                    const cellPos = rowPos + 1 + cellOffset;
                    decos.push(Decoration.node(cellPos, cellPos + cell.nodeSize, { class: "is-banded-col" }));
                  });
                }
              });
              return true;
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
