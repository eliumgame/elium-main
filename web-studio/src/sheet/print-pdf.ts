/**
 * Impression du Tableur en PDF par le chemin existant (HTML → mise en page navigateur → pages
 * dessinées → PDF avec couche de texte), page par page selon la pagination de print.ts :
 * zone d'impression, lignes/colonnes répétées, sauts de page, échelle, en-tête/pied.
 */
import type { Workbook } from "./model";
import { expandHeaderFooter, normalizePrint, pageSizePx, paginate, type PrintSetup } from "./print";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MM_PX = 96 / 25.4;
const PX_PT = 72 / 96;

/** HTML des pages d'impression d'une feuille (pur, sans navigateur : testable avec jsdom ou en chaîne). */
export async function printPagesHtml(
  wb: Workbook,
  index: number,
  setupIn?: Partial<PrintSetup>,
): Promise<{ pages: string[]; width: number; height: number; css: string; count: number } | null> {
  const sheet = wb.sheets[index];
  if (!sheet) return null;
  const setup = normalizePrint(setupIn ?? sheet.print);
  const { sheetToHtml, SHEET_CSS } = await import("../pdf/ops/create-from-file");
  const plan = paginate(sheet, setup);
  const size = pageSizePx(setup);
  const m = setup.margins;
  const pages = plan.pages.map((pg) => {
    const t = sheetToHtml(wb, index, {
      rows: pg.rows,
      cols: pg.cols,
      gridlines: setup.gridlines,
      headings: setup.headings,
    });
    const ctx = { page: pg.index, pages: plan.pages.length, sheet: sheet.name };
    const head = expandHeaderFooter(setup.header, ctx);
    const foot = expandHeaderFooter(setup.footer, ctx);
    return (
      `<div class="elium-fixed-page" style="position:relative;overflow:hidden;width:${Math.round(size.w)}px;height:${Math.round(size.h)}px">` +
      `<div style="position:absolute;left:${m.left * MM_PX}px;top:${m.top * MM_PX}px;width:${plan.usable.w}px;height:${plan.usable.h}px;overflow:hidden">` +
      `<div style="zoom:${plan.scale};width:${plan.usable.w / plan.scale}px">${t?.html ?? ""}</div></div>` +
      (head ? `<div class="xs-hf" style="top:${Math.max(4, m.top * MM_PX * 0.3)}px">${esc(head)}</div>` : "") +
      (foot ? `<div class="xs-hf" style="bottom:${Math.max(4, m.bottom * MM_PX * 0.3)}px">${esc(foot)}</div>` : "") +
      `</div>`
    );
  });
  const css = `${SHEET_CSS}\nhtml,body{margin:0;padding:0;background:transparent}\n.elium-fixed-page{break-after:page;background:#fff}\n.xs-hf{position:absolute;left:0;right:0;text-align:center;font-size:9pt;color:#475569}`;
  return { pages, width: size.w, height: size.h, css, count: plan.pages.length };
}

/** Génère le PDF (navigateur requis) ; `onProgress` reçoit la progression de la mise en page. */
export async function sheetToPdf(
  wb: Workbook,
  index: number,
  setupIn?: Partial<PrintSetup>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const built = await printPagesHtml(wb, index, setupIn);
  if (!built || !built.count) throw new Error("Rien à imprimer : la zone d'impression est vide.");
  const { assemblePdf, FIXED_PAGE_CLASS } = await import("../pdf/ops/create-from-file");
  void FIXED_PAGE_CLASS;
  const { renderHtmlSource } = await import("../pdf/ui/htmlToPdf");
  const title = wb.sheets[index]!.name;
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
    creator: "Elium — Excel",
  };
  const rendered = await renderHtmlSource(source, { onProgress });
  const bytes = await assemblePdf(rendered, { title, lang: "fr", creator: source.creator, margin: source.page.margin });
  return { bytes, pageCount: rendered.length };
}
