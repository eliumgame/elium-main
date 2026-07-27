/**
 * Lettrine et symboles côté TipTap.
 *
 * La lettrine est un **attribut de paragraphe**, pas un nœud : la lettre reste du
 * texte normal, éditable et cherchable, et seul son rendu change. En faire un
 * nœud aurait sorti la première lettre du flux — impossible à corriger sans
 * casser le mot, et invisible pour la recherche comme pour le correcteur.
 *
 * Le filigrane, lui, n'est pas ici : il appartient au document entier
 * (`EliumDocumentModel.watermark`) et se dessine en fond de feuille.
 */
import { Extension } from "@tiptap/core";
import { DEFAULT_DROP_LINES, clampDropLines, dropCapCss, type DropCapKind } from "./ornaments";

const PARAGRAPH_TYPES = ["paragraph"];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    ornaments: {
      /** Pose (ou retire) une lettrine sur le paragraphe courant. */
      setDropCap: (kind: DropCapKind, lines?: number) => ReturnType;
      /** Insère un symbole au curseur. */
      insertSymbol: (ch: string) => ReturnType;
    };
  }
}

function kindOf(v: unknown): DropCapKind {
  return v === "drop" || v === "margin" ? v : "none";
}

export const Ornaments = Extension.create({
  name: "eliumOrnaments",

  addGlobalAttributes() {
    return [
      {
        types: PARAGRAPH_TYPES,
        attributes: {
          dropCap: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const k = el.getAttribute("data-drop-cap");
              return k === "drop" || k === "margin" ? k : null;
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              const kind = kindOf(attrs.dropCap);
              if (kind === "none") return {};
              return { "data-drop-cap": kind, class: "elium-dropcap" };
            },
          },
          dropCapLines: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const n = Number(el.getAttribute("data-drop-lines"));
              return Number.isFinite(n) && n > 0 ? clampDropLines(n) : null;
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              if (kindOf(attrs.dropCap) === "none") return {};
              const n = clampDropLines(attrs.dropCapLines ?? DEFAULT_DROP_LINES);
              // La taille voyage dans une variable CSS : `::first-letter` ne peut
              // pas être stylé en ligne, donc la feuille de styles la consomme.
              return {
                "data-drop-lines": n,
                style: `--elium-dropcap:${(n * 1.5).toFixed(2)}em`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setDropCap:
        (kind, lines) =>
        ({ tr, state, dispatch }) => {
          const { from, to } = state.selection;
          if (!dispatch) return true;
          let touched = false;
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!PARAGRAPH_TYPES.includes(node.type.name)) return;
            touched = true;
            tr.setNodeMarkup(pos, null, {
              ...node.attrs,
              dropCap: kind === "none" ? null : kind,
              dropCapLines: kind === "none" ? null : clampDropLines(lines ?? DEFAULT_DROP_LINES),
            });
          });
          return touched;
        },
      insertSymbol:
        (ch) =>
        ({ commands }) => {
          const text = String(ch ?? "");
          if (!text) return false;
          return commands.insertContent(text);
        },
    };
  },
});

/** Le CSS de la lettrine, injecté une fois pour `::first-letter`. */
export function dropCapStyleSheet(): string {
  return (
    `.elium-prose p.elium-dropcap::first-letter{` +
    `float:left;font-size:var(--elium-dropcap,4.5em);line-height:1;` +
    `padding-right:.06em;margin-top:.05em;margin-bottom:-.08em;font-weight:600;` +
    `}` +
    `.elium-prose p.elium-dropcap[data-drop-cap="margin"]::first-letter{margin-left:-.7em;}`
  );
}

export { dropCapCss };
