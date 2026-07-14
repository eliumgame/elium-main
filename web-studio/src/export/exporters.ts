/**
 * Export pipeline. A self-contained ProseMirror-JSON serializer (no extra deps)
 * produces HTML and Markdown; PDF is delivered through the browser print dialog
 * so it works offline without bundling a PDF engine.
 *
 * Signatures are rendered as a dedicated "Signatures" appendix — reliable across
 * page breaks, the way a signature page works in a real document.
 */

import type {
  EliumDocumentModel,
  EliumFile,
  EliumSignature,
  ProseMirrorNode,
  SignatureVerdict,
} from "../format/types";
import { verifyJournal } from "../format/journal";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Allow only safe link schemes so a malicious doc can't inject `javascript:`/`data:`. */
function safeHref(url: string): string {
  const u = url.trim();
  if (/^(https?:|mailto:|tel:|#|\/|\.{0,2}\/)/i.test(u) && !/^\s*javascript:/i.test(u)) return esc(u);
  return "#";
}

/** Reject CSS values containing tokens that could exfiltrate data or break out of the attribute. */
function safeCss(value: string): string {
  const v = value.trim();
  if (/[<>{}();]|url\(|expression|@import|\/\*/i.test(v)) return "";
  return esc(v);
}

// --- Table of contents (shared heading pre-pass) --------------------------

interface Heading {
  level: number;
  text: string;
  slug: string;
}

/**
 * Collect H1–H3 in document order; the nth such heading gets a stable id
 * `toc-h-{n}`. The HTML heading renderer uses the same H1–H3 counter, so the
 * TOC anchors line up with the heading ids.
 */
function collectHeadings(doc: ProseMirrorNode): Heading[] {
  const out: Heading[] = [];
  const walk = (node: ProseMirrorNode) => {
    if (node.type === "heading") {
      const level = Number(node.attrs?.level ?? 1);
      if (level <= 3) {
        const text = (node.content ?? []).map((c) => c.text ?? "").join("").trim();
        out.push({ level, text: text || "Sans titre", slug: `toc-h-${out.length}` });
      }
    }
    (node.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}

/** Collect footnotes in document order so refs and the notes list can be numbered. */
function collectFootnotes(doc: ProseMirrorNode): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const walk = (n: ProseMirrorNode) => {
    if (n.type === "footnote") out.push({ id: String(n.attrs?.id ?? out.length + 1), text: String(n.attrs?.text ?? "") });
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}
const fnNum = (fns: { id: string }[], id: unknown): number => fns.findIndex((f) => f.id === String(id)) + 1;

function tocHtml(headings: Heading[]): string {
  const inner = headings.length
    ? `<ol class="elium-toc__list">${headings
        .map((h) => `<li class="elium-toc__item elium-toc__item--h${h.level}"><a href="#${h.slug}">${esc(h.text)}</a></li>`)
        .join("")}</ol>`
    : '<p class="elium-toc__empty">Aucun titre.</p>';
  return `<nav class="elium-toc"><div class="elium-toc__title">Table des matières</div>${inner}</nav>`;
}

interface HtmlCtx {
  headings: Heading[];
  hi: number;
  footnotes: { id: string; text: string }[];
}

// --- HTML -----------------------------------------------------------------

function inlineHtml(node: ProseMirrorNode): string {
  if (node.type === "hardBreak") return "<br>";
  if (node.type !== "text" || node.text == null) return "";
  let html = esc(node.text);
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold": html = `<strong>${html}</strong>`; break;
      case "italic": html = `<em>${html}</em>`; break;
      case "underline": html = `<u>${html}</u>`; break;
      case "strike": html = `<s>${html}</s>`; break;
      case "code": html = `<code>${html}</code>`; break;
      case "highlight": html = `<mark>${html}</mark>`; break;
      case "link": html = `<a href="${safeHref(String(mark.attrs?.href ?? "#"))}">${html}</a>`; break;
      case "textStyle": {
        const a = mark.attrs ?? {};
        const style = [
          a.color ? `color:${safeCss(String(a.color))}` : "",
          a.fontFamily ? `font-family:${safeCss(String(a.fontFamily))}` : "",
          a.fontSize ? `font-size:${safeCss(String(a.fontSize))}` : "",
        ].filter((s) => s && !s.endsWith(":")).join(";");
        if (style) html = `<span style="${style}">${html}</span>`;
        break;
      }
    }
  }
  return html;
}

function blockStyle(node: ProseMirrorNode): string {
  const parts: string[] = [];
  const a = node.attrs?.textAlign;
  if (a && a !== "left") parts.push(`text-align:${esc(String(a))}`);
  const indent = Number(node.attrs?.indent) || 0;
  if (indent > 0) parts.push(`margin-left:${indent * 2}em`);
  return parts.length ? ` style="${parts.join(";")}"` : "";
}

function blockHtml(node: ProseMirrorNode, ctx: HtmlCtx): string {
  const kids = (node.content ?? []).map((c) => nodeHtml(c, ctx)).join("");
  switch (node.type) {
    case "doc": return kids;
    case "paragraph": return `<p${blockStyle(node)}>${kids || "<br>"}</p>`;
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      const id = level <= 3 ? ` id="${ctx.headings[ctx.hi++]?.slug ?? ""}"` : "";
      return `<h${level}${id}${blockStyle(node)}>${kids}</h${level}>`;
    }
    case "tableOfContents": return tocHtml(ctx.headings);
    case "footnote": {
      const n = fnNum(ctx.footnotes, node.attrs?.id);
      return `<sup class="elium-fn-ref" id="fnref-${n}"><a href="#fn-${n}">${n || "?"}</a></sup>`;
    }
    case "footnotesList": {
      if (!ctx.footnotes.length) return "";
      const items = ctx.footnotes
        .map((f, i) => `<li id="fn-${i + 1}">${esc(f.text)} <a class="elium-fn-back" href="#fnref-${i + 1}">↩</a></li>`)
        .join("");
      return `<section class="elium-footnotes"><hr><ol>${items}</ol></section>`;
    }
    case "bookmark": return `<a id="${esc(String(node.attrs?.id ?? ""))}" class="elium-bookmark"></a>`;
    case "pageBreak": return '<div class="elium-page-break" style="page-break-after:always"></div>';
    case "bulletList": return `<ul>${kids}</ul>`;
    case "orderedList": return `<ol>${kids}</ol>`;
    case "listItem": return `<li>${kids}</li>`;
    case "taskList": return `<ul class="task-list">${kids}</ul>`;
    case "taskItem": return `<li class="task-item"><input type="checkbox" disabled ${node.attrs?.checked ? "checked" : ""}> ${kids}</li>`;
    case "blockquote": return `<blockquote>${kids}</blockquote>`;
    case "codeBlock": {
      const lang = node.attrs?.language ? ` class="language-${esc(String(node.attrs.language))}"` : "";
      const raw = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `<pre><code${lang}>${esc(raw)}</code></pre>`;
    }
    case "horizontalRule": return "<hr>";
    case "image": return `<img src="${esc(String(node.attrs?.src ?? ""))}" alt="${esc(String(node.attrs?.alt ?? ""))}">`;
    case "figure": {
      const align = esc(String(node.attrs?.align ?? "center"));
      const w = node.attrs?.width ? safeCss(String(node.attrs.width)) : "";
      const style = w ? ` style="width:${w}"` : "";
      const img = `<img src="${esc(String(node.attrs?.src ?? ""))}" alt="${esc(String(node.attrs?.alt ?? ""))}">`;
      const cap = kids.trim() ? `<figcaption>${kids}</figcaption>` : "";
      return `<figure class="elium-figure elium-figure--${align}"${style}>${img}${cap}</figure>`;
    }
    case "table": return `<table>${kids}</table>`;
    case "tableRow": return `<tr>${kids}</tr>`;
    case "tableHeader": return `<th${spanAttrs(node)}>${kids}</th>`;
    case "tableCell": return `<td${spanAttrs(node)}>${kids}</td>`;
    default: return kids;
  }
}

function spanAttrs(node: ProseMirrorNode): string {
  const cs = Number(node.attrs?.colspan ?? 1);
  const rs = Number(node.attrs?.rowspan ?? 1);
  return `${cs > 1 ? ` colspan="${cs}"` : ""}${rs > 1 ? ` rowspan="${rs}"` : ""}`;
}

function nodeHtml(node: ProseMirrorNode, ctx: HtmlCtx): string {
  if (node.type === "text" || node.type === "hardBreak") return inlineHtml(node);
  return blockHtml(node, ctx);
}

export function docToHtml(model: EliumDocumentModel): string {
  return blockHtml(model.doc, { headings: collectHeadings(model.doc), hi: 0, footnotes: collectFootnotes(model.doc) });
}

// --- Markdown -------------------------------------------------------------

function inlineMd(node: ProseMirrorNode): string {
  if (node.type === "hardBreak") return "  \n";
  if (node.type !== "text" || node.text == null) return "";
  let t = node.text;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold": t = `**${t}**`; break;
      case "italic": t = `*${t}*`; break;
      case "strike": t = `~~${t}~~`; break;
      case "code": t = `\`${t}\``; break;
      case "link": t = `[${t}](${mark.attrs?.href ?? "#"})`; break;
    }
  }
  return t;
}

function tocMd(headings: Heading[]): string {
  if (!headings.length) return "## Table des matières\n";
  const lines = headings.map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}- ${h.text}`);
  return `## Table des matières\n${lines.join("\n")}\n`;
}

function nodeMd(node: ProseMirrorNode, depth = 0, headings: Heading[] = [], fns: { id: string; text: string }[] = []): string {
  const inline = (n: ProseMirrorNode) => (n.content ?? []).map((c) => (c.type === "text" || c.type === "hardBreak" ? inlineMd(c) : nodeMd(c, depth, headings, fns))).join("");
  switch (node.type) {
    case "doc": return (node.content ?? []).map((c) => nodeMd(c, depth, headings, fns)).join("\n");
    case "paragraph": return inline(node) + "\n";
    case "heading": return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${inline(node)}\n`;
    case "tableOfContents": return tocMd(headings);
    case "footnote": return `[^${fnNum(fns, node.attrs?.id) || "?"}]`;
    case "footnotesList": return fns.length ? "\n" + fns.map((f, i) => `[^${i + 1}]: ${f.text}`).join("\n") + "\n" : "";
    case "bookmark": return "";
    case "bulletList": return (node.content ?? []).map((li) => `${"  ".repeat(depth)}- ${nodeMd(li, depth + 1, headings, fns).trim()}`).join("\n") + "\n";
    case "orderedList": return (node.content ?? []).map((li, i) => `${"  ".repeat(depth)}${i + 1}. ${nodeMd(li, depth + 1, headings, fns).trim()}`).join("\n") + "\n";
    case "listItem": case "taskItem": return inline(node);
    case "taskList": return (node.content ?? []).map((li) => `- [${li.attrs?.checked ? "x" : " "}] ${nodeMd(li, depth + 1, headings, fns).trim()}`).join("\n") + "\n";
    case "blockquote": return inline(node).split("\n").map((l) => `> ${l}`).join("\n") + "\n";
    case "codeBlock": return "```" + (node.attrs?.language ?? "") + "\n" + (node.content ?? []).map((c) => c.text ?? "").join("") + "\n```\n";
    case "horizontalRule": return "---\n";
    case "pageBreak": return "\n";
    case "image": return `![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})\n`;
    case "figure": {
      const cap = inline(node).trim();
      return `![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})\n${cap ? `*${cap}*\n` : ""}`;
    }
    case "table": return tableMd(node);
    default: return inline(node);
  }
}

function tableMd(table: ProseMirrorNode): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => (cell.content ?? []).map((c) => nodeMd(c).trim()).join(" ")),
  );
  if (!rows.length) return "";
  const head = rows[0];
  const sep = head.map(() => "---");
  const body = rows.slice(1);
  const fmt = (r: string[]) => `| ${r.join(" | ")} |`;
  return [fmt(head), fmt(sep), ...body.map(fmt)].join("\n") + "\n";
}

export function docToMarkdown(model: EliumDocumentModel): string {
  return nodeMd(model.doc, 0, collectHeadings(model.doc), collectFootnotes(model.doc)).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// --- Plain text -----------------------------------------------------------

function inlineText(node: ProseMirrorNode, fns: { id: string; text: string }[] = []): string {
  return (node.content ?? []).map((c) =>
    c.type === "text" ? c.text ?? "" : c.type === "hardBreak" ? "\n" : nodeText(c, [], fns),
  ).join("");
}

function tocText(headings: Heading[]): string {
  if (!headings.length) return "Table des matières\n";
  const lines = headings.map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}- ${h.text}`);
  return `Table des matières\n${lines.join("\n")}\n`;
}

function nodeText(node: ProseMirrorNode, headings: Heading[] = [], fns: { id: string; text: string }[] = []): string {
  switch (node.type) {
    case "doc": return (node.content ?? []).map((c) => nodeText(c, headings, fns)).join("\n");
    case "paragraph": return inlineText(node, fns) + "\n";
    case "heading": return inlineText(node, fns) + "\n";
    case "tableOfContents": return tocText(headings);
    case "footnote": return `[${fnNum(fns, node.attrs?.id) || "?"}]`;
    case "footnotesList": return fns.length ? "\n" + fns.map((f, i) => `[${i + 1}] ${f.text}`).join("\n") + "\n" : "";
    case "bookmark": return "";
    case "bulletList": return (node.content ?? []).map((li) => `- ${nodeText(li, headings, fns).trim()}`).join("\n") + "\n";
    case "orderedList": return (node.content ?? []).map((li, i) => `${i + 1}. ${nodeText(li, headings, fns).trim()}`).join("\n") + "\n";
    case "taskList": return (node.content ?? []).map((li) => `[${li.attrs?.checked ? "x" : " "}] ${nodeText(li, headings, fns).trim()}`).join("\n") + "\n";
    case "listItem": case "taskItem": return inlineText(node, fns);
    case "blockquote": return inlineText(node, fns).split("\n").map((l) => `> ${l}`).join("\n") + "\n";
    case "codeBlock": return (node.content ?? []).map((c) => c.text ?? "").join("") + "\n";
    case "horizontalRule": return "----\n";
    case "pageBreak": return "\f\n";
    case "image": return `[image: ${node.attrs?.alt ?? ""}]\n`;
    case "figure": {
      const cap = inlineText(node, fns).trim();
      return `[image: ${node.attrs?.alt ?? ""}]${cap ? ` — ${cap}` : ""}\n`;
    }
    case "table": return tableMd(node);
    default: return inlineText(node, fns);
  }
}

export function docToText(model: EliumDocumentModel): string {
  return nodeText(model.doc, collectHeadings(model.doc), collectFootnotes(model.doc)).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// --- Signatures appendix --------------------------------------------------

function signaturesHtml(signatures: EliumSignature[], verdicts?: Record<string, SignatureVerdict>): string {
  if (!signatures.length) return "";
  const items = signatures.map((s) => {
    const visual = s.visual.image
      ? `<img class="sig-img" src="${esc(s.visual.image)}" alt="signature">`
      : `<div class="sig-text">${esc(s.visual.text ?? "")}</div>`;
    const meta = [s.signer.name, s.signer.role, s.signer.org, s.signer.date]
      .filter((x): x is string => Boolean(x))
      .map(esc)
      .join(" · ");
    const proof = s.proof
      ? `<div class="sig-proof">Preuve Ed25519 · empreinte ${esc(s.proof.fingerprint.slice(0, 16))}… · ${verdicts?.[s.id] ?? "non vérifiée"}</div>`
      : `<div class="sig-proof muted">Signature visuelle</div>`;
    return `<div class="sig-cell">${visual}<div class="sig-meta">${meta}</div>${proof}</div>`;
  }).join("");
  return `<section class="signatures"><h2>Signatures</h2><div class="sig-grid">${items}</div></section>`;
}

const PRINT_CSS = `
  *{box-sizing:border-box} body{font-family:Inter,system-ui,Arial,sans-serif;color:#0f172a;line-height:1.6;max-width:760px;margin:32px auto;padding:0 24px}
  h1,h2,h3,h4{line-height:1.25} table{border-collapse:collapse;width:100%;margin:12px 0} th,td{border:1px solid #cbd5e1;padding:6px 10px;text-align:left}
  th{background:#f1f5f9} blockquote{border-left:3px solid #cbd5e1;margin:12px 0;padding:4px 16px;color:#475569}
  pre{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:8px;overflow:auto} code{font-family:'Courier New',monospace}
  img{max-width:100%} mark{background:#fef08a} hr{border:none;border-top:1px solid #cbd5e1;margin:18px 0}
  .signatures{margin-top:48px;border-top:2px solid #e2e8f0;padding-top:16px;page-break-inside:avoid}
  .sig-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
  .sig-cell{border:1px solid #e2e8f0;border-radius:10px;padding:12px} .sig-img{max-height:90px} .sig-text{font-size:24px;font-family:'Brush Script MT',cursive}
  .sig-meta{font-size:12px;color:#475569;margin-top:6px} .sig-proof{font-size:11px;color:#16a34a;margin-top:4px} .muted{color:#94a3b8}
  .task-list{list-style:none;padding-left:18px}
  .elium-page-break{page-break-after:always;break-after:page;height:0;border:0}
  .elium-toc{border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin:18px 0;background:#f8fafc;page-break-inside:avoid}
  .elium-toc__title{font-weight:700;margin-bottom:8px}
  .elium-toc__list{list-style:none;margin:0;padding:0}
  .elium-toc__item{margin:3px 0} .elium-toc__item a{color:#1d4ed8;text-decoration:none}
  .elium-toc__item--h2{padding-left:18px} .elium-toc__item--h3{padding-left:36px;font-size:.95em}
  .elium-figure{margin:14px 0;max-width:100%} .elium-figure img{max-width:100%;border-radius:6px}
  .elium-figure figcaption{font-size:13px;color:#64748b;margin-top:6px;font-style:italic}
  .elium-figure--center{text-align:center} .elium-figure--center figcaption{text-align:center}
  .elium-figure--left{float:left;margin:6px 18px 10px 0;max-width:48%}
  .elium-figure--right{float:right;margin:6px 0 10px 18px;max-width:48%}
  .elium-footnotes{margin-top:32px;font-size:13px;color:#475569;page-break-inside:avoid}
  .elium-footnotes ol{padding-left:20px;margin:8px 0} .elium-footnotes li{margin:3px 0}
  .elium-fn-ref{font-weight:600} .elium-fn-ref a{color:#1d4ed8;text-decoration:none} .elium-fn-back{text-decoration:none;color:#94a3b8}
`;

/** A CSS string literal (escaped) for use in @page margin boxes. */
function cssStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;
}
function expandTokens(tpl: string, title: string): string {
  return tpl.replace(/\{titre\}/gi, title).replace(/\{date\}/gi, new Date().toLocaleDateString("fr-FR"));
}

/** @page rules honouring the document's page setup (format/orientation/margins,
 *  header & footer tokens, page numbers). Degrades gracefully if the print
 *  engine ignores margin boxes. */
function pageCss(file: EliumFile): string {
  const page = file.document.page;
  if (!page) return "";
  const title = file.manifest.title;
  const size = page.format === "Letter" ? "letter" : "A4";
  const m = page.margins ?? { top: 20, right: 20, bottom: 20, left: 20 };
  const boxes: string[] = [];
  if (page.header) boxes.push(`@top-center{content:${cssStr(expandTokens(page.header, title))};font-size:9pt;color:#64748b}`);
  if (page.footer) boxes.push(`@bottom-center{content:${cssStr(expandTokens(page.footer, title))};font-size:9pt;color:#64748b}`);
  if (page.showPageNumbers) boxes.push(`@bottom-right{content:"Page " counter(page) " / " counter(pages);font-size:9pt;color:#64748b}`);
  return `@page{size:${size} ${page.orientation === "landscape" ? "landscape" : "portrait"};margin:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;${boxes.join("")}}
@media print{body{max-width:none;margin:0;padding:0}}`;
}

export function buildStandaloneHtml(file: EliumFile, verdicts?: Record<string, SignatureVerdict>): string {
  return `<!doctype html><html lang="${esc(file.manifest.language)}"><head><meta charset="utf-8">
<title>${esc(file.manifest.title)}</title><style>${PRINT_CSS}${pageCss(file)}</style></head>
<body><h1>${esc(file.manifest.title)}</h1>${docToHtml(file.document)}${signaturesHtml(file.signatures, verdicts)}</body></html>`;
}

// --- Download / print helpers --------------------------------------------

export function downloadBlob(filename: string, mime: string, data: string | Uint8Array): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportHtml(file: EliumFile, verdicts?: Record<string, SignatureVerdict>): void {
  downloadBlob(`${file.manifest.title || "document"}.html`, "text/html;charset=utf-8", buildStandaloneHtml(file, verdicts));
}

export function exportMarkdown(file: EliumFile): void {
  downloadBlob(`${file.manifest.title || "document"}.md`, "text/markdown;charset=utf-8", docToMarkdown(file.document));
}

export function exportText(file: EliumFile): void {
  downloadBlob(`${file.manifest.title || "document"}.txt`, "text/plain;charset=utf-8", docToText(file.document));
}

export function exportPdf(file: EliumFile, verdicts?: Record<string, SignatureVerdict>): void {
  // Open from a Blob URL (opaque origin) rather than document.write into an
  // about:blank window: the print preview can no longer inherit the app origin
  // or reach its localStorage, even if the document contained active content.
  const html = buildStandaloneHtml(file, verdicts);
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const win = window.open(url, "_blank");
  if (!win) {
    URL.revokeObjectURL(url);
    window.alert("Veuillez autoriser les fenêtres contextuelles pour exporter en PDF.");
    return;
  }
  win.addEventListener("load", () => {
    win.focus();
    win.print();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}

export async function buildProofReport(
  file: EliumFile,
  verdicts: Record<string, SignatureVerdict>,
): Promise<Record<string, unknown>> {
  const journalVerdict = await verifyJournal(file.journal);
  return {
    report: "elium-proof-report",
    version: 1,
    document: { title: file.manifest.title, profile: file.manifest.profile, modifiedAt: file.manifest.modifiedAt },
    integrity: { algorithm: file.manifest.integrity.algorithm, contentHash: file.manifest.integrity.contentHash },
    journal: { ...journalVerdict },
    signatures: file.signatures.map((s) => ({
      id: s.id,
      kind: s.kind,
      level: s.level,
      signer: s.signer,
      verdict: verdicts[s.id] ?? "visual_only",
      proof: s.proof
        ? { alg: s.proof.alg, fingerprint: s.proof.fingerprint, signedAt: s.proof.signedAt, signedContentHash: s.proof.signedContentHash }
        : null,
    })),
    notice: "Une signature visuelle n'est pas une signature électronique qualifiée (eIDAS).",
  };
}

export async function exportProofReport(file: EliumFile, verdicts: Record<string, SignatureVerdict>): Promise<void> {
  const report = await buildProofReport(file, verdicts);
  downloadBlob(`${file.manifest.title || "document"}-preuve.json`, "application/json", JSON.stringify(report, null, 2));
}
