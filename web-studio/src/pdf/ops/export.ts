/**
 * Exporting *out* of PDF: pictures, plain text, HTML, Word and spreadsheets.
 *
 * Layout-aware where it matters — the Word and HTML exports rebuild paragraphs
 * from the text geometry instead of dumping a wall of lines, and the table
 * detector recovers simple grids so a PDF invoice lands in a spreadsheet in
 * usable shape.
 */

import { zipSync, strToU8 } from "fflate";
import type { PdfEngine } from "../core/engine";
import { renderToCanvas, canvasToBlob } from "../core/render";
import { buildRuns, groupBlocks, groupLines } from "../core/text";
import type { TextBlock, TextLine } from "../core/text";

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export type ImageFormat = "png" | "jpeg" | "webp";

export interface ImageExportOptions {
  format: ImageFormat;
  /** Output resolution; 72 = one pixel per point. */
  dpi: number;
  quality: number;
  /** 0-based page indices; omitted = every page. */
  pages?: number[];
  onProgress?: (done: number, total: number) => void;
}

export interface ExportedImage {
  name: string;
  blob: Blob;
  page: number;
}

export async function exportImages(
  engine: PdfEngine,
  baseName: string,
  opts: ImageExportOptions,
): Promise<ExportedImage[]> {
  const indices = opts.pages?.length ? opts.pages : engine.pages.map((p) => p.index);
  const scale = Math.max(0.2, opts.dpi / 72);
  const mime = `image/${opts.format}`;
  const out: ExportedImage[] = [];
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    const page = await engine.page(index);
    const canvas = await renderToCanvas(page, { scale, background: opts.format === "png" ? "#ffffff" : "#ffffff" });
    const blob = await canvasToBlob(canvas, mime, opts.quality);
    out.push({ name: `${baseName}-${String(index + 1).padStart(3, "0")}.${opts.format === "jpeg" ? "jpg" : opts.format}`, blob, page: index });
    opts.onProgress?.(i + 1, indices.length);
  }
  return out;
}

/** Bundle exported pictures into a single .zip. */
export async function zipImages(images: readonly ExportedImage[]): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const img of images) entries[img.name] = new Uint8Array(await img.blob.arrayBuffer());
  return zipSync(entries, { level: 0 }); // pictures are already compressed
}

// ---------------------------------------------------------------------------
// Text extraction with layout
// ---------------------------------------------------------------------------

export interface PageText {
  page: number;
  blocks: TextBlock[];
  lines: TextLine[];
}

/** Extract every page's text, grouped into lines and paragraphs. */
export async function extractLayout(
  engine: PdfEngine,
  onProgress?: (done: number, total: number) => void,
): Promise<PageText[]> {
  const out: PageText[] = [];
  for (let i = 0; i < engine.pageCount; i++) {
    const page = await engine.page(i);
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    const tc = await engine.text(i);
    const runs = buildRuns(tc, vp.transform as unknown as number[]);
    const lines = groupLines(runs, tc.items);
    out.push({ page: i, lines, blocks: groupBlocks(lines) });
    onProgress?.(i + 1, engine.pageCount);
  }
  return out;
}

export function toPlainText(pages: readonly PageText[], separator = "\n\n"): string {
  // A form feed between pages is the convention text tools expect.
  return pages
    .map((p) => p.blocks.map((b) => b.lines.map((l) => l.text).join(" ")).join(separator))
    .join("\n\f\n")
    .trim();
}

/** Plain text with an explicit page marker between pages. */
export function toPlainTextWithMarkers(pages: readonly PageText[]): string {
  return pages
    .map((p) => `--- Page ${p.page + 1} ---\n${p.blocks.map((b) => b.lines.map((l) => l.text).join(" ")).join("\n\n")}`)
    .join("\n\n");
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Reconstructed HTML: paragraphs, headings inferred from relative size. */
export function toHtml(pages: readonly PageText[], title: string): string {
  const sizes = pages.flatMap((p) => p.blocks.map((b) => b.fontSize)).sort((a, b) => a - b);
  const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 11;
  const parts: string[] = [];
  for (const p of pages) {
    parts.push(`<section class="page" data-page="${p.page + 1}">`);
    for (const b of p.blocks) {
      const text = escapeHtml(b.lines.map((l) => l.text).join(" ")).trim();
      if (!text) continue;
      const ratio = b.fontSize / body;
      const tag = ratio >= 1.7 ? "h1" : ratio >= 1.35 ? "h2" : ratio >= 1.15 ? "h3" : "p";
      const style = b.align !== "left" ? ` style="text-align:${b.align === "justify" ? "justify" : b.align}"` : "";
      parts.push(`<${tag}${style}>${text}</${tag}>`);
    }
    parts.push("</section>");
  }
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
 body{font:16px/1.6 Inter,system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1.25rem;color:#0f172a}
 .page{margin-bottom:3rem;padding-bottom:2rem;border-bottom:1px solid #e2e8f0}
 .page:last-child{border-bottom:0}
 h1{font-size:1.9em}h2{font-size:1.45em}h3{font-size:1.2em}
 p{margin:0 0 .75em}
</style></head><body>
${parts.join("\n")}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCX_DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * Build a .docx from the extracted layout. Paragraphs keep their alignment,
 * their relative size (mapped to Word heading styles) and bold/italic runs.
 */
export function toDocx(pages: readonly PageText[], title: string): Uint8Array {
  const sizes = pages.flatMap((p) => p.blocks.map((b) => b.fontSize)).sort((a, b) => a - b);
  const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 11;
  const align: Record<string, string> = { left: "left", center: "center", right: "right", justify: "both" };

  const paragraphs: string[] = [];
  pages.forEach((p, pageIndex) => {
    for (const b of p.blocks) {
      const text = b.lines.map((l) => l.text).join(" ").trim();
      if (!text) continue;
      const ratio = b.fontSize / bodySize;
      const style = ratio >= 1.7 ? "Heading1" : ratio >= 1.35 ? "Heading2" : ratio >= 1.15 ? "Heading3" : "";
      const half = Math.round(b.fontSize * 2);
      paragraphs.push(
        `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}` +
        `<w:jc w:val="${align[b.align] ?? "left"}"/></w:pPr>` +
        `<w:r><w:rPr><w:sz w:val="${half}"/><w:szCs w:val="${half}"/>` +
        `${b.bold ? "<w:b/>" : ""}${b.italic ? "<w:i/>" : ""}</w:rPr>` +
        `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`,
      );
    }
    if (pageIndex < pages.length - 1) {
      paragraphs.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }
  });

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
</w:document>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(title)}</dc:title><dc:creator>Elium PDF</dc:creator></cp:coreProperties>`;

  return zipSync({
    "[Content_Types].xml": strToU8(DOCX_CONTENT_TYPES),
    "_rels/.rels": strToU8(DOCX_RELS),
    "docProps/core.xml": strToU8(core),
    "word/_rels/document.xml.rels": strToU8(DOCX_DOC_RELS),
    "word/document.xml": strToU8(document),
  }, { level: 6 });
}

// ---------------------------------------------------------------------------
// Tables → CSV
// ---------------------------------------------------------------------------

export interface DetectedTable {
  page: number;
  rows: string[][];
}

/**
 * Recover simple tables: lines whose runs cluster into the same set of column
 * x-positions across several consecutive lines. Good enough for invoices and
 * statements, which is what people actually want out of a PDF.
 */
export function detectTables(pages: readonly PageText[], minRows = 3): DetectedTable[] {
  const out: DetectedTable[] = [];
  for (const p of pages) {
    let group: TextLine[] = [];
    const flush = () => {
      if (group.length >= minRows) {
        const columns = columnEdges(group);
        if (columns.length >= 2) {
          out.push({ page: p.page, rows: group.map((l) => splitByColumns(l, columns)) });
        }
      }
      group = [];
    };
    for (const line of p.lines) {
      const gaps = countGaps(line);
      if (gaps >= 1) {
        const prev = group[group.length - 1];
        if (!prev || Math.abs(line.origin.y - prev.origin.y) < prev.fontSize * 3) group.push(line);
        else { flush(); group = [line]; }
      } else {
        flush();
      }
    }
    flush();
  }
  return out;
}

function countGaps(line: TextLine): number {
  let gaps = 0;
  for (let i = 1; i < line.runs.length; i++) {
    const prev = line.runs[i - 1];
    const cur = line.runs[i];
    if (cur.rect.x - (prev.rect.x + prev.rect.w) > prev.fontSize * 1.4) gaps++;
  }
  return gaps;
}

function columnEdges(lines: readonly TextLine[]): number[] {
  const marks: number[] = [];
  for (const l of lines) {
    for (let i = 0; i < l.runs.length; i++) {
      const prev = l.runs[i - 1];
      if (!prev || l.runs[i].rect.x - (prev.rect.x + prev.rect.w) > prev.fontSize * 1.2) marks.push(l.runs[i].rect.x);
    }
  }
  marks.sort((a, b) => a - b);
  const merged: number[] = [];
  for (const m of marks) {
    if (!merged.length || m - merged[merged.length - 1] > 6) merged.push(m);
  }
  // Keep the edges that show up on most rows.
  return merged.filter((edge) => lines.filter((l) => l.runs.some((r) => Math.abs(r.rect.x - edge) < 6)).length >= lines.length * 0.5);
}

function splitByColumns(line: TextLine, columns: readonly number[]): string[] {
  const cells = columns.map(() => "");
  for (const run of line.runs) {
    let col = 0;
    for (let i = columns.length - 1; i >= 0; i--) {
      if (run.rect.x + 3 >= columns[i]) { col = i; break; }
    }
    cells[col] += run.str;
  }
  return cells.map((c) => c.trim());
}

export function tablesToCsv(tables: readonly DetectedTable[]): string {
  const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return tables
    .map((t) => `# Page ${t.page + 1}\r\n${t.rows.map((r) => r.map(esc).join(";")).join("\r\n")}`)
    .join("\r\n\r\n");
}
