/**
 * PPTX (Office Open XML / PresentationML) IMPORT — dependency-free, the inverse
 * of pptx.ts. Reads a .pptx ZIP with fflate, walks the OPC relationships to the
 * slides in order, and turns each spTree child (<p:sp>/<p:pic>/<p:cxnSp>, and
 * <p:grpSp> recursively) into a free-canvas SlideElement. Geometry is EMU→% on
 * the file's own slide size. Uses regex/string scanning (no DOMParser) so it runs
 * identically in the browser and in Node tests, matching the exporter's coverage.
 *
 * Real PowerPoint files rely heavily on INHERITANCE, which is resolved here:
 * a placeholder (<p:ph>) on a slide usually has NO geometry, font size, colour
 * or bullet of its own — they come from the slide layout's placeholder, then the
 * slide master's placeholder and its txStyles (titleStyle/bodyStyle/otherStyle).
 * Theme colours (<a:schemeClr> + lumMod/lumOff/tint/shade) are resolved through
 * the master's clrMap and the theme part; group transforms (chOff/chExt) are
 * applied to children; normAutofit fontScale is honoured; list levels become
 * nested <ul>; speaker notes and the "hidden slide" flag are imported.
 * Constructs Élium can't represent (charts of exotic types, SmartArt, media,
 * gradients) degrade gracefully (text is kept; unknown geometry falls back to a
 * rectangle).
 */
import { unzipSync, strFromU8 } from "fflate";
import {
  newSlideId,
  newElementId,
  type Deck,
  type Slide,
  type SlideElement,
  type ShapeKind,
  type ElementType,
  type ChartData,
  type ChartKind,
  type LayoutPlaceholder,
  type PlaceholderKind,
  type SlideLayoutDef,
  type SlideMaster,
} from "./model";
import { defaultMaster } from "./master";

const PRST_TO_KIND: Record<string, ShapeKind> = {
  rect: "rect",
  roundRect: "roundRect",
  ellipse: "ellipse",
  triangle: "triangle",
  diamond: "diamond",
  pentagon: "pentagon",
  hexagon: "hexagon",
  star5: "star",
  chevron: "chevron",
  cloud: "cloud",
  heart: "heart",
  line: "line",
  // Right triangle: same closed-form family as "triangle", just a different angle.
  rtTriangle: "triangle",
  // Rounded-corner variants (one/two rounded or snipped corners, plaques): the
  // roundRect render is a much closer approximation than a plain rectangle.
  round1Rect: "roundRect",
  round2SameRect: "roundRect",
  round2DiagRect: "roundRect",
  snipRoundRect: "roundRect",
  snip1Rect: "roundRect",
  snip2SameRect: "roundRect",
  snip2DiagRect: "roundRect",
  plaque: "roundRect",
  // Directional block arrows: all render as the same single arrow glyph
  // (orientation/rotation is lost, but "arrow" is still the right shape family).
  rightArrow: "arrow",
  leftArrow: "arrow",
  upArrow: "arrow",
  downArrow: "arrow",
  leftRightArrow: "arrow",
  upDownArrow: "arrow",
  bentUpArrow: "arrow",
  quadArrow: "arrow",
  // Multi-point stars and starbursts/seals: all render as the same 5-point star.
  star4: "star",
  star6: "star",
  star8: "star",
  star10: "star",
  star12: "star",
  star16: "star",
  star24: "star",
  star32: "star",
  irregularSeal1: "star",
  irregularSeal2: "star",
  sun: "star",
};



const attr = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(xml);
  return m ? m[1] : undefined;
};
const num = (v: string | undefined, dflt = 0): number => {
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
};
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Ordered top-level {p:sp, p:pic, p:cxnSp, p:grpSp} blocks inside an spTree. */
function childBlocks(xml: string): { tag: string; block: string }[] {
  const TARGETS = new Set(["p:sp", "p:pic", "p:cxnSp", "p:grpSp", "p:graphicFrame"]);
  const out: { tag: string; block: string }[] = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    if (xml[i] !== "<") {
      i++;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z:]+)/.exec(xml.slice(i, i + 48));
    if (!m) {
      i++;
      continue;
    }
    const name = m[2]!;
    if (m[1] !== "/" && TARGETS.has(name)) {
      const openEnd = xml.indexOf(">", i);
      if (openEnd < 0) break;
      if (xml[openEnd - 1] === "/") {
        out.push({ tag: name, block: xml.slice(i, openEnd + 1) });
        i = openEnd + 1;
        continue;
      }
      const closeTag = `</${name}>`;
      let depth = 1,
        j = openEnd + 1;
      while (j < n && depth > 0) {
        const no = xml.indexOf(`<${name}`, j);
        const nc = xml.indexOf(closeTag, j);
        if (nc < 0) {
          j = n;
          break;
        }
        if (no >= 0 && no < nc) {
          const c = xml[no + name.length + 1];
          if (c === " " || c === ">" || c === "/" || c === "\t" || c === "\n" || c === "\r") depth++;
          j = no + name.length + 1;
        } else {
          depth--;
          j = nc + closeTag.length;
        }
      }
      out.push({ tag: name, block: xml.slice(i, j) });
      i = j;
      continue;
    }
    const gt = xml.indexOf(">", i);
    i = gt < 0 ? n : gt + 1;
  }
  return out;
}



// ── couleurs de thème ───────────────────────────────────────────────────────

type Rgb = [number, number, number];
const hex2rgb = (h: string): Rgb => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
const rgb2hex = (c: Rgb): string => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

function rgbToHsl([r0, g0, b0]: Rgb): [number, number, number] {
  const r = r0 / 255,
    g = g0 / 255,
    b = b0 / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Applique les modificateurs DrawingML (lumMod, lumOff, tint, shade) d'une couleur. */
function applyColorMods(base: string, inner: string): string {
  let rgb = hex2rgb(base);
  const mod = (name: string): number | undefined => {
    const v = new RegExp(`<a:${name}\\b[^>]*\\bval="(-?\\d+)"`).exec(inner)?.[1];
    return v === undefined ? undefined : Number(v) / 100000;
  };
  const lumMod = mod("lumMod");
  const lumOff = mod("lumOff");
  if (lumMod !== undefined || lumOff !== undefined) {
    const [h, s, l] = rgbToHsl(rgb);
    rgb = hslToRgb([h, s, Math.max(0, Math.min(1, l * (lumMod ?? 1) + (lumOff ?? 0)))]);
  }
  const tint = mod("tint");
  if (tint !== undefined) rgb = rgb.map((c) => c * tint + 255 * (1 - tint)) as Rgb;
  const shade = mod("shade");
  if (shade !== undefined) rgb = rgb.map((c) => c * shade) as Rgb;
  return rgb2hex(rgb);
}

interface ThemeCtx {
  /** Nom de couleur de thème (tx1, bg1, accent1, dk2…) → hex sans #, après clrMap. */
  scheme: Record<string, string>;
}
const NO_THEME: ThemeCtx = { scheme: {} };

function parseTheme(themeXml: string | undefined, masterXml: string | undefined): ThemeCtx {
  const scheme: Record<string, string> = {};
  const slot: Record<string, string> = {};
  const cs = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(themeXml ?? "")?.[1] ?? "";
  for (const name of ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]) {
    const block = new RegExp(`<a:${name}\\b[^>]*>([\\s\\S]*?)</a:${name}>`).exec(cs)?.[1] ?? "";
    const srgb = /<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(block)?.[1];
    const sys = /<a:sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})"/.exec(block)?.[1];
    const v = (srgb ?? sys)?.toLowerCase();
    if (v) slot[name] = v;
  }
  const clrMap = /<p:clrMap\b([^>]*)\/?>/.exec(masterXml ?? "")?.[1] ?? "";
  const map: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
  for (const k of ["bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]) {
    const v = attr(clrMap, k);
    if (v) map[k] = v;
  }
  for (const [k, v] of Object.entries(slot)) scheme[k] = v;
  for (const [k, v] of Object.entries(map)) if (slot[v]) scheme[k] = slot[v];
  return { scheme };
}

/** Première couleur (srgbClr / schemeClr / sysClr) trouvée dans `xml`, modificateurs appliqués. */
function colorIn(xml: string, theme: ThemeCtx = NO_THEME): string | undefined {
  const m = /<a:(srgbClr|schemeClr|sysClr)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:\1>)/.exec(xml);
  if (!m) return undefined;
  const kind = m[1]!;
  const inner = m[3] ?? "";
  let base: string | undefined;
  if (kind === "srgbClr") base = attr(m[2]!, "val")?.toLowerCase();
  else if (kind === "sysClr") base = (attr(m[2]!, "lastClr") ?? (attr(m[2]!, "val") === "window" ? "ffffff" : "000000")).toLowerCase();
  else {
    const name = attr(m[2]!, "val") ?? "";
    base = theme.scheme[name];
  }
  if (!base || !/^[0-9a-f]{6}$/.test(base)) return undefined;
  return inner ? applyColorMods(base, inner) : `#${base}`;
}

// ── héritage : masque / disposition / placeholders ──────────────────────────

interface Xf {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface LevelStyle {
  sz?: number; // centièmes de point (OOXML)
  algn?: string;
  bullet?: boolean;
  color?: string;
}
interface PhShape {
  type?: string;
  idx?: string;
  xf?: Xf;
  anchor?: string;
  levels: Record<number, LevelStyle>;
}

/** Fusionne des niveaux de style (le dernier l'emporte propriété par propriété). */
function mergeLevels(...layers: Record<number, LevelStyle>[]): Record<number, LevelStyle> {
  const out: Record<number, LevelStyle> = {};
  for (const layer of layers)
    for (const [k, v] of Object.entries(layer)) {
      const lvl = Number(k);
      out[lvl] = { ...(out[lvl] ?? {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) };
    }
  return out;
}

/** <a:lvl1pPr>…<a:lvl9pPr> d'un lstStyle / titleStyle / bodyStyle. */
function parseLevels(xml: string, theme: ThemeCtx): Record<number, LevelStyle> {
  const out: Record<number, LevelStyle> = {};
  for (let n = 1; n <= 9; n++) {
    const m = new RegExp(`<a:lvl${n}pPr\\b([^>]*?)(?:/>|>([\\s\\S]*?)</a:lvl${n}pPr>)`).exec(xml);
    if (!m) continue;
    const head = m[1] ?? "";
    const body = m[2] ?? "";
    const st: LevelStyle = {};
    const algn = attr(head, "algn");
    if (algn) st.algn = algn;
    if (/<a:buNone\b/.test(body)) st.bullet = false;
    else if (/<a:bu(Char|AutoNum|Blip)\b/.test(body)) st.bullet = true;
    const def = /<a:defRPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:defRPr>)/.exec(body);
    if (def) {
      const sz = attr(def[1]!, "sz");
      if (sz) st.sz = num(sz);
      const col = colorIn(def[2] ?? "", theme);
      if (col) st.color = col;
    }
    out[n - 1] = st;
  }
  return out;
}

/** Nature d'un espace réservé PPTX dans notre modèle (null = date, image de diapo… : non reproduit). */
const phKindOf = (t: string | undefined): PlaceholderKind | null => {
  if (t === "ctrTitle" || t === "title") return "title";
  if (t === "ftr") return "footer";
  if (t === "sldNum") return "slideNumber";
  if (t === "dt" || t === "sldImg") return null;
  return "body";
};

const normPhType = (t: string | undefined): string => {
  if (t === "ctrTitle" || t === "title") return "title";
  if (t === "dt" || t === "ftr" || t === "sldNum") return t;
  return "body"; // body, subTitle, obj, tbl, chart, pic, media, clipArt… (type absent = contenu)
};

function xfOf(block: string): Xf | undefined {
  const xf = /<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/.exec(block)?.[1];
  if (!xf) return undefined;
  const off = /<a:off\b([^>]*)\/?>/.exec(xf)?.[1] ?? "";
  const ext = /<a:ext\b([^>]*)\/?>/.exec(xf)?.[1] ?? "";
  const w = num(attr(ext, "cx"));
  const h = num(attr(ext, "cy"));
  if (!w && !h) return undefined;
  return { x: num(attr(off, "x")), y: num(attr(off, "y")), w, h };
}

/** Placeholders (<p:sp> portant <p:ph>) d'un masque ou d'une disposition. */
function parsePlaceholders(partXml: string | undefined, theme: ThemeCtx): PhShape[] {
  if (!partXml) return [];
  const spTree = /<p:spTree\b[^>]*>([\s\S]*)<\/p:spTree>/.exec(partXml)?.[1] ?? "";
  const out: PhShape[] = [];
  for (const { tag, block } of childBlocks(spTree)) {
    if (tag !== "p:sp") continue;
    const ph = /<p:ph\b([^>]*?)\/?>/.exec(block);
    if (!ph) continue;
    const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(block)?.[1] ?? "";
    out.push({
      type: attr(ph[1]!, "type"),
      idx: attr(ph[1]!, "idx"),
      xf: xfOf(spPr),
      anchor: attr(/<a:bodyPr\b([^>]*)>?/.exec(block)?.[1] ?? "", "anchor"),
      levels: parseLevels(/<a:lstStyle>([\s\S]*?)<\/a:lstStyle>/.exec(block)?.[1] ?? "", theme),
    });
  }
  return out;
}

interface InheritCtx {
  theme: ThemeCtx;
  layoutPhs: PhShape[];
  masterPhs: PhShape[];
  masterStyles: { title: Record<number, LevelStyle>; body: Record<number, LevelStyle>; other: Record<number, LevelStyle> };
  bg?: string;
}

interface ResolvedPh {
  xf?: Xf;
  anchor?: string;
  levels: Record<number, LevelStyle>;
  isTitle: boolean;
}

function resolvePh(type: string | undefined, idx: string | undefined, ic: InheritCtx): ResolvedPh {
  const group = normPhType(type);
  const layoutPh =
    (idx !== undefined ? ic.layoutPhs.find((p) => p.idx === idx) : undefined) ??
    ic.layoutPhs.find((p) => normPhType(p.type) === group && (p.idx === undefined || idx === undefined));
  const masterPh = ic.masterPhs.find((p) => normPhType(p.type) === group);
  const base = group === "title" ? ic.masterStyles.title : group === "body" ? ic.masterStyles.body : ic.masterStyles.other;
  return {
    xf: layoutPh?.xf ?? masterPh?.xf,
    anchor: layoutPh?.anchor ?? masterPh?.anchor,
    levels: mergeLevels(base, masterPh?.levels ?? {}, layoutPh?.levels ?? {}),
    isTitle: group === "title",
  };
}

/** Transformation affine (x' = ax·x + bx) — composée par les groupes imbriqués. */
interface Tf {
  ax: number;
  bx: number;
  ay: number;
  by: number;
}
const IDENTITY: Tf = { ax: 1, bx: 0, ay: 1, by: 0 };

interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}
/** Géométrie en % de la diapositive ; `fallback` (EMU) sert aux placeholders sans xfrm propre. */
function geomOf(block: string, cx: number, cy: number, tf: Tf, fallback?: Xf): Geom {
  const own = xfOf(block.replace(/<p:txBody>[\s\S]*<\/p:txBody>/, ""));
  const xf = own ?? fallback ?? { x: 0, y: 0, w: 0, h: 0 };
  const rotAttr = /<a:xfrm\b([^>]*)>/.exec(block)?.[1] ?? "";
  const rot = own ? num(attr(rotAttr, "rot")) : 0;
  return {
    x: ((tf.ax * xf.x + tf.bx) / cx) * 100,
    y: ((tf.ay * xf.y + tf.by) / cy) * 100,
    w: ((tf.ax * xf.w) / cx) * 100,
    h: ((tf.ay * xf.h) / cy) * 100,
    rot: Math.round(rot / 60000),
  };
}

// ── texte ───────────────────────────────────────────────────────────────────

interface ParaItem {
  html: string;
  bullet: boolean;
  lvl: number;
}

/** Rend une suite de paragraphes (avec niveaux) en HTML : <p> et <ul>/<li> imbriqués. */
function renderParas(items: ParaItem[]): string {
  let html = "";
  let depth = 0;
  const closeAll = () => {
    while (depth > 0) {
      html += "</li></ul>";
      depth--;
    }
  };
  for (const it of items) {
    if (!it.bullet) {
      closeAll();
      html += `<p>${it.html}</p>`;
      continue;
    }
    const lvl = Math.min(it.lvl, depth);
    const need = lvl + 1;
    if (need > depth) {
      html += "<ul>";
      depth++;
    } else {
      while (depth > need) {
        html += "</li></ul>";
        depth--;
      }
      html += "</li>";
    }
    html += `<li>${it.html}`;
  }
  closeAll();
  return html;
}

interface TextCtx {
  levels: Record<number, LevelStyle>;
  /** Taille de base (centièmes de pt) de l'élément : les runs différents deviennent des <span> en em. */
  baseSz: number;
  scale: number;
  inherit: boolean; // placeholder : puces/alignement hérités du style
  theme: ThemeCtx;
  /** Couleur de l'élément : un run de la même couleur n'a pas besoin de <span>. */
  elColor?: string;
}

/** Contenu d'un <a:p> : runs, sauts de ligne et champs, dans l'ordre. */
function paragraphInner(p: string, tc: TextCtx, lvl: number): string {
  const ls = tc.levels[lvl] ?? tc.levels[0] ?? {};
  let inner = "";
  for (const m of p.matchAll(/<a:r>([\s\S]*?)<\/a:r>|<a:br\b[^>]*?(?:\/>|>[\s\S]*?<\/a:br>)|<a:fld\b[^>]*>([\s\S]*?)<\/a:fld>/g)) {
    if (m[0]!.startsWith("<a:br")) {
      inner += "<br>";
      continue;
    }
    const r = m[1] ?? m[2] ?? "";
    const rPr = /<a:rPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:rPr>)/.exec(r);
    const rAttrs = rPr?.[1] ?? "";
    const text = unescapeXml(/<a:t>([\s\S]*?)<\/a:t>/.exec(r)?.[1] ?? "");
    if (!text) continue;
    let piece = escapeText(text);
    const col = colorIn(rPr?.[2] ?? "", tc.theme) ?? ls.color;
    const sz = attr(rAttrs, "sz") !== undefined ? num(attr(rAttrs, "sz")) : ls.sz;
    const styles: string[] = [];
    if (col && col !== tc.elColor) styles.push(`color:${col}`);
    if (sz && tc.baseSz && Math.abs(sz - tc.baseSz) > 1) styles.push(`font-size:${Math.round((sz / tc.baseSz) * 1000) / 1000}em`);
    if (styles.length) piece = `<span style="${styles.join(";")}">${piece}</span>`;
    if (/\bu="sng"/.test(rAttrs)) piece = `<u>${piece}</u>`;
    if (/\bi="1"/.test(rAttrs)) piece = `<i>${piece}</i>`;
    if (/\bb="1"/.test(rAttrs)) piece = `<b>${piece}</b>`;
    inner += piece;
  }
  return inner;
}

/** Rebuild sanitized HTML from a <p:txBody>, preserving b/i/u/colour/size + bullets and levels. */
function txBodyToHtml(block: string, tc: TextCtx): string {
  const tb = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(block)?.[1] ?? "";
  const paras = [...tb.matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)].map((m) => m[1] ?? "");
  const items: ParaItem[] = [];
  for (const p of paras) {
    const pPrAll = /<a:pPr\b[\s\S]*?(?:<\/a:pPr>|\/>)/.exec(p)?.[0] ?? "";
    const lvl = Math.max(0, Math.min(8, num(attr(/<a:pPr\b[^>]*>?/.exec(pPrAll)?.[0] ?? "", "lvl"))));
    const inner = paragraphInner(p, tc, lvl);
    if (!inner && !/<a:br\b/.test(p)) {
      // paragraphe vide : on ne le garde que s'il sépare du texte (évite les <p></p> parasites en fin)
      items.push({ html: "", bullet: false, lvl });
      continue;
    }
    let bullet: boolean;
    if (/<a:buNone\b/.test(pPrAll)) bullet = false;
    else if (/<a:bu(Char|AutoNum|Blip)\b/.test(pPrAll)) bullet = true;
    else if (tc.inherit) bullet = (tc.levels[lvl] ?? tc.levels[0])?.bullet ?? false;
    else bullet = /\bmarL="/.test(pPrAll) && !/\bmarL="0"/.test(pPrAll);
    items.push({ html: inner, bullet, lvl });
  }
  while (items.length && !items[items.length - 1]!.html) items.pop();
  while (items.length && !items[0]!.html) items.shift();
  return renderParas(items.filter((i) => i.html || !i.bullet).map((i) => (i.html ? i : { ...i, html: "<br>" })));
}
const hasText = (block: string): boolean => /<a:t>[\s\S]*?\S[\s\S]*?<\/a:t>/.test(block);

function el(base: Partial<SlideElement> & Pick<SlideElement, "type">, g: Geom): SlideElement {
  return {
    id: newElementId(),
    x: round1(g.x),
    y: round1(g.y),
    w: round1(g.w),
    h: round1(g.h),
    rotation: g.rot || undefined,
    ...base,
  } as SlideElement;
}
const round1 = (v: number) => Math.round(v * 10) / 10;

interface ParseCtx {
  cx: number;
  cy: number;
  rels: Map<string, string>;
  media: Record<string, Uint8Array>;
  inherit: InheritCtx;
  onWarning?: (label: string) => void;
}

function phOf(block: string): { type?: string; idx?: string } | null {
  const ph = /<p:ph\b([^>]*?)\/?>/.exec(block);
  if (!ph) return null;
  return { type: attr(ph[1]!, "type"), idx: attr(ph[1]!, "idx") };
}

function parsePic(block: string, pc: ParseCtx, tf: Tf): SlideElement | null {
  const rId = attr(/<a:blip\b[^>]*\/?>/.exec(block)?.[0] ?? "", "r:embed") ?? attr(block, "r:embed");
  const ph = phOf(block);
  const g = geomOf(block, pc.cx, pc.cy, tf, ph ? resolvePh(ph.type, ph.idx, pc.inherit).xf : undefined);
  let src: string | undefined;
  if (rId) {
    const target = pc.rels.get(rId);
    if (target) {
      const path = resolveMedia(target);
      const bytes = pc.media[path];
      if (bytes) src = `data:${mimeOf(path)};base64,${base64(bytes)}`;
    }
  }
  if (!src) return null;
  return el({ type: "image", src }, g);
}

function parseCxn(block: string, pc: ParseCtx, tf: Tf): SlideElement {
  const g = geomOf(block, pc.cx, pc.cy, tf);
  const ln = /<a:ln\b([^>]*)>([\s\S]*?)<\/a:ln>/.exec(block);
  const strokeW = ln ? Math.round(num(attr(ln[1]!, "w")) / 12700) : 3;
  const stroke = (ln && colorIn(ln[2]!, pc.inherit.theme)) || "#0f172a";
  const kind: ShapeKind = /<a:tailEnd\b/.test(block) ? "arrow" : "line";
  return el({ type: "shape", shape: kind, stroke, strokeWidth: strokeW || 3, fill: "transparent" }, g);
}

/** px à REF_H pour une taille OOXML en centièmes de point. */
const szToPx = (sz: number, scale: number): number => Math.round((sz / 75) * scale) || 1;

function parseSp(block: string, pc: ParseCtx, tf: Tf): SlideElement | null {
  const ph = phOf(block);
  const rph = ph ? resolvePh(ph.type, ph.idx, pc.inherit) : undefined;
  const g = geomOf(block, pc.cx, pc.cy, tf, rph?.xf);
  const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(block)?.[1] ?? "";
  const theme = pc.inherit.theme;
  const prst = attr(/<a:prstGeom\b[^>]*>/.exec(spPr)?.[0] ?? "", "prst") ?? "rect";
  const hasFill =
    /<a:solidFill>/.test(spPr.replace(/<a:ln\b[\s\S]*?<\/a:ln>/, "")) ||
    /<a:noFill\/>/.test(spPr.replace(/<a:ln\b[\s\S]*?<\/a:ln>/, "")) ||
    /<a:gradFill/.test(spPr) ||
    /<a:blipFill/.test(spPr);
  const hasLine = /<a:ln\b/.test(spPr);
  const style = /<p:style>([\s\S]*?)<\/p:style>/.exec(block)?.[1] ?? "";
  const styleFill = /<a:fillRef\b[^>]*\bidx="([1-9]\d*)"[^>]*>([\s\S]*?)<\/a:fillRef>/.exec(style);
  const styleLine = /<a:lnRef\b[^>]*\bidx="([1-9]\d*)"[^>]*>([\s\S]*?)<\/a:lnRef>/.exec(style);
  const textLike = prst === "rect" && !hasFill && !hasLine && !styleFill && !styleLine && (hasText(block) || !!ph);

  const bodyPr = /<a:bodyPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:bodyPr>)/.exec(block);
  const fontScale = num(attr(/<a:normAutofit\b([^>]*)/.exec(bodyPr?.[2] ?? "")?.[1] ?? "", "fontScale"), 100000) / 100000;

  if (textLike) {
    if (!hasText(block)) return null; // placeholder vide : rien à projeter
    const ownLevels = parseLevels(/<a:lstStyle>([\s\S]*?)<\/a:lstStyle>/.exec(block)?.[1] ?? "", theme);
    const levels = mergeLevels(rph?.levels ?? {}, ownLevels);
    // taille de base : 1er run explicite, sinon style du niveau 1 hérité, sinon 18 pt
    const firstRun = /<a:rPr\b([^>]*)>/.exec(/<p:txBody>[\s\S]*<\/p:txBody>/.exec(block)?.[0] ?? "")?.[1] ?? "";
    const baseSz = attr(firstRun, "sz") !== undefined ? num(attr(firstRun, "sz")) : (levels[0]?.sz ?? 1800);
    const color = colorIn(/<a:rPr\b[^>]*>([\s\S]*?)<\/a:rPr>/.exec(block)?.[0] ?? "", theme) ?? levels[0]?.color;
    const tc: TextCtx = { levels, baseSz, scale: fontScale, inherit: !!ph, theme, elColor: color };
    const html = txBodyToHtml(block, tc);
    if (!html) return null;
    const algn = attr(/<a:pPr\b[^>]*>/.exec(block)?.[0] ?? "", "algn") ?? levels[0]?.algn;
    const anchor = attr(bodyPr?.[1] ?? "", "anchor") ?? rph?.anchor;
    const phKind = ph ? phKindOf(ph.type) : null;
    return el(
      {
        type: "text",
        html,
        ...(phKind ? { ph: phKind } : {}),
        fontSize: szToPx(baseSz, fontScale),
        ...(color ? { color } : {}),
        align: algn === "ctr" ? "center" : algn === "r" ? "right" : "left",
        valign: anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top",
      },
      g,
    );
  }

  // shape
  const kind = PRST_TO_KIND[prst] ?? "rect";
  const noLn = spPr.replace(/<a:ln\b[\s\S]*?<\/a:ln>/, "");
  const fillSolid = /<a:solidFill>([\s\S]*?)<\/a:solidFill>/.exec(noLn);
  let fill: string;
  if (/<a:noFill\/>/.test(noLn) && !fillSolid) fill = "transparent";
  else if (fillSolid) fill = colorIn(fillSolid[1]!, theme) || "#bfdbfe";
  else if (styleFill) fill = colorIn(styleFill[2]!, theme) || "#bfdbfe";
  else fill = "#bfdbfe";
  const ln = /<a:ln\b([^>]*)>([\s\S]*?)<\/a:ln>/.exec(spPr);
  const strokeW = ln ? Math.round(num(attr(ln[1]!, "w")) / 12700) : 2;
  const stroke = (ln && !/<a:noFill\/>/.test(ln[2]!) && colorIn(ln[2]!, theme)) || (styleLine && colorIn(styleLine[2]!, theme)) || "#2563eb";
  const adj = num(attr(/<a:gd\b[^>]*name="adj"[^>]*>/.exec(spPr)?.[0] ?? "", "fmla")?.replace(/^val\s+/, ""));
  const radius = kind === "roundRect" && adj ? Math.round(adj / 1000) : undefined;
  // a shape may carry a centered text label
  const label = [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
    .map((m) => unescapeXml(m[1]!))
    .join(" ")
    .trim();
  const fontRef = /<a:fontRef\b[^>]*>([\s\S]*?)<\/a:fontRef>/.exec(style)?.[1];
  const labelColor =
    colorIn(/<a:rPr\b[^>]*>([\s\S]*?)<\/a:rPr>/.exec(block)?.[0] ?? "", theme) ?? (fontRef ? colorIn(fontRef, theme) : undefined);
  const t: ElementType = "shape";
  return el(
    {
      type: t,
      shape: kind,
      fill,
      stroke,
      strokeWidth: strokeW,
      ...(radius ? { radius } : {}),
      ...(label ? { text: label } : {}),
      ...(label && labelColor ? { color: labelColor } : {}),
    },
    g,
  );
}

// DrawingML chart-type tags that map onto an Élium ChartKind. Doughnut has no
// dedicated Élium kind but is the same "proportions of a whole" data shape as
// pie, so it degrades to "pie" (a real equivalent, not a mislabel — just no hole).
const SUPPORTED_CHART_TAGS: Record<string, ChartKind> = {
  "c:barChart": "bar",
  "c:bar3DChart": "bar",
  "c:lineChart": "line",
  "c:line3DChart": "line",
  "c:pieChart": "pie",
  "c:pie3DChart": "pie",
  "c:ofPieChart": "pie",
  "c:doughnutChart": "pie",
};
// Chart-type tags Élium has no visual equivalent for at all — these must warn
// rather than silently degrade into "bar" (misrepresents the data entirely:
// e.g. an area trend or an x/y scatter plotted as discrete bars).
const UNSUPPORTED_CHART_LABELS: Record<string, string> = {
  "c:areaChart": "aire",
  "c:area3DChart": "aire",
  "c:scatterChart": "nuage de points",
  "c:bubbleChart": "nuage de points (bulles)",
  "c:radarChart": "radar",
  "c:stockChart": "boursier",
  "c:surfaceChart": "surface",
  "c:surface3DChart": "surface",
};

/** Detects the chart's real DrawingML type. Multiple *different* chart-type
 *  tags in one part (a combo chart, e.g. bar+line) has no single supported
 *  kind either, so it is also reported as unsupported ("combiné"). */
function detectChartKind(xml: string): { kind?: ChartKind; unsupportedLabel?: string } {
  const supported = Object.keys(SUPPORTED_CHART_TAGS).filter((t) => new RegExp(`<${t}\\b`).test(xml));
  const unsupported = Object.keys(UNSUPPORTED_CHART_LABELS).filter((t) => new RegExp(`<${t}\\b`).test(xml));
  const distinctKinds = new Set(supported.map((t) => SUPPORTED_CHART_TAGS[t]!));
  const distinctLabels = new Set(unsupported.map((t) => UNSUPPORTED_CHART_LABELS[t]!));
  if (unsupported.length && supported.length) return { unsupportedLabel: "combiné" };
  if (distinctLabels.size > 1) return { unsupportedLabel: "combiné" };
  if (distinctLabels.size === 1) return { unsupportedLabel: [...distinctLabels][0] };
  if (distinctKinds.size > 1) return { unsupportedLabel: "combiné" };
  if (distinctKinds.size === 1) return { kind: [...distinctKinds][0] };
  return {}; // no recognized chart-type tag at all (malformed/unknown part)
}

/** Parse a DrawingML chart part (literal or cached data) back to ChartData.
 *  `unsupportedLabel` is set (data is always null then) when the chart's real
 *  type has no Élium equivalent — the caller must warn instead of importing it. */
function parseChart(xml: string): { data: ChartData | null; unsupportedLabel?: string } {
  const { kind, unsupportedLabel } = detectChartKind(xml);
  if (unsupportedLabel) return { data: null, unsupportedLabel };
  if (!kind) return { data: null };
  const ptValues = (blockXml: string): string[] =>
    [...blockXml.matchAll(/<c:pt\b[^>]*>\s*<c:v>([\s\S]*?)<\/c:v>/g)].map((m) => unescapeXml(m[1]!.trim()));
  const catBlock = /<c:cat>([\s\S]*?)<\/c:cat>/.exec(xml)?.[1] ?? "";
  const valBlock = /<c:val>([\s\S]*?)<\/c:val>/.exec(xml)?.[1] ?? "";
  const labels = ptValues(catBlock);
  const values = ptValues(valBlock).map((v) => Number(v) || 0);
  // Title: the chart's own <c:title> rich text if present, else the series name.
  const titleRich = /<c:title>[\s\S]*?<a:t>([\s\S]*?)<\/a:t>/.exec(xml)?.[1];
  const serTx = /<c:tx>\s*<c:v>([\s\S]*?)<\/c:v>/.exec(xml)?.[1];
  const title = unescapeXml((titleRich ?? serTx ?? "").trim()) || undefined;
  if (!labels.length && !values.length) return { data: null };
  return { data: { kind, labels, values, ...(title ? { title } : {}) } };
}



function parseGraphicFrame(block: string, pc: ParseCtx, tf: Tf): SlideElement | null {
  const g = geomOf(block, pc.cx, pc.cy, tf);
  // Native chart: <a:graphicData uri=".../chart"><c:chart r:id="rIdN"/> → resolve
  // the referenced chart part and rebuild a chart element (inverse of pptx.ts).
  if (/<c:chart\b/.test(block)) {
    const rId = attr(/<c:chart\b[^>]*\/?>/.exec(block)?.[0] ?? "", "r:id");
    const target = rId ? pc.rels.get(rId) : undefined;
    const bytes = target ? pc.media[resolveMedia(target)] : undefined;
    if (!bytes) return null;
    const { data, unsupportedLabel } = parseChart(strFromU8(bytes));
    if (unsupportedLabel) {
      pc.onWarning?.(unsupportedLabel);
      return null;
    }
    return data ? el({ type: "chart", chart: data }, g) : null;
  }
  if (!/<a:tbl\b/.test(block)) return null; // SmartArt / OLE → skip (degrade)
  const trs = [...block.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map((m) => m[1]!);
  const cells = trs.map((tr) =>
    [...tr.matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((m) =>
      [...m[1]!.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((x) => unescapeXml(x[1]!)).join(""),
    ),
  );
  const rows = cells.length;
  const cols = cells.reduce((m, r) => Math.max(m, r.length), 0);
  if (!rows || !cols) return null;
  const norm = cells.map((r) => {
    const rr = r.slice();
    while (rr.length < cols) rr.push("");
    return rr;
  });
  const sz = Math.round(num(attr(/<a:rPr\b[^>]*>/.exec(block)?.[0] ?? "", "sz"), 18 * 75) / 75) || 18;
  const color = colorIn(block, pc.inherit.theme) ?? "#0f172a";
  return el({ type: "table", table: { rows, cols, cells: norm }, fontSize: sz, color }, g);
}

function parseSpTree(spTreeXml: string, pc: ParseCtx, tf: Tf = IDENTITY, groupId?: string): SlideElement[] {
  // mc:AlternateContent : on garde le choix moderne (mc:Choice), jamais le repli (doublon).
  const spTree = spTreeXml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, "");
  const out: SlideElement[] = [];
  const push = (e: SlideElement | null) => {
    if (e) out.push(groupId ? { ...e, groupId } : e);
  };
  for (const { tag, block } of childBlocks(spTree)) {
    try {
      if (tag === "p:pic") push(parsePic(block, pc, tf));
      else if (tag === "p:cxnSp") push(parseCxn(block, pc, tf));
      else if (tag === "p:graphicFrame") push(parseGraphicFrame(block, pc, tf));
      else if (tag === "p:sp") push(parseSp(block, pc, tf));
      else if (tag === "p:grpSp") {
        // Transformation du groupe : repère enfant (chOff/chExt) → repère parent (off/ext).
        const gx = /<p:grpSpPr>[\s\S]*?<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/.exec(block)?.[1] ?? "";
        const off = /<a:off\b([^>]*)\/?>/.exec(gx)?.[1] ?? "";
        const ext = /<a:ext\b([^>]*)\/?>/.exec(gx)?.[1] ?? "";
        const chOff = /<a:chOff\b([^>]*)\/?>/.exec(gx)?.[1] ?? "";
        const chExt = /<a:chExt\b([^>]*)\/?>/.exec(gx)?.[1] ?? "";
        const sx = num(attr(chExt, "cx")) ? num(attr(ext, "cx")) / num(attr(chExt, "cx")) : 1;
        const sy = num(attr(chExt, "cy")) ? num(attr(ext, "cy")) / num(attr(chExt, "cy")) : 1;
        const inner2: Tf = {
          ax: tf.ax * sx,
          bx: tf.ax * (num(attr(off, "x")) - num(attr(chOff, "x")) * sx) + tf.bx,
          ay: tf.ay * sy,
          by: tf.ay * (num(attr(off, "y")) - num(attr(chOff, "y")) * sy) + tf.by,
        };
        const inner = block
          .replace(/<p:nvGrpSpPr>[\s\S]*?<\/p:nvGrpSpPr>/, "")
          .replace(/<p:grpSpPr>[\s\S]*?<\/p:grpSpPr>/, "")
          .replace(/^<p:grpSp\b[^>]*>/, "")
          .replace(/<\/p:grpSp>$/, "");
        out.push(...parseSpTree(inner, pc, inner2, groupId ?? newElementId()));
      }
    } catch {
      /* skip a malformed shape rather than abort the whole slide */
    }
  }
  return out;
}

// --- media helpers ---
function resolveMedia(target: string): string {
  // slide rels targets are relative to ppt/slides/ (e.g. ../media/image1.png)
  const t = target.replace(/^(\.\.\/)+/, "");
  return t.startsWith("ppt/") ? t : `ppt/${t}`;
}
function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "png"
    ? "image/png"
    : ext === "gif"
      ? "image/gif"
      : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "svg"
          ? "image/svg+xml"
          : "application/octet-stream";
}
function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(bytes).toString("base64");
}

function parseRels(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, "Id");
    const target = attr(m[1]!, "Target");
    if (id && target) map.set(id, target);
  }
  return map;
}
/** Cible d'une relation d'un type donné (…/slideLayout, …/notesSlide…). */
function relOfType(xml: string | undefined, typeSuffix: string): string | undefined {
  if (!xml) return undefined;
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    if ((attr(m[1]!, "Type") ?? "").endsWith(typeSuffix)) return attr(m[1]!, "Target");
  }
  return undefined;
}
/** Résout une cible relative d'une partie (ex. ../slideLayouts/slideLayout1.xml depuis ppt/slides/). */
function resolveFrom(partPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const stack = partPath.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") stack.pop();
    else if (seg !== "." && seg !== "") stack.push(seg);
  }
  return stack.join("/");
}
const relsOf = (part: string): string => part.replace(/([^/]+)$/, "_rels/$1.rels");

/** Notes du présentateur : texte du placeholder « body » de la notesSlide (hors image et numéro). */
function parseNotes(xml: string): string {
  const spTree = /<p:spTree\b[^>]*>([\s\S]*)<\/p:spTree>/.exec(xml)?.[1] ?? "";
  for (const { tag, block } of childBlocks(spTree)) {
    if (tag !== "p:sp") continue;
    const ph = phOf(block);
    if (!ph || ph.type !== "body") continue;
    const tb = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(block)?.[1] ?? "";
    const lines = [...tb.matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)].map((m) => {
      const p = m[1] ?? "";
      let s = "";
      for (const r of p.matchAll(/<a:r>([\s\S]*?)<\/a:r>|(<a:br\b)/g)) {
        if (r[2]) s += "\n";
        else s += unescapeXml(/<a:t>([\s\S]*?)<\/a:t>/.exec(r[1] ?? "")?.[1] ?? "");
      }
      return s;
    });
    return lines.join("\n").replace(/\s+$/, "");
  }
  return "";
}

const plainText = (html: string): string =>
  unescapeXml(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/** Fond d'une partie (diapositive/disposition/masque) : couleur unie, ou référence de fond de thème. */
function bgOf(xml: string, theme: ThemeCtx): string | undefined {
  const bg = /<p:bg>([\s\S]*?)<\/p:bg>/.exec(xml)?.[1];
  return bg ? colorIn(bg, theme) : undefined;
}

/** Parse a .pptx byte array into an Élium Deck (free-canvas slides).
 *  `onWarning` is called once per distinct unsupported chart type encountered
 *  (aire/nuage de points/radar/boursier/surface/combiné — no Élium equivalent),
 *  so the caller can surface an explicit warning instead of the chart being
 *  silently mislabeled or dropped. */
export function importPptx(bytes: Uint8Array, onWarning?: (label: string) => void): Deck {
  const seen = new Set<string>();
  const warnOnce = onWarning
    ? (label: string) => {
        if (seen.has(label)) return;
        seen.add(label);
        onWarning(label);
      }
    : undefined;
  const zip = unzipSync(bytes);
  const text = (path: string | undefined): string | undefined => (path && zip[path] ? strFromU8(zip[path]!) : undefined);

  const pres = text("ppt/presentation.xml") ?? "";
  const sldSz = /<p:sldSz\b([^>]*)\/?>/.exec(pres)?.[1] ?? "";
  const cx = num(attr(sldSz, "cx"), 12192000);
  const cy = num(attr(sldSz, "cy"), 6858000);

  const presRels = parseRels(text("ppt/_rels/presentation.xml.rels"));
  // slide order from <p:sldId r:id="..."> in sldIdLst
  const order = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => m[1]!);
  const slidePaths = order
    .map((rId) => presRels.get(rId))
    .filter((t): t is string => !!t)
    .map((t) => (t.startsWith("ppt/") ? t : resolveFrom("ppt/presentation.xml", t)));

  // Cache masque/disposition : plusieurs diapositives partagent les mêmes parties.
  const inheritCache = new Map<string, InheritCtx>();
  const inheritFor = (layoutPath: string | undefined): InheritCtx => {
    const key = layoutPath ?? "";
    const hit = inheritCache.get(key);
    if (hit) return hit;
    const layoutXml = text(layoutPath);
    const masterTarget = layoutPath ? relOfType(text(relsOf(layoutPath)), "/slideMaster") : undefined;
    const masterPath = layoutPath && masterTarget ? resolveFrom(layoutPath, masterTarget) : undefined;
    const masterXml = text(masterPath);
    const themeTarget = masterPath ? relOfType(text(relsOf(masterPath)), "/theme") : undefined;
    const themeXml = text(themeTarget && masterPath ? resolveFrom(masterPath, themeTarget) : undefined);
    const theme = parseTheme(themeXml, masterXml);
    const styleBlock = (tag: string) => new RegExp(`<p:${tag}>([\\s\\S]*?)</p:${tag}>`).exec(masterXml ?? "")?.[1] ?? "";
    const ctx: InheritCtx = {
      theme,
      layoutPhs: parsePlaceholders(layoutXml, theme),
      masterPhs: parsePlaceholders(masterXml, theme),
      masterStyles: {
        title: parseLevels(styleBlock("titleStyle"), theme),
        body: parseLevels(styleBlock("bodyStyle"), theme),
        other: parseLevels(styleBlock("otherStyle"), theme),
      },
      bg: (layoutXml ? bgOf(layoutXml, theme) : undefined) ?? (masterXml ? bgOf(masterXml, theme) : undefined),
    };
    inheritCache.set(key, ctx);
    return ctx;
  };

  // --- Masque et dispositions (premier masque du fichier) -----------------------
  const firstSlideRels = slidePaths.length ? text(relsOf(slidePaths[0]!)) : undefined;
  const firstLayoutTarget = firstSlideRels ? relOfType(firstSlideRels, "/slideLayout") : undefined;
  const firstLayoutPath = firstLayoutTarget && slidePaths[0] ? resolveFrom(slidePaths[0], firstLayoutTarget) : undefined;
  const masterRelTarget = firstLayoutPath ? relOfType(text(relsOf(firstLayoutPath)), "/slideMaster") : undefined;
  const masterPartPath = firstLayoutPath && masterRelTarget ? resolveFrom(firstLayoutPath, masterRelTarget) : undefined;
  let master: SlideMaster | undefined;
  const layoutIdByPath = new Map<string, string>();
  if (masterPartPath && text(masterPartPath)) {
    const mRels = text(relsOf(masterPartPath)) ?? "";
    const layoutPaths = [...mRels.matchAll(/<Relationship\b([^>]*)\/?>/g)]
      .filter((m) => (attr(m[1]!, "Type") ?? "").endsWith("/slideLayout"))
      .map((m) => resolveFrom(masterPartPath, attr(m[1]!, "Target") ?? ""));
    const themeT = relOfType(mRels, "/theme");
    const themeXml = text(themeT ? resolveFrom(masterPartPath, themeT) : undefined) ?? "";
    const th = parseTheme(themeXml, text(masterPartPath));
    const latin = (tag: string) => attr(new RegExp(`<a:${tag}>\\s*<a:latin\\b([^>]*)`).exec(themeXml)?.[0] ?? "", "typeface") ?? undefined;
    const base = defaultMaster();
    const hexOf = (k: string, d: string) => (th.scheme[k] ? `#${th.scheme[k]}` : d);
    const layouts: SlideLayoutDef[] = [];
    layoutPaths.forEach((lp, i) => {
      const xml = text(lp);
      if (!xml) return;
      const ic = inheritFor(lp);
      const placeholders: LayoutPlaceholder[] = [];
      const counts: Record<string, number> = {};
      for (const p of ic.layoutPhs) {
        const kind = phKindOf(p.type);
        if (!kind) continue;
        const r = resolvePh(p.type, p.idx, ic);
        const xf = r.xf;
        if (!xf) continue;
        counts[kind] = (counts[kind] ?? 0) + 1;
        const lvl0 = r.levels[0];
        placeholders.push({
          id: `${kind}${counts[kind]}`,
          kind,
          x: round1((xf.x / cx) * 100),
          y: round1((xf.y / cy) * 100),
          w: round1((xf.w / cx) * 100),
          h: round1((xf.h / cy) * 100),
          fontSize: szToPx(lvl0?.sz ?? (kind === "title" ? 4400 : 2400), 1),
          align: lvl0?.algn === "ctr" ? "center" : lvl0?.algn === "r" ? "right" : "left",
          valign: r.anchor === "ctr" ? "middle" : r.anchor === "b" ? "bottom" : "top",
        });
      }
      const name = /<p:cSld\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] ?? `Disposition ${i + 1}`;
      const id = `lay-imp-${i + 1}`;
      layoutIdByPath.set(lp, id);
      layouts.push({ id, name: unescapeXml(name), placeholders });
    });
    if (layouts.length)
      master = {
        ...base,
        name: attr(/<a:theme\b[^>]*>/.exec(themeXml)?.[0] ?? "", "name") ?? base.name,
        fontHeading: latin("majorFont") ?? base.fontHeading,
        fontBody: latin("minorFont") ?? base.fontBody,
        colorTitle: hexOf("tx2", base.colorTitle),
        colorBody: hexOf("tx1", base.colorBody),
        colorAccent: hexOf("accent1", base.colorAccent),
        background: hexOf("bg1", base.background),
        layouts,
      };
  }

  const slides: Slide[] = [];
  slidePaths.forEach((path) => {
    const xml = text(path);
    if (!xml) return;
    const relsXml = text(relsOf(path));
    const rels = parseRels(relsXml);
    const layoutTarget = relOfType(relsXml, "/slideLayout");
    const inherit = inheritFor(layoutTarget ? resolveFrom(path, layoutTarget) : undefined);
    const spTree = /<p:spTree\b[^>]*>([\s\S]*)<\/p:spTree>/.exec(xml)?.[1] ?? "";
    const elements = parseSpTree(spTree, { cx, cy, rels, media: zip, inherit, onWarning: warnOnce });
    const bg = bgOf(xml, inherit.theme) ?? inherit.bg;
    const notesTarget = relOfType(relsXml, "/notesSlide");
    const notes = notesTarget ? parseNotes(text(resolveFrom(path, notesTarget)) ?? "") : "";
    const titleEl = (() => {
      // titre = texte du placeholder title/ctrTitle (le 1er élément texte issu d'un placeholder de titre)
      for (const { tag, block } of childBlocks(spTree)) {
        if (tag !== "p:sp") continue;
        const ph = phOf(block);
        if (ph && (ph.type === "title" || ph.type === "ctrTitle")) {
          const t = [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1]!)).join("");
          return plainText(escapeText(t));
        }
      }
      return "";
    })();
    const sld = /<p:sld\b([^>]*)>/.exec(xml)?.[1] ?? "";
    const layoutFull = layoutTarget ? resolveFrom(path, layoutTarget) : undefined;
    const layoutId = layoutFull ? layoutIdByPath.get(layoutFull) : undefined;
    slides.push({
      id: newSlideId(),
      title: titleEl,
      body: "",
      bodyHtml: "",
      layout: "blank",
      elements,
      ...(bg ? { background: bg } : {}),
      ...(notes ? { notes } : {}),
      ...(attr(sld, "show") === "0" ? { hidden: true } : {}),
      ...(layoutId ? { layoutId } : {}),
    });
  });

  if (!slides.length)
    slides.push({ id: newSlideId(), title: "", body: "", bodyHtml: "", layout: "blank", elements: [] });
  return { slides, active: 0, theme: "light", transition: "fade", ...(master ? { master } : {}) };
}

/** Convenience wrapper for a File from an <input type="file">. */
export async function importPptxFile(file: File, onWarning?: (label: string) => void): Promise<Deck> {
  return importPptx(new Uint8Array(await file.arrayBuffer()), onWarning);
}
