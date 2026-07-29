/**
 * La forme côté TipTap.
 *
 * Une forme est un **conteneur de blocs** comme la zone de texte (`content:
 * "block*"`), à ceci près que son contenu est optionnel : une droite ou une flèche
 * n'accueille pas de texte, alors qu'un rectangle, un losange ou une bulle en
 * accueillent — et du vrai contenu de document, pas une chaîne plate.
 *
 * La vue de nœud ajoute le déplacement, le redimensionnement et la **rotation** à
 * la souris, ainsi que l'alignement sur le quadrillage (Alt enfoncé pour poser
 * librement, comme dans Word). Tout le calcul — bornes, tracé, habillage, CSS —
 * reste dans `shapes.ts`, `textBox.ts` et `grid.ts`, donc testable sans DOM.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { CSS_PX_PER_MM } from "./Pagination";
import { activeGrid, snapDrag, snapMm } from "./grid";
import {
  DEFAULT_GEOMETRY, MIN_HEIGHT_MM, MIN_WIDTH_MM, isFloating, normalizeGeometry,
  type FloatSide, type WrapMode,
} from "./textBox";
import {
  DEFAULT_KIND, DEFAULT_SHAPE_HEIGHT_MM, DEFAULT_SHAPE_STYLE, DEFAULT_SHAPE_WIDTH_MM, clampAdj,
  defaultAdj, normalizeShapeStyle, shapeContainerCss, shapeDef, shapeSvg, vAlignCss,
  type ShapeKind, type ShapeStyle,
} from "./shapes";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    shape: {
      /** Insère une forme au curseur. */
      insertShape: (attrs?: {
        kind?: ShapeKind;
        wrap?: WrapMode;
        side?: FloatSide;
        widthMm?: number;
        heightMm?: number;
      }) => ReturnType;
      /** Remplace la forme courante par une autre (le contenu et la taille restent). */
      setShapeKind: (kind: ShapeKind) => ReturnType;
      /** Change le remplissage, le contour ou le texte de la forme courante. */
      setShapeStyle: (patch: Partial<ShapeStyle>) => ReturnType;
      /** Change la géométrie (taille, position, rotation) de la forme courante. */
      setShapeGeometry: (patch: {
        x?: number; y?: number; widthMm?: number; heightMm?: number; rotation?: number;
      }) => ReturnType;
      /** Change l'habillage de la forme courante. */
      setShapeWrap: (wrap: WrapMode) => ReturnType;
      /** Change la poignée d'ajustement (rayon, épaisseur, pointe…). */
      setShapeAdj: (adj: number) => ReturnType;
      /** Supprime la forme et son contenu. */
      removeShape: () => ReturnType;
    };
  }
}

/** Les attributs de style, déclarés une fois et réutilisés partout. */
const STYLE_KEYS = Object.keys(DEFAULT_SHAPE_STYLE) as (keyof ShapeStyle)[];

export const Shape = Node.create({
  name: "shape",
  group: "block",
  // `block*` et non `block+` : une ligne n'a pas de contenu, et exiger un
  // paragraphe vide dans une flèche ferait apparaître un curseur invisible.
  content: "block*",
  defining: true,
  isolating: true,
  draggable: false,

  addAttributes() {
    const attrs: Record<string, { default: unknown }> = {
      kind: { default: DEFAULT_KIND },
      adj: { default: defaultAdj(DEFAULT_KIND) },
      x: { default: DEFAULT_GEOMETRY.x },
      y: { default: DEFAULT_GEOMETRY.y },
      widthMm: { default: DEFAULT_SHAPE_WIDTH_MM },
      heightMm: { default: DEFAULT_SHAPE_HEIGHT_MM },
      wrap: { default: DEFAULT_GEOMETRY.wrap },
      side: { default: DEFAULT_GEOMETRY.side },
      rotation: { default: 0 },
    };
    for (const key of STYLE_KEYS) attrs[key] = { default: DEFAULT_SHAPE_STYLE[key] };
    return attrs as never;
  },

  parseHTML() {
    return [
      {
        tag: "div[data-shape]",
        getAttrs: (el) => {
          const raw = (el as HTMLElement).getAttribute("data-shape");
          try {
            const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
            const def = shapeDef(parsed.kind);
            return {
              kind: def.kind,
              adj: clampAdj(def.kind, parsed.adj),
              ...normalizeGeometry(parsed),
              ...normalizeShapeStyle(parsed),
            };
          } catch {
            return {};
          }
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const def = shapeDef(node.attrs.kind);
    const g = normalizeGeometry(node.attrs);
    const s = normalizeShapeStyle(node.attrs);
    const adj = clampAdj(def.kind, node.attrs.adj);
    const h = g.heightMm > 0 ? g.heightMm : DEFAULT_SHAPE_HEIGHT_MM;
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        // La forme voyage en JSON : le HTML n'a aucune façon standard de porter
        // une géométrie, et l'aller-retour copier-coller doit la conserver.
        "data-shape": JSON.stringify({ kind: def.kind, adj, ...g, ...s }),
        class: `elium-shape elium-shape--${g.wrap}`,
        style: shapeContainerCss(g, s, h),
      }),
      // Le SVG est écrit tel quel par l'export HTML (voir exporters.ts) ; ici le
      // premier enfant est le contenu éditable, ProseMirror l'exige.
      0,
    ];
  },

  addCommands() {
    return {
      insertShape:
        (attrs) =>
        ({ commands }) => {
          const def = shapeDef(attrs?.kind);
          const content = def.line ? [] : [{ type: "paragraph" }];
          return commands.insertContent({
            type: this.name,
            attrs: {
              ...DEFAULT_GEOMETRY,
              ...DEFAULT_SHAPE_STYLE,
              kind: def.kind,
              adj: defaultAdj(def.kind),
              widthMm: attrs?.widthMm ?? DEFAULT_SHAPE_WIDTH_MM,
              heightMm: attrs?.heightMm ?? (def.line ? 12 : DEFAULT_SHAPE_HEIGHT_MM),
              // Une ligne n'a pas de remplissage : en donner un dessinerait un
              // triangle plein entre ses extrémités.
              ...(def.line ? { fill: "", strokeWidth: Math.max(1, DEFAULT_SHAPE_STYLE.strokeWidth) } : {}),
              ...(attrs?.wrap ? { wrap: attrs.wrap } : {}),
              ...(attrs?.side ? { side: attrs.side } : {}),
            },
            content,
          });
        },
      setShapeKind:
        (kind) =>
        ({ commands }) => {
          const def = shapeDef(kind);
          // L'ajustement d'une forme n'a aucun sens pour une autre : il repart de
          // la valeur par défaut de la nouvelle forme.
          return commands.updateAttributes(this.name, { kind: def.kind, adj: defaultAdj(def.kind) });
        },
      setShapeStyle:
        (patch) =>
        ({ commands, editor }) => {
          const current = editor.getAttributes(this.name);
          return commands.updateAttributes(this.name, normalizeShapeStyle({ ...current, ...patch }));
        },
      setShapeGeometry:
        (patch) =>
        ({ commands, editor }) => {
          const current = editor.getAttributes(this.name);
          const g = normalizeGeometry({ ...current, ...patch });
          return commands.updateAttributes(this.name, {
            x: g.x, y: g.y, widthMm: g.widthMm, heightMm: g.heightMm, rotation: g.rotation,
          });
        },
      setShapeWrap:
        (wrap) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { wrap }),
      setShapeAdj:
        (adj) =>
        ({ commands, editor }) =>
          commands.updateAttributes(this.name, {
            adj: clampAdj(editor.getAttributes(this.name).kind, adj),
          }),
      removeShape:
        () =>
        ({ commands }) =>
          commands.deleteNode(this.name),
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("div");
      const art = document.createElement("div");
      art.className = "elium-shape__art";
      art.contentEditable = "false";
      const content = document.createElement("div");
      content.className = "elium-shape__content";

      /** Poignée de déplacement (en haut) : le corps reste éditable. */
      const grip = document.createElement("div");
      grip.className = "elium-shape__grip";
      grip.contentEditable = "false";
      grip.title = "Déplacer (Alt pour ignorer le quadrillage)";

      /** Poignée de redimensionnement, coin bas-droit. */
      const size = document.createElement("div");
      size.className = "elium-shape__resize";
      size.contentEditable = "false";
      size.title = "Redimensionner";

      /** Poignée de rotation, au-dessus du centre. */
      const spin = document.createElement("div");
      spin.className = "elium-shape__rotate";
      spin.contentEditable = "false";
      spin.title = "Faire pivoter (Maj pour des paliers de 15°)";

      dom.append(art, content, grip, size, spin);

      let current = node;

      const apply = (n: typeof node) => {
        const def = shapeDef(n.attrs.kind);
        const g = normalizeGeometry(n.attrs);
        const s = normalizeShapeStyle(n.attrs);
        const h = g.heightMm > 0 ? g.heightMm : DEFAULT_SHAPE_HEIGHT_MM;
        const adj = clampAdj(def.kind, n.attrs.adj);
        dom.className = `elium-shape elium-shape--${g.wrap}${def.line ? " elium-shape--line" : ""}`;
        dom.setAttribute("data-shape", JSON.stringify({ kind: def.kind, adj, ...g, ...s }));
        dom.setAttribute("style", shapeContainerCss(g, s, h));
        dom.setAttribute("data-shape-kind", def.kind);
        // Le SVG est régénéré à chaque changement : c'est une chaîne pure issue de
        // `shapes.ts`, donc rien à synchroniser à la main.
        art.innerHTML = shapeSvg(def.kind, g.widthMm, h, s, adj, shapeSvgId(getPos));
        content.setAttribute("style", `padding:${s.padMm}mm;justify-content:${vAlignCss(s.vAlign)}`);
        // Une ligne n'accueille pas de texte : afficher une zone de saisie
        // invisible au milieu ferait cliquer dans le vide.
        content.style.display = def.line ? "none" : "";
        grip.style.display = isFloating(g.wrap) ? "" : "none";
      };
      apply(node);

      /** Écrit la géométrie sans passer par l'historique de frappe. */
      const write = (patch: Record<string, number>) => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null) return;
        const at = editor.view.state.doc.nodeAt(pos);
        if (!at) return;
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, null, { ...at.attrs, ...patch }),
        );
      };

      /** Suivi d'un glisser, terminé même si la souris sort de la forme. */
      const drag = (
        e: MouseEvent,
        onMove: (dxMm: number, dyMm: number, ev: MouseEvent) => void,
      ) => {
        e.preventDefault();
        e.stopPropagation();
        const x0 = e.clientX;
        const y0 = e.clientY;
        const move = (ev: MouseEvent) =>
          onMove((ev.clientX - x0) / CSS_PX_PER_MM, (ev.clientY - y0) / CSS_PX_PER_MM, ev);
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      };

      grip.addEventListener("mousedown", (e) => {
        const g = normalizeGeometry(current.attrs);
        drag(e, (dx, dy, ev) => {
          // Alt pose la forme librement : c'est le geste de Word, et il évite
          // d'aller décocher l'alignement pour un seul objet.
          const p = snapDrag(Math.max(0, g.x + dx), Math.max(0, g.y + dy), ev.altKey);
          write({ x: p.x, y: p.y });
        });
      });

      size.addEventListener("mousedown", (e) => {
        const g = normalizeGeometry(current.attrs);
        const h0 = g.heightMm > 0 ? g.heightMm : DEFAULT_SHAPE_HEIGHT_MM;
        drag(e, (dx, dy, ev) => {
          const grid = activeGrid();
          const snap = grid?.snap && !ev.altKey;
          const w = Math.max(MIN_WIDTH_MM, g.widthMm + dx);
          const h = Math.max(MIN_HEIGHT_MM, h0 + dy);
          write({
            widthMm: snap ? Math.max(MIN_WIDTH_MM, snapMm(w, grid!.spacingXMm)) : w,
            heightMm: snap ? Math.max(MIN_HEIGHT_MM, snapMm(h, grid!.spacingYMm)) : h,
          });
        });
      });

      spin.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const box = dom.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const move = (ev: MouseEvent) => {
          // L'angle est mesuré depuis le centre de la forme ; +90° parce que la
          // poignée part du HAUT, qui est l'angle -90° du repère mathématique.
          const raw = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
          const deg = ev.shiftKey ? Math.round(raw / 15) * 15 : Math.round(raw);
          write({ rotation: ((deg % 360) + 360) % 360 });
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });

      return {
        dom,
        contentDOM: content,
        update: (updated) => {
          if (updated.type.name !== "shape") return false;
          current = updated;
          apply(updated);
          return true;
        },
        // Le dessin et les poignées sont à nous : leurs mutations ne doivent pas
        // remonter à ProseMirror, qui les prendrait pour du contenu édité.
        ignoreMutation: (mutation) => {
          if (mutation.type === "selection") return false;
          return mutation.target !== content && !content.contains(mutation.target);
        },
      };
    };
  },
});

/** Un identifiant stable pour les dégradés d'une forme (position dans le document). */
function shapeSvgId(getPos: unknown): string {
  const pos = typeof getPos === "function" ? (getPos as () => number | undefined)() : undefined;
  return `n${pos ?? 0}`;
}
