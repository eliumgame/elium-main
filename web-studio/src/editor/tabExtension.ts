/**
 * Les taquets côté TipTap : l'attribut de paragraphe et le nœud de tabulation.
 *
 * Une tabulation n'est pas un caractère `\t` : sa largeur dépend de *où elle se
 * trouve* sur la ligne et du taquet suivant, ce qu'aucune propriété CSS ne sait
 * exprimer (`tab-size` ne connaît que des taquets réguliers). C'est donc un nœud
 * en ligne dont la vue mesure sa propre position et se donne la largeur qui mène
 * au taquet suivant — la seule partie du système qui a besoin du DOM, tout le
 * calcul restant dans `tabs.ts`.
 */
import { Extension, Node } from "@tiptap/core";
import { CSS_PX_PER_MM } from "./Pagination";
import {
  DEFAULT_TAB_MM, LEADER_CHAR, addStop, normalizeStops, nextStop, removeStopNear,
  type TabAlign, type TabLeader, type TabStop,
} from "./tabs";

/** Les types de blocs qui peuvent porter des taquets. */
const PARAGRAPH_TYPES = ["paragraph", "heading"];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tabStops: {
      /** Remplace les taquets du ou des paragraphes sélectionnés. */
      setTabStops: (stops: TabStop[]) => ReturnType;
      /** Ajoute un taquet au paragraphe courant. */
      addTabStop: (stop: TabStop) => ReturnType;
      /** Retire le taquet le plus proche d'une position (en mm). */
      removeTabStop: (posMm: number) => ReturnType;
      /** Efface tous les taquets du paragraphe courant. */
      clearTabStops: () => ReturnType;
      /** Insère une tabulation au curseur. */
      insertTab: () => ReturnType;
    };
  }
}

function parseStopsAttr(value: unknown): TabStop[] {
  if (typeof value === "string") {
    try {
      return normalizeStops(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return normalizeStops(value);
}

/**
 * Les taquets du bloc qui contient une position donnée.
 *
 * Sert à la règle et au dimensionnement des tabulations : les deux doivent lire
 * la même source, sans quoi la règle montrerait des taquets que le texte ignore.
 */
export function tabStopsAt(doc: { resolve: (pos: number) => { depth: number; node: (d: number) => { type: { name: string }; attrs: Record<string, unknown> } } }, pos: number): TabStop[] {
  try {
    const $pos = doc.resolve(pos);
    for (let d = $pos.depth; d >= 0; d--) {
      const node = $pos.node(d);
      if (PARAGRAPH_TYPES.includes(node.type.name)) return parseStopsAttr(node.attrs.tabStops);
    }
  } catch {
    /* position hors document : aucun taquet */
  }
  return [];
}

export const TabStops = Extension.create({
  name: "eliumTabStops",

  addGlobalAttributes() {
    return [
      {
        types: PARAGRAPH_TYPES,
        attributes: {
          tabStops: {
            default: null,
            // Sérialisé en JSON dans un attribut de données : le HTML n'a aucune
            // façon standard de porter des taquets, et l'aller-retour
            // copier-coller doit les conserver.
            parseHTML: (el: HTMLElement) => {
              const raw = el.getAttribute("data-tab-stops");
              return raw ? parseStopsAttr(raw) : null;
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              const stops = parseStopsAttr(attrs.tabStops);
              return stops.length ? { "data-tab-stops": JSON.stringify(stops) } : {};
            },
          },
        },
      },
    ];
  },

  addCommands() {
    const applyToBlocks = (stops: TabStop[] | null) => () => ({ tr, state, dispatch }: {
      tr: { setNodeMarkup: (pos: number, type: null, attrs: Record<string, unknown>) => void };
      state: { selection: { from: number; to: number }; doc: { nodesBetween: (from: number, to: number, fn: (node: { type: { name: string }; attrs: Record<string, unknown> }, pos: number) => void) => void } };
      dispatch?: unknown;
    }) => {
      const { from, to } = state.selection;
      if (!dispatch) return true;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!PARAGRAPH_TYPES.includes(node.type.name)) return;
        const next = stops && stops.length ? normalizeStops(stops) : null;
        tr.setNodeMarkup(pos, null, { ...node.attrs, tabStops: next });
      });
      return true;
    };

    return {
      setTabStops: (stops) => applyToBlocks(stops)(),
      clearTabStops: () => applyToBlocks(null)(),
      addTabStop:
        (stop) =>
        ({ editor, commands }) => {
          const current = tabStopsAt(editor.state.doc as never, editor.state.selection.from);
          return commands.setTabStops(addStop(current, stop));
        },
      removeTabStop:
        (posMm) =>
        ({ editor, commands }) => {
          const current = tabStopsAt(editor.state.doc as never, editor.state.selection.from);
          const next = removeStopNear(current, posMm);
          if (next === current) return false;
          return commands.setTabStops(next);
        },
      insertTab:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: "tab" }),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Dans une liste ou un tableau, Tab garde son rôle habituel (changer de
      // niveau, passer à la cellule suivante) : on ne l'intercepte que dans du
      // texte courant, sinon on casserait deux interactions déjà acquises.
      Tab: ({ editor }) => {
        if (editor.isActive("listItem") || editor.isActive("table") || editor.isActive("codeBlock")) return false;
        return editor.commands.insertTab();
      },
    };
  },
});

/**
 * La tabulation : un atome en ligne qui se donne la largeur menant au taquet
 * suivant.
 *
 * La mesure se fait dans la vue de nœud parce qu'elle dépend du rendu (position
 * de l'atome sur la ligne, largeur du texte qui suit pour un taquet centré ou à
 * droite). Le choix du taquet, lui, reste une fonction pure de `tabs.ts`.
 */
export const Tab = Node.create({
  name: "tab",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  parseHTML() {
    return [{ tag: "span[data-tab]" }];
  },

  renderHTML() {
    // À l'export, une vraie tabulation : c'est ce que tout autre lecteur attend.
    return ["span", { "data-tab": "true", class: "elium-tab" }, "\t"];
  },

  renderText() {
    return "\t";
  },

  addNodeView() {
    return ({ editor, getPos }) => {
      const dom = document.createElement("span");
      dom.className = "elium-tab";
      dom.setAttribute("data-tab", "true");
      dom.contentEditable = "false";

      const measure = () => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null) return;
        const stops = tabStopsAt(editor.state.doc as never, pos);
        const parent = dom.parentElement;
        const block = dom.closest<HTMLElement>("p, h1, h2, h3, h4, h5, h6");
        if (!parent || !block) return;
        const blockBox = block.getBoundingClientRect();
        const own = dom.getBoundingClientRect();
        // Position du départ de la tabulation, en mm depuis le bord du bloc.
        const fromMm = (own.left - blockBox.left) / CSS_PX_PER_MM;
        const widthMm = blockBox.width / CSS_PX_PER_MM;
        const target = nextStop(fromMm, stops, DEFAULT_TAB_MM, widthMm);
        if (!target) {
          // Plus de taquet avant la fin de la ligne : la tabulation se replie
          // sur un espace, plutôt que de pousser le texte hors de la page.
          dom.style.width = "";
          dom.style.minWidth = "0";
          dom.textContent = " ";
          return;
        }
        const px = Math.max(0, (target.pos - fromMm) * CSS_PX_PER_MM);
        dom.style.width = `${px}px`;
        dom.style.minWidth = `${px}px`;
        dom.dataset.align = target.align;
        // Le point de conduite remplit visuellement l'espace parcouru.
        const ch = LEADER_CHAR[target.leader];
        dom.textContent = "";
        dom.classList.toggle("has-leader", Boolean(ch));
        if (ch) {
          const fill = document.createElement("span");
          fill.className = "elium-tab__leader";
          fill.textContent = ch.repeat(200);
          dom.appendChild(fill);
        }
      };

      // La mesure a besoin que l'atome soit DANS le document : à la construction
      // de la vue il ne l'est pas encore, d'où une seconde passe différée.
      // Celle-ci passe par `setTimeout` autant que par `requestAnimationFrame` :
      // rAF ne se déclenche pas quand la page ne composite pas (onglet caché,
      // volet d'aperçu), et la tabulation resterait alors large de zéro.
      const schedule = () => {
        measure();
        setTimeout(measure, 0);
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(measure);
      };
      schedule();
      const onUpdate = schedule;
      editor.on("update", onUpdate);
      window.addEventListener("resize", onUpdate);

      return {
        dom,
        ignoreMutation: () => true,
        update: () => {
          onUpdate();
          return true;
        },
        destroy: () => {
          editor.off("update", onUpdate);
          window.removeEventListener("resize", onUpdate);
        },
      };
    };
  },
});

export type { TabAlign, TabLeader, TabStop };
