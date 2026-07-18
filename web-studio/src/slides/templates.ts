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
    id: "agenda", label: "Sommaire",
    build: () => [
      t({ type: "text", x: 7, y: 8, w: 86, h: 14, html: "<p>Sommaire</p>", fontSize: 40, valign: "top" }),
      t({ type: "text", x: 7, y: 24, w: 86, h: 66, html: "<ol><li>Introduction</li><li>Contexte</li><li>Proposition</li><li>Prochaines étapes</li></ol>", fontSize: 26, valign: "top" }),
    ],
  },
  {
    id: "compare", label: "Comparaison",
    build: () => [
      t({ type: "text", x: 6, y: 7, w: 88, h: 12, html: "<p>Comparaison</p>", fontSize: 36, valign: "top" }),
      t({ type: "shape", shape: "roundRect", x: 6, y: 24, w: 42, h: 62, fill: "#eff6ff", stroke: "#3b82f6", strokeWidth: 2, radius: 14 }),
      t({ type: "shape", shape: "roundRect", x: 52, y: 24, w: 42, h: 62, fill: "#fef2f2", stroke: "#ef4444", strokeWidth: 2, radius: 14 }),
      t({ type: "text", x: 8, y: 27, w: 38, h: 10, html: "<p>Option A</p>", fontSize: 24, align: "center", valign: "middle" }),
      t({ type: "text", x: 54, y: 27, w: 38, h: 10, html: "<p>Option B</p>", fontSize: 24, align: "center", valign: "middle" }),
      t({ type: "text", x: 9, y: 39, w: 36, h: 44, html: "<ul><li>Avantage</li><li>Avantage</li></ul>", fontSize: 20, valign: "top" }),
      t({ type: "text", x: 55, y: 39, w: 36, h: 44, html: "<ul><li>Avantage</li><li>Avantage</li></ul>", fontSize: 20, valign: "top" }),
    ],
  },
  {
    id: "stat", label: "Chiffre clé", background: "linear-gradient(160deg, #0f766e, #134e4a)",
    build: () => [
      t({ type: "text", x: 10, y: 30, w: 80, h: 26, html: "<p>87 %</p>", fontSize: 96, color: "#ffffff", align: "center", valign: "middle" }),
      t({ type: "text", x: 12, y: 60, w: 76, h: 12, html: "<p>de satisfaction client</p>", fontSize: 26, color: "#99f6e4", align: "center", valign: "top" }),
    ],
  },
  {
    id: "image-caption", label: "Image + légende",
    build: () => [
      t({ type: "text", x: 6, y: 7, w: 88, h: 12, html: "<p>Titre</p>", fontSize: 36, valign: "top" }),
      t({ type: "shape", shape: "roundRect", x: 6, y: 22, w: 55, h: 64, fill: "#f1f5f9", stroke: "#cbd5e1", strokeWidth: 2, radius: 12, text: "Image" }),
      t({ type: "text", x: 64, y: 26, w: 30, h: 56, html: "<ul><li>Point clé</li><li>Point clé</li><li>Point clé</li></ul>", fontSize: 22, valign: "top" }),
    ],
  },
  {
    id: "timeline", label: "Étapes",
    build: () => [
      t({ type: "text", x: 6, y: 8, w: 88, h: 12, html: "<p>Étapes</p>", fontSize: 36, valign: "top" }),
      t({ type: "shape", shape: "roundRect", x: 5, y: 34, w: 20, h: 32, fill: "#eef2ff", stroke: "#6366f1", strokeWidth: 2, radius: 12, text: "1" }),
      t({ type: "shape", shape: "roundRect", x: 29, y: 34, w: 20, h: 32, fill: "#eef2ff", stroke: "#6366f1", strokeWidth: 2, radius: 12, text: "2" }),
      t({ type: "shape", shape: "roundRect", x: 53, y: 34, w: 20, h: 32, fill: "#eef2ff", stroke: "#6366f1", strokeWidth: 2, radius: 12, text: "3" }),
      t({ type: "shape", shape: "roundRect", x: 77, y: 34, w: 18, h: 32, fill: "#eef2ff", stroke: "#6366f1", strokeWidth: 2, radius: 12, text: "4" }),
      t({ type: "text", x: 5, y: 68, w: 20, h: 10, html: "<p>Étape</p>", fontSize: 16, align: "center", valign: "top" }),
      t({ type: "text", x: 29, y: 68, w: 20, h: 10, html: "<p>Étape</p>", fontSize: 16, align: "center", valign: "top" }),
      t({ type: "text", x: 53, y: 68, w: 20, h: 10, html: "<p>Étape</p>", fontSize: 16, align: "center", valign: "top" }),
      t({ type: "text", x: 77, y: 68, w: 18, h: 10, html: "<p>Étape</p>", fontSize: 16, align: "center", valign: "top" }),
    ],
  },
  {
    id: "closing", label: "Remerciements", background: "linear-gradient(160deg, #1e293b, #0f172a)",
    build: () => [
      t({ type: "text", x: 10, y: 38, w: 80, h: 18, html: "<p>Merci</p>", fontSize: 64, color: "#f8fafc", align: "center", valign: "middle" }),
      t({ type: "text", x: 12, y: 60, w: 76, h: 10, html: "<p>Des questions ?</p>", fontSize: 24, color: "#94a3b8", align: "center", valign: "top" }),
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
