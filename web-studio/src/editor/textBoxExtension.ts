/**
 * La zone de texte côté TipTap.
 *
 * C'est un nœud **conteneur de blocs** (`content: "block+"`), pas un atome : elle
 * accueille des paragraphes, des listes, un tableau. Un atome à contenu plat
 * aurait interdit tout ce qui fait l'intérêt d'un encadré.
 *
 * La vue de nœud ajoute le déplacement et le redimensionnement à la souris. Elle
 * ne fait que **lire** la géométrie et écrire des attributs : tout le calcul
 * (bornes, habillage, CSS) reste dans `textBox.ts`, donc testable sans DOM.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { CSS_PX_PER_MM } from "./Pagination";
import {
  DEFAULT_GEOMETRY, DEFAULT_STYLE, MIN_HEIGHT_MM, MIN_WIDTH_MM, isFloating, normalizeGeometry,
  normalizeStyle, textBoxCss, type FloatSide, type TextBoxStyle, type WrapMode,
} from "./textBox";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textBox: {
      /** Insère une zone de texte au curseur. */
      insertTextBox: (attrs?: { wrap?: WrapMode; side?: FloatSide }) => ReturnType;
      /** Change l'habillage de la zone courante. */
      setTextBoxWrap: (wrap: WrapMode) => ReturnType;
      /** Change le style (filet, remplissage, marge) de la zone courante. */
      setTextBoxStyle: (patch: Partial<TextBoxStyle>) => ReturnType;
      /** Retire la zone en conservant son contenu dans le flux. */
      unwrapTextBox: () => ReturnType;
    };
  }
}

export const TextBox = Node.create({
  name: "textBox",
  group: "block",
  content: "block+",
  // `defining` : coller dedans ne remplace pas la zone elle-même.
  defining: true,
  isolating: true,
  draggable: false,

  addAttributes() {
    return {
      x: { default: DEFAULT_GEOMETRY.x },
      y: { default: DEFAULT_GEOMETRY.y },
      widthMm: { default: DEFAULT_GEOMETRY.widthMm },
      heightMm: { default: DEFAULT_GEOMETRY.heightMm },
      wrap: { default: DEFAULT_GEOMETRY.wrap },
      side: { default: DEFAULT_GEOMETRY.side },
      borderWidth: { default: DEFAULT_STYLE.borderWidth },
      borderColor: { default: DEFAULT_STYLE.borderColor },
      fill: { default: DEFAULT_STYLE.fill },
      padMm: { default: DEFAULT_STYLE.padMm },
      radius: { default: DEFAULT_STYLE.radius },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-text-box]",
        getAttrs: (el) => {
          const raw = (el as HTMLElement).getAttribute("data-text-box");
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            return { ...normalizeGeometry(parsed), ...normalizeStyle(parsed) };
          } catch {
            return {};
          }
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const g = normalizeGeometry(node.attrs);
    const s = normalizeStyle(node.attrs);
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        // La géométrie voyage en JSON : le HTML n'a aucune façon standard de la
        // porter, et l'aller-retour copier-coller doit la conserver.
        "data-text-box": JSON.stringify({ ...g, ...s }),
        class: `elium-textbox elium-textbox--${g.wrap}`,
        style: textBoxCss(g, s),
      }),
      0,
    ];
  },

  addCommands() {
    return {
      insertTextBox:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { ...DEFAULT_GEOMETRY, ...DEFAULT_STYLE, ...(attrs ?? {}) },
            content: [{ type: "paragraph" }],
          }),
      setTextBoxWrap:
        (wrap) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { wrap }),
      setTextBoxStyle:
        (patch) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, normalizeStyle({ ...patch })),
      unwrapTextBox:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("div");
      const content = document.createElement("div");
      content.className = "elium-textbox__content";

      /** Poignée de redimensionnement, coin bas-droit. */
      const handle = document.createElement("div");
      handle.className = "elium-textbox__resize";
      handle.contentEditable = "false";
      handle.title = "Redimensionner";

      /** Poignée de déplacement, en haut : le corps reste éditable. */
      const grip = document.createElement("div");
      grip.className = "elium-textbox__grip";
      grip.contentEditable = "false";
      grip.title = "Déplacer";

      dom.append(grip, content, handle);

      const apply = (current: typeof node) => {
        const g = normalizeGeometry(current.attrs);
        const s = normalizeStyle(current.attrs);
        dom.className = `elium-textbox elium-textbox--${g.wrap}`;
        dom.setAttribute("data-text-box", JSON.stringify({ ...g, ...s }));
        dom.setAttribute("style", textBoxCss(g, s));
        // Seule une zone hors du flux se déplace librement : en habillage carré,
        // sa position vient du flux, et proposer de la déplacer mentirait.
        grip.style.display = isFloating(g.wrap) ? "" : "none";
      };
      apply(node);
      let current = node;

      /** Écrit la géométrie sans passer par l'historique de frappe. */
      const write = (patch: Record<string, number>) => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null) return;
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, null, {
            ...editor.view.state.doc.nodeAt(pos)?.attrs,
            ...patch,
          }),
        );
      };

      /** Suivi d'un glisser, terminé même si la souris sort de la zone. */
      const drag = (
        e: MouseEvent,
        onMove: (dxMm: number, dyMm: number) => void,
      ) => {
        e.preventDefault();
        e.stopPropagation();
        const x0 = e.clientX;
        const y0 = e.clientY;
        const move = (ev: MouseEvent) => {
          onMove((ev.clientX - x0) / CSS_PX_PER_MM, (ev.clientY - y0) / CSS_PX_PER_MM);
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      };

      grip.addEventListener("mousedown", (e) => {
        const g = normalizeGeometry(current.attrs);
        drag(e, (dx, dy) => write({ x: Math.max(0, g.x + dx), y: Math.max(0, g.y + dy) }));
      });

      handle.addEventListener("mousedown", (e) => {
        const g = normalizeGeometry(current.attrs);
        // La hauteur automatique (0) devient explicite dès qu'on la tire, sinon
        // le redimensionnement vertical n'aurait aucun effet visible.
        const h0 = g.heightMm > 0 ? g.heightMm : dom.getBoundingClientRect().height / CSS_PX_PER_MM;
        drag(e, (dx, dy) =>
          write({
            widthMm: Math.max(MIN_WIDTH_MM, g.widthMm + dx),
            heightMm: Math.max(MIN_HEIGHT_MM, h0 + dy),
          }),
        );
      });

      return {
        dom,
        contentDOM: content,
        update: (updated) => {
          if (updated.type.name !== "textBox") return false;
          current = updated;
          apply(updated);
          return true;
        },
        // Les poignées sont à nous : leurs mutations ne doivent pas remonter à
        // ProseMirror, qui les prendrait pour du contenu édité.
        ignoreMutation: (mutation) => {
          if (mutation.type === "selection") return false;
          return mutation.target !== content && !content.contains(mutation.target);
        },
      };
    };
  },
});
