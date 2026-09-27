/**
 * A PowerPoint deck as HTML pages for « Créer un PDF depuis un fichier »: each
 * slide drawn by the Présentations module's own renderer (`SlideCanvas`), at
 * the presentation's size, into a fixed-size page.
 *
 * The canvas is rendered off-document (an inert HTML document, no layout) and
 * only its markup is kept, with the module's style sheet — the pages are laid
 * out and drawn by `htmlToPdf.ts` like every other source.
 */

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { strFromU8, unzipSync } from "fflate";
import SlideCanvas from "../../slides/canvas";
import { elementsOf, REF_H, type Deck } from "../../slides/model";
import slidesCss from "../../slides/slides.css?raw";
import { baseName, FIXED_PAGE_CLASS, renameStyleAttributes, type HtmlSource } from "../ops/create-from-file";

/** EMUs per point. */
const EMU_PER_PT = 12700;

/** The slide size of a .pptx (points), 16:9 widescreen when unreadable. */
export function pptxSlideSize(bytes: Uint8Array): { width: number; height: number } {
  let cx = 12192000;
  let cy = 6858000;
  try {
    const zip = unzipSync(bytes, { filter: (f) => f.name === "ppt/presentation.xml" });
    const pres = zip["ppt/presentation.xml"] ? strFromU8(zip["ppt/presentation.xml"]) : "";
    const sz = /<p:sldSz\b([^>]*)\/?>/.exec(pres)?.[1] ?? "";
    cx = Number(/\bcx="(\d+)"/.exec(sz)?.[1]) || cx;
    cy = Number(/\bcy="(\d+)"/.exec(sz)?.[1]) || cy;
  } catch {
    /* keep the default size */
  }
  return { width: cx / EMU_PER_PT, height: cy / EMU_PER_PT };
}

/** The design tokens the slide style sheet reads (defined by the app's root style sheet). */
const TOKENS_CSS = `:root{--el-slate-300:#cbd5e1;--el-slate-900:#0f172a;--el-border-strong:#cbd5e1;--border-strong:#cbd5e1;--el-text-muted:#64748b;--text-muted:#64748b}
html,body{margin:0;padding:0;background:transparent}
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a}
.${FIXED_PAGE_CLASS}{position:relative;overflow:hidden;break-after:page}`;

/**
 * The deck's slides as fixed pages. The canvas is laid out at the reference
 * height (720 px) and the presentation's aspect ratio, as on screen.
 */
export function deckSource(deck: Deck, pptx: Uint8Array | null, name: string): HtmlSource {
  const size = pptx ? pptxSlideSize(pptx) : { width: 960, height: 540 };
  const hPx = REF_H;
  const wPx = Math.round((REF_H * size.width) / size.height);
  const inert = document.implementation.createHTMLDocument("");
  const pages: string[] = [];
  for (const slide of deck.slides) {
    const host = inert.createElement("div");
    inert.body.appendChild(host);
    const root = createRoot(host);
    // Rich text is set as markup: its inline styles must not be parsed here (CSP).
    const elements = elementsOf(slide).map((e) => (e.html ? { ...e, html: renameStyleAttributes(e.html) } : e));
    flushSync(() => {
      root.render(<SlideCanvas slide={slide} elements={elements} theme={deck.theme ?? "light"} scale={1} />);
    });
    pages.push(`<div class="${FIXED_PAGE_CLASS}" style="width:${wPx}px;height:${hPx}px">${host.innerHTML}</div>`);
    root.unmount();
    host.remove();
  }
  return {
    layout: "fixed",
    title: baseName(name),
    lang: "fr",
    css: `${slidesCss}\n${TOKENS_CSS}`,
    body: pages.join(""),
    // The page is the slide at the presentation's own size (the canvas is scaled to it).
    page: { width: size.width, height: size.height, margin: { top: 0, right: 0, bottom: 0, left: 0 } },
    creator: "Elium — PowerPoint",
  };
}
