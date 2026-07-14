/** Presentation (deck) model — in-memory; persisted locally via deck-store. */
export type SlideLayout = "title" | "title-content" | "section" | "image-full" | "image-right" | "blank";
export type SlideTheme = "light" | "dark" | "brand";
export type SlideTransition = "none" | "fade" | "slide" | "zoom" | "morph";
/** Shape geometries — the free-canvas editor adds rounded rects, stars, etc. */
export type ShapeKind =
  | "rect" | "ellipse" | "triangle" | "line" | "arrow"
  | "roundRect" | "diamond" | "star" | "pentagon" | "hexagon" | "chevron" | "cloud" | "heart";

/** A free-floating shape on a slide; geometry is in % of the canvas (0–100). */
export interface Shape {
  id: string;
  kind: ShapeKind;
  x: number; y: number; w: number; h: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  text?: string; // optional centred label (rect/ellipse/triangle)
}

/** Reference canvas the free-canvas model is authored against (16:9). Font sizes
 *  are stored in px at this height and scaled to the rendered canvas size. */
export const REF_W = 1280;
export const REF_H = 720;

export type ElementType = "text" | "shape" | "image" | "table" | "chart";
/** Chart kinds — mirrors the Tableur `ChartType` so a slide chart reuses SheetChart. */
export type ChartKind = "bar" | "line" | "pie";
export interface TableData { rows: number; cols: number; cells: string[][] }
export interface ChartData { kind: ChartKind; labels: string[]; values: number[]; title?: string }

/**
 * A free-canvas object (the PowerPoint-style model). Everything on a slide is an
 * element with position/size in % of the canvas (0–100), free rotation and
 * z-order. `elements` supersedes the legacy fixed layout; old slides migrate via
 * `elementsOf()`.
 */
export interface SlideElement {
  id: string;
  type: ElementType;
  x: number; y: number; w: number; h: number; // % of canvas
  rotation?: number; // degrees, clockwise
  opacity?: number; // 0..1 (default 1)
  locked?: boolean;
  /** Stable pairing tag for the Morph transition across consecutive slides.
   *  Duplicating a slide preserves it (while minting a fresh `id`), so a
   *  duplicate-then-nudge morph pairs elements even though ids differ. */
  morphKey?: string;
  // text
  html?: string; // rich text (sanitised HTML)
  fontSize?: number; // px at REF_H reference height
  fontFamily?: string;
  color?: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  // shape
  shape?: ShapeKind;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number; // corner radius % for roundRect
  text?: string; // shape label
  // image
  src?: string; // data URL
  // table / chart (reuse the Tableur engine)
  table?: TableData;
  chart?: ChartData;
}

/** Entrance-animation effects available per element. */
export type AnimEffect =
  | "fade" | "slide-up" | "slide-down" | "slide-left" | "slide-right"
  | "zoom" | "flyin" | "spin";
/** How an element's animation is triggered relative to the play sequence. */
export type AnimTrigger = "onClick" | "withPrevious" | "afterPrevious";

/** Per-element entrance animation (played in the presenter, step by step). */
export interface SlideAnim {
  elementId: string;
  effect: AnimEffect;
  /** Play step: 0 = with the slide's entrance, 1+ = revealed on the Nth click. */
  order: number;
  /** onClick (default) advances on click; withPrevious shares the previous step;
   *  afterPrevious auto-plays right after the previous step. */
  trigger?: AnimTrigger;
  delayMs?: number;
  durationMs?: number;
}

export interface Slide {
  id: string;
  title: string;
  body: string; // legacy plain text; lines become bullets (fallback when bodyHtml is absent)
  bodyHtml?: string; // rich text (sanitised HTML); preferred when present
  layout: SlideLayout;
  notes?: string; // private speaker notes (not shown to the audience)
  image?: string; // data URL, used by the image-* layouts
  imageWidth?: number; // image width in %, default 100
  shapes?: Shape[]; // legacy free-floating shapes
  transition?: SlideTransition; // overrides the deck default when set
  /** Free-canvas objects. When present, they are the authoritative content. */
  elements?: SlideElement[];
  background?: string; // slide background (hex/gradient css), overrides theme
  anims?: SlideAnim[]; // element animations
}

export interface Deck {
  slides: Slide[];
  active: number;
  theme?: SlideTheme;
  transition?: SlideTransition; // default entrance transition for the deck
}

export function newSlideId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `sl-${c.randomUUID()}`;
  return `sl-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

export function newShapeId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `sh-${c.randomUUID()}`;
  return `sh-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

export function newElementId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `el-${c.randomUUID()}`;
  return `el-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

export function emptySlide(layout: SlideLayout = "title-content"): Slide {
  return { id: newSlideId(), title: "Nouvelle diapositive", body: "", bodyHtml: "", layout };
}

export function emptyDeck(): Deck {
  return {
    slides: [{ id: newSlideId(), title: "Titre de la présentation", body: "", bodyHtml: "<p>Sous-titre</p>", layout: "title" }],
    active: 0,
    theme: "light",
    transition: "fade",
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

/**
 * The slide body as HTML. Prefers the rich `bodyHtml`; otherwise migrates the
 * legacy plain-text `body` (one line = one bullet) on the fly.
 */
export function bodyHtmlOf(slide: Slide): string {
  if (slide.bodyHtml != null && slide.bodyHtml !== "") return slide.bodyHtml;
  if (slide.bodyHtml === "") return "";
  const lines = slide.body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  // Migrate as paragraphs (not a bullet list): a subtitle on a title/section
  // slide should not become a bullet. Users add lists via the toolbar.
  return lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
}

// --- Free-canvas element model --------------------------------------------

const el = (e: Partial<SlideElement> & Pick<SlideElement, "type" | "x" | "y" | "w" | "h">): SlideElement => ({
  id: newElementId(),
  rotation: 0,
  opacity: 1,
  ...e,
});

/**
 * The authoritative element list for a slide. If the slide was authored in the
 * free-canvas editor, returns `elements`. Otherwise it migrates the legacy
 * fixed-layout content (title/body/image/shapes) into positioned elements so old
 * decks open seamlessly in the new editor.
 */
export function elementsOf(slide: Slide): SlideElement[] {
  if (slide.elements) return slide.elements;
  const out: SlideElement[] = [];
  const title = slide.title?.trim();
  const body = bodyHtmlOf(slide);
  const titleHtml = title ? `<p>${escapeHtml(title)}</p>` : "";

  switch (slide.layout) {
    case "title":
      if (titleHtml) out.push(el({ type: "text", x: 8, y: 34, w: 84, h: 22, html: titleHtml, fontSize: 54, align: "center", valign: "middle" }));
      if (body) out.push(el({ type: "text", x: 12, y: 58, w: 76, h: 16, html: body, fontSize: 26, align: "center", valign: "top", color: "#64748b" }));
      break;
    case "section":
      if (titleHtml) out.push(el({ type: "text", x: 8, y: 38, w: 84, h: 24, html: titleHtml, fontSize: 46, align: "left", valign: "middle" }));
      if (body) out.push(el({ type: "text", x: 8, y: 64, w: 84, h: 14, html: body, fontSize: 24, align: "left", valign: "top", color: "#64748b" }));
      break;
    case "image-full":
      if (slide.image) out.push(el({ type: "image", x: 4, y: 6, w: 92, h: 76, src: slide.image }));
      if (titleHtml) out.push(el({ type: "text", x: 4, y: 85, w: 92, h: 11, html: titleHtml, fontSize: 22, align: "center", valign: "middle" }));
      break;
    case "image-right":
      if (titleHtml) out.push(el({ type: "text", x: 6, y: 10, w: 44, h: 16, html: titleHtml, fontSize: 40, align: "left", valign: "top" }));
      if (body) out.push(el({ type: "text", x: 6, y: 28, w: 44, h: 62, html: body, fontSize: 22, align: "left", valign: "top" }));
      if (slide.image) out.push(el({ type: "image", x: 54, y: 16, w: 40, h: 62, src: slide.image }));
      break;
    case "blank":
      break;
    default: // title-content
      if (titleHtml) out.push(el({ type: "text", x: 7, y: 7, w: 86, h: 15, html: titleHtml, fontSize: 40, align: "left", valign: "top" }));
      if (body) out.push(el({ type: "text", x: 7, y: 26, w: 86, h: 66, html: body, fontSize: 24, align: "left", valign: "top" }));
      if (slide.image) out.push(el({ type: "image", x: 60, y: 26, w: 33, h: 40, src: slide.image }));
  }
  for (const s of slide.shapes ?? []) {
    out.push(el({ type: "shape", x: s.x, y: s.y, w: s.w, h: s.h, shape: s.kind, fill: s.fill, stroke: s.stroke, strokeWidth: s.strokeWidth, text: s.text }));
  }
  return out;
}

/** A slide backed by the free-canvas model (empty or migrated). */
export function withElements(slide: Slide): Slide {
  return slide.elements ? slide : { ...slide, elements: elementsOf(slide) };
}

export function blankSlide(): Slide {
  return { id: newSlideId(), title: "", body: "", bodyHtml: "", layout: "blank", elements: [] };
}

export function newTextElement(): SlideElement {
  return el({ type: "text", x: 30, y: 40, w: 40, h: 14, html: "<p>Texte</p>", fontSize: 28, align: "left", valign: "top", color: "#0f172a" });
}

export function newShapeElement(shape: ShapeKind): SlideElement {
  if (shape === "line" || shape === "arrow") {
    return el({ type: "shape", shape, x: 25, y: 48, w: 50, h: 6, fill: "transparent", stroke: "#0f172a", strokeWidth: 3 });
  }
  return el({ type: "shape", shape, x: 34, y: 33, w: 32, h: 30, fill: "#bfdbfe", stroke: "#2563eb", strokeWidth: 2, radius: 12 });
}

export function newImageElement(src: string): SlideElement {
  return el({ type: "image", x: 25, y: 20, w: 50, h: 55, src });
}

export function newTableElement(): SlideElement {
  const cells = [
    ["Colonne A", "Colonne B", "Colonne C"],
    ["", "", ""],
    ["", "", ""],
  ];
  return el({ type: "table", x: 15, y: 30, w: 70, h: 32, table: { rows: 3, cols: 3, cells }, fontSize: 20, color: "#0f172a" });
}

export function newChartElement(kind: ChartKind = "bar"): SlideElement {
  return el({ type: "chart", x: 22, y: 24, w: 56, h: 52, chart: { kind, labels: ["Jan", "Fév", "Mar", "Avr"], values: [12, 19, 9, 22] } });
}
