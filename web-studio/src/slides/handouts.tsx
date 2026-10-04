/**
 * Documents (handouts) et pages de notes en PDF : les diapositives sont dessinées par le moteur de la
 * présentation (SlideCanvas) puis posées en miniatures sur des pages A4 selon handouts-layout.ts ; la
 * mise en page et l'écriture du PDF passent par le chemin existant (HTML → pages → PDF + couche de texte).
 */
import { renderToStaticMarkup } from "react-dom/server";
import SlideCanvas from "./canvas";
import slidesCss from "./slides.css?raw";
import { elementsOf, REF_H, REF_W, type Deck } from "./model";
import { expandTokens, notesLines, pageSize, planHandouts, slotsFor, type HandoutOptions } from "./handouts-layout";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PX_PT = 72 / 96;

/** Marque les attributs `style` du texte riche (la CSP interdit de les parser en ligne) — même règle que « Créer un PDF ». */
async function renameStyles(html: string): Promise<string> {
  const { renameStyleAttributes } = await import("../pdf/ops/create-from-file");
  return renameStyleAttributes(html);
}

/** Corps HTML (une `div.elium-fixed-page` par page) + feuille de style, prêts pour `renderHtmlSource`. */
export async function handoutsHtml(
  deck: Deck,
  title: string,
  o: HandoutOptions,
): Promise<{ pages: string[]; css: string; width: number; height: number }> {
  const size = pageSize(o);
  const plan = planHandouts(deck.slides, o);
  const slots = slotsFor(o.mode, size);
  const k = (w: number) => w / REF_W;
  const markup = new Map<number, string>();
  for (const i of plan.keep) {
    const slide = deck.slides[i]!;
    const elements = await Promise.all(
      elementsOf(slide).map(async (e) => (e.html ? { ...e, html: await renameStyles(e.html) } : e)),
    );
    markup.set(
      i,
      renderToStaticMarkup(
        <SlideCanvas slide={slide} elements={elements} theme={deck.theme ?? "light"} scale={1} slideNumber={i + 1} />,
      ),
    );
  }
  const pages = plan.pages.map((pg, pi) => {
    const ctx = { title, page: pi + 1, pages: plan.pages.length };
    const head = expandTokens(o.header, ctx);
    const foot = expandTokens(o.footer, ctx);
    const items = pg.slideIndexes
      .map((si, slot) => {
        const s = slots[slot]!;
        const slide = deck.slides[si]!;
        const frame = o.frame ? "outline:1px solid #cbd5e1;" : "";
        const thumb =
          `<div style="position:absolute;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;overflow:hidden;${frame}background:#fff">` +
          `<div style="position:absolute;left:0;top:0;width:${REF_W}px;height:${REF_H}px;transform:scale(${k(s.w)});transform-origin:0 0">${markup.get(si) ?? ""}</div></div>`;
        let note = "";
        if (s.note) {
          if (o.mode === 3) {
            // lignes de notes à tracer à la main
            const lines = Array.from(
              { length: 5 },
              (_, n) =>
                `<div style="position:absolute;left:0;right:0;top:${((n + 1) * s.note!.h) / 6}px;border-bottom:1px solid #94a3b8"></div>`,
            ).join("");
            note = `<div style="position:absolute;left:${s.note.x}px;top:${s.note.y}px;width:${s.note.w}px;height:${s.note.h}px">${lines}</div>`;
          } else {
            const text = notesLines(slide)
              .map((l) => `<p style="margin:0 0 6px">${esc(l)}</p>`)
              .join("");
            note = `<div class="ho-notes" style="position:absolute;left:${s.note.x}px;top:${s.note.y}px;width:${s.note.w}px;height:${s.note.h}px;overflow:hidden">${text || '<span style="color:#94a3b8">Aucune note.</span>'}</div>`;
          }
        }
        const num = `<div class="ho-num" style="position:absolute;left:${s.x}px;top:${s.y - 16}px">${si + 1}</div>`;
        return thumb + num + note;
      })
      .join("");
    return (
      `<div class="elium-fixed-page" style="position:relative;overflow:hidden;width:${size.w}px;height:${size.h}px">` +
      (head ? `<div class="ho-hf" style="top:28px">${esc(head)}</div>` : "") +
      items +
      (foot ? `<div class="ho-hf" style="bottom:28px">${esc(foot)}</div>` : "") +
      `</div>`
    );
  });
  const css = `${slidesCss}
:root{--el-slate-300:#cbd5e1;--el-slate-900:#0f172a;--el-border-strong:#cbd5e1;--border-strong:#cbd5e1;--el-text-muted:#64748b;--text-muted:#64748b}
html,body{margin:0;padding:0;background:transparent;font-family:Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a}
.elium-fixed-page{break-after:page;background:#fff}
.ho-hf{position:absolute;left:0;right:0;text-align:center;font-size:11px;color:#475569}
.ho-num{font-size:10px;color:#64748b}
.ho-notes{font-size:13px;line-height:1.45}`;
  return { pages, css, width: size.w, height: size.h };
}

/** Génère le PDF (navigateur requis). */
export async function handoutsToPdf(
  deck: Deck,
  title: string,
  o: HandoutOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const built = await handoutsHtml(deck, title, o);
  if (!built.pages.length) throw new Error("Aucune diapositive à imprimer (toutes sont masquées ?).");
  const { assemblePdf } = await import("../pdf/ops/create-from-file");
  const { renderHtmlSource } = await import("../pdf/ui/htmlToPdf");
  const source = {
    layout: "fixed" as const,
    title,
    lang: "fr",
    css: built.css,
    body: built.pages.join(""),
    page: {
      width: built.width * PX_PT,
      height: built.height * PX_PT,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    creator: "Elium — PowerPoint",
  };
  const rendered = await renderHtmlSource(source, { onProgress });
  const bytes = await assemblePdf(rendered, { title, lang: "fr", creator: source.creator, margin: source.page.margin });
  return { bytes, pageCount: rendered.length };
}
