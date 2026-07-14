/**
 * Slide templates + background presets for the "Design & contenu" toolset.
 * Templates seed a new slide's free-canvas elements (and optional background);
 * used by both editors via DeckStore.insertSlide. Pure module.
 */
import { newElementId, type SlideElement } from "./model";

const t = (e: Partial<SlideElement> & Pick<SlideElement, "type" | "x" | "y" | "w" | "h">): SlideElement =>
  ({ id: newElementId(), rotation: 0, opacity: 1, ...e });

export interface SlideTemplate {
  id: string;
  label: string;
  background?: string;
  build: () => SlideElement[];
}

export const SLIDE_TEMPLATES: SlideTemplate[] = [
  {
    id: "title", label: "Titre",
    build: () => [
      t({ type: "text", x: 8, y: 34, w: 84, h: 18, html: "<p>Titre de la présentation</p>", fontSize: 54, align: "center", valign: "middle" }),
      t({ type: "text", x: 12, y: 56, w: 76, h: 12, html: "<p>Sous-titre</p>", fontSize: 26, align: "center", valign: "top", color: "#64748b" }),
    ],
  },
  {
    id: "title-content", label: "Titre + contenu",
    build: () => [
      t({ type: "text", x: 7, y: 7, w: 86, h: 14, html: "<p>Titre</p>", fontSize: 40, valign: "top" }),
      t({ type: "text", x: 7, y: 24, w: 86, h: 66, html: "<ul><li>Premier point</li><li>Deuxième point</li></ul>", fontSize: 24, valign: "top" }),
    ],
  },
  {
    id: "section", label: "Section", background: "linear-gradient(160deg, #1d4ed8, #1e3a8a)",
    build: () => [
      t({ type: "text", x: 8, y: 40, w: 84, h: 20, html: "<p>Titre de section</p>", fontSize: 48, color: "#ffffff", valign: "middle" }),
    ],
  },
  {
    id: "two-col", label: "Deux colonnes",
    build: () => [
      t({ type: "text", x: 6, y: 8, w: 88, h: 12, html: "<p>Titre</p>", fontSize: 36, valign: "top" }),
      t({ type: "text", x: 6, y: 24, w: 42, h: 66, html: "<ul><li>Colonne A</li></ul>", fontSize: 22, valign: "top" }),
      t({ type: "text", x: 52, y: 24, w: 42, h: 66, html: "<ul><li>Colonne B</li></ul>", fontSize: 22, valign: "top" }),
    ],
  },
  {
    id: "quote", label: "Citation", background: "#0f172a",
    build: () => [
      t({ type: "text", x: 12, y: 32, w: 76, h: 28, html: "<p>« Une citation inspirante. »</p>", fontSize: 40, color: "#f8fafc", align: "center", valign: "middle" }),
      t({ type: "text", x: 12, y: 64, w: 76, h: 10, html: "<p>— Auteur</p>", fontSize: 22, color: "#94a3b8", align: "center", valign: "top" }),
    ],
  },
  {
    id: "blank", label: "Vierge", build: () => [],
  },
];

/** Ready-made gradient backgrounds for the background picker. */
export const GRADIENT_PRESETS: string[] = [
  "linear-gradient(160deg, #1d4ed8, #1e3a8a)",
  "linear-gradient(160deg, #0ea5e9, #2563eb)",
  "linear-gradient(160deg, #f472b6, #7c3aed)",
  "linear-gradient(160deg, #f59e0b, #ea580c)",
  "linear-gradient(160deg, #34d399, #059669)",
  "linear-gradient(160deg, #334155, #0f172a)",
];

/** Solid background swatches. */
export const SOLID_PRESETS: string[] = [
  "#ffffff", "#f8fafc", "#0f172a", "#1e293b", "#eff6ff", "#fef2f2", "#f0fdf4", "#fffbeb",
];

/** Build a linear-gradient CSS string from two colours + angle. */
export const gradientCss = (c1: string, c2: string, angle: number): string =>
  `linear-gradient(${angle}deg, ${c1}, ${c2})`;
