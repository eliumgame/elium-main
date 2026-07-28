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
import { markerText, schemeById, schemesCss, type ListScheme } from "../editor/listSchemes";
import { buildIndexJson, type IndexGroup } from "../editor/indexing";
import { collectTargetsJson, referenceLabel, type RefDisplay, type RefTarget } from "../editor/crossref";
import { sectionBreakLabelFor } from "../editor/sections";
import { pageSizeOf } from "../format/pageSizes";
import { fontFaceCss, fontResources } from "../format/embedded-fonts";
import {
  buildFigureTable, captionPrefix, collectCaptionsJson, figureTableTitle, type CaptionEntry,
} from "../editor/captions";
import { NOTE_TITLES, collectNotesJson, type NoteEntry, type NoteKind } from "../editor/notes";
import { clampDropLines, watermarkCss } from "../editor/ornaments";
import { normalizeGeometry, normalizeStyle, textBoxCss } from "../editor/textBox";
import {
  fitCss, isBandedColumn, rowClasses, tableStyleById, tableStylesCss,
} from "../editor/tableStyles";

/** base64 of raw bytes, in browser and Node alike (for inlined font data URLs). */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

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
 * `toc-h-{n}` — or its own renvoi anchor when one was stamped, so a
 * cross-reference and the TOC point at the same element. The HTML heading
 * renderer uses the same H1–H3 counter, so the anchors line up.
 */
function collectHeadings(doc: ProseMirrorNode): Heading[] {
  const out: Heading[] = [];
  const walk = (node: ProseMirrorNode) => {
    if (node.type === "heading") {
      const level = Number(node.attrs?.level ?? 1);
      if (level <= 3) {
        const text = (node.content ?? []).map((c) => c.text ?? "").join("").trim();
        const refId = String(node.attrs?.refId ?? "");
        out.push({ level, text: text || "Sans titre", slug: refId || `toc-h-${out.length}` });
      }
    }
    (node.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}

// --- Index ----------------------------------------------------------------

function indexHtml(groups: IndexGroup[]): string {
  if (!groups.length) return "";
  const body = groups
    .map((g) => {
      const entries = g.entries
        .map((e) => {
          const pages = e.pages.length ? `<span class="elium-index__pages">${esc(e.pages.join(", "))}</span>` : "";
          const subs = e.subs.length
            ? `<ul class="elium-index__sublist">${e.subs
                .map(
                  (s) =>
                    `<li>${esc(s.term)}${s.pages.length ? ` <span class="elium-index__pages">${esc(s.pages.join(", "))}</span>` : ""}</li>`,
                )
                .join("")}</ul>`
            : "";
          return `<li>${esc(e.term)} ${pages}${subs}</li>`;
        })
        .join("");
      return `<div class="elium-index__letter">${esc(g.letter)}</div><ul class="elium-index__list">${entries}</ul>`;
    })
    .join("");
  return `<section class="elium-index"><h2 class="elium-index__title">Index</h2>${body}</section>`;
}

function indexText(groups: IndexGroup[]): string {
  if (!groups.length) return "Index\n";
  const lines: string[] = ["Index"];
  for (const g of groups) {
    lines.push("", g.letter);
    for (const e of g.entries) {
      lines.push(`  ${e.term}${e.pages.length ? `  ${e.pages.join(", ")}` : ""}`);
      for (const s of e.subs) lines.push(`    ${s.term}${s.pages.length ? `  ${s.pages.join(", ")}` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

// --- Cross-references -----------------------------------------------------

/** Resolved text of a renvoi, from the live document (never a stale cache). */
function xrefText(node: ProseMirrorNode, targets: RefTarget[]): string {
  const anchor = String(node.attrs?.targetId ?? "");
  const target = targets.find((t) => t.anchorId === anchor);
  if (!target) return String(node.attrs?.cached ?? "") || "renvoi introuvable";
  const display = (String(node.attrs?.display ?? "text") || "text") as RefDisplay;
  // No layout engine here, so a page-number renvoi keeps the page Elium's own
  // pagination computed when it was inserted.
  if (display === "page" || display === "full") return String(node.attrs?.cached ?? "") || referenceLabel(target, display, null);
  return referenceLabel(target, display, null);
}

/**
 * La note désignée par un identifiant, dans la famille donnée.
 *
 * La numérotation vient de `collectNotesJson`, comme à l'écran et comme à
 * l'export DOCX : une quatrième implémentation locale finirait par afficher un
 * marqueur différent de celui que l'auteur a sous les yeux.
 */
const noteOf = (notes: NoteEntry[], id: unknown): NoteEntry | null =>
  notes.find((n) => n.id === String(id)) ?? null;

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
  footnotes: NoteEntry[];
  endnotes: NoteEntry[];
  targets: RefTarget[];
  index: IndexGroup[];
  captions: CaptionEntry[];
  /** Multilevel scheme inherited from the enclosing list, and its depth. */
  listScheme: ListScheme | null;
  listDepth: number;
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
      case "superscript": html = `<sup>${html}</sup>`; break;
      case "subscript": html = `<sub>${html}</sub>`; break;
      case "textStyle": {
        const a = mark.attrs ?? {};
        // Underline/strike decoration styles are combined into one declaration:
        // `text-decoration-line` cannot be set twice in the same rule.
        const lines = [
          a.underlineStyle && a.underlineStyle !== "none" ? "underline" : "",
          a.doubleStrike ? "line-through" : "",
        ].filter(Boolean);
        const decoStyle = a.doubleStrike
          ? "double"
          : a.underlineStyle && a.underlineStyle !== "none" && a.underlineStyle !== "single"
            ? String(a.underlineStyle)
            : "";
        const style = [
          a.color ? `color:${safeCss(String(a.color))}` : "",
          a.fontFamily ? `font-family:${safeCss(String(a.fontFamily))}` : "",
          a.fontSize ? `font-size:${safeCss(String(a.fontSize))}` : "",
          a.smallCaps ? "font-variant-caps:small-caps" : "",
          a.allCaps ? "text-transform:uppercase" : "",
          a.letterSpacing ? `letter-spacing:${safeCss(String(a.letterSpacing))}` : "",
          a.textPosition ? `vertical-align:${safeCss(String(a.textPosition))}` : "",
          lines.length ? `text-decoration-line:${lines.join(" ")}` : "",
          decoStyle ? `text-decoration-style:${decoStyle}` : "",
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

/** `id`/anchor attribute for a renvoi target (heading, figure, table). */
function refIdAttr(node: ProseMirrorNode): string {
  const refId = String(node.attrs?.refId ?? "");
  return refId ? ` id="${esc(refId)}"` : "";
}

function blockHtml(node: ProseMirrorNode, ctx: HtmlCtx): string {
  const kids = (node.content ?? []).map((c) => nodeHtml(c, ctx)).join("");
  switch (node.type) {
    case "doc": return kids;
    case "textBox": {
      // Le style vient du MÊME générateur que l'écran : deux feuilles séparées
      // finiraient par placer la zone à deux endroits différents.
      const g = normalizeGeometry(node.attrs);
      const st = normalizeStyle(node.attrs);
      return `<div class="elium-textbox elium-textbox--${g.wrap}" style="${esc(textBoxCss(g, st))}">${kids}</div>`;
    }
    case "paragraph": {
      // La lettrine passe par un attribut et une variable CSS : `::first-letter`
      // ne peut pas être stylé en ligne, donc la règle vit dans la feuille.
      const drop = node.attrs?.dropCap;
      const dropAttr =
        drop === "drop" || drop === "margin"
          ? ` data-drop-cap="${drop}" style="--elium-dropcap:${(clampDropLines(node.attrs?.dropCapLines) * 1.5).toFixed(2)}em"`
          : "";
      return `<p${dropAttr}${blockStyle(node)}>${kids || "<br>"}</p>`;
    }
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      const slug = level <= 3 ? ctx.headings[ctx.hi++]?.slug ?? "" : String(node.attrs?.refId ?? "");
      const id = slug ? ` id="${esc(slug)}"` : "";
      return `<h${level}${id}${blockStyle(node)}>${kids}</h${level}>`;
    }
    case "tableOfContents": return tocHtml(ctx.headings);
    case "footnote":
    case "endnote": {
      const kind: NoteKind = node.type;
      const entry = noteOf(kind === "endnote" ? ctx.endnotes : ctx.footnotes, node.attrs?.id);
      if (!entry) return "";
      const p = kind === "endnote" ? "en" : "fn";
      const cls = kind === "endnote" ? "elium-en-ref" : "elium-fn-ref";
      return `<sup class="${cls}" id="${p}ref-${entry.number}">` +
        `<a href="#${p}-${entry.number}">${esc(entry.marker)}</a></sup>`;
    }
    case "footnotesList":
    case "endnotesList": {
      const kind: NoteKind = node.type === "endnotesList" ? "endnote" : "footnote";
      const notes = kind === "endnote" ? ctx.endnotes : ctx.footnotes;
      if (!notes.length) return "";
      const p = kind === "endnote" ? "en" : "fn";
      const cls = kind === "endnote" ? "elium-endnotes" : "elium-footnotes";
      // Le marqueur est écrit à la main : aucune valeur de `list-style` ne rend
      // des romains minuscules suivis du texte comme le fait Word.
      const items = notes
        .map((n) => `<li id="${p}-${n.number}" value="${n.number}">` +
          `<span class="${cls}__mark">${esc(n.marker)}</span> ${esc(n.text)} ` +
          `<a class="elium-fn-back" href="#${p}ref-${n.number}">↩</a></li>`)
        .join("");
      return `<section class="${cls}"><hr><div class="${cls}__title">${esc(NOTE_TITLES[kind])}</div>` +
        `<ol class="${cls}__list">${items}</ol></section>`;
    }
    case "bookmark": return `<a id="${esc(String(node.attrs?.id ?? ""))}" class="elium-bookmark"></a>`;
    case "crossReference": {
      const anchor = esc(String(node.attrs?.targetId ?? ""));
      return `<a class="elium-xref" href="#${anchor}">${esc(xrefText(node, ctx.targets))}</a>`;
    }
    // Index marks never print (Word's XE fields do not either).
    case "indexEntry": return "";
    case "indexBlock": return indexHtml(ctx.index);
    case "caption": {
      // The number is derived, so it is rendered here rather than stored.
      const label = String(node.attrs?.label ?? "Figure");
      const text = (node.content ?? []).map((c) => c.text ?? "").join("").replace(/\s+/g, " ").trim();
      const entry = ctx.captions.find((c) => c.label === label && c.text === text);
      const id = node.attrs?.refId ? ` id="${esc(String(node.attrs.refId))}"` : "";
      return `<p class="elium-caption"${id}><span class="elium-caption__prefix">${esc(captionPrefix(label, entry?.number ?? 1))}</span>${kids}</p>`;
    }
    case "tableOfFigures": {
      const label = String(node.attrs?.label ?? "");
      const rows = buildFigureTable(ctx.captions, label || null, null);
      const title = figureTableTitle(label);
      if (!rows.length) return "";
      const items = rows
        .map((r) => `<li>${esc(`${captionPrefix(r.label, r.number)}${r.text}`)}</li>`)
        .join("");
      return `<nav class="elium-figtable"><div class="elium-figtable__title">${esc(title)}</div><ol>${items}</ol></nav>`;
    }
    case "pageBreak": return '<div class="elium-page-break" style="page-break-after:always"></div>';
    case "sectionBreak": {
      // A section boundary that starts a page is a page break in the exported
      // flow; a continuous one changes nothing visually.
      const kind = String(node.attrs?.kind ?? "nextPage");
      if (kind === "continuous") return "";
      return `<div class="elium-page-break" style="page-break-after:always" data-section-break="${esc(kind)}"></div>`;
    }
    case "columnSection": {
      const count = Math.max(1, Math.min(4, Math.round(Number(node.attrs?.count) || 2)));
      const gap = Number(node.attrs?.gapMm) || 8;
      const rule = node.attrs?.separator ? ";column-rule:1px solid #cbd5e1" : "";
      return `<div class="elium-columns" style="column-count:${count};column-gap:${gap}mm${rule}">${kids}</div>`;
    }
    case "mergeField": return `<span class="elium-mergefield">«${esc(String(node.attrs?.field ?? ""))}»</span>`;
    case "bulletList":
    case "orderedList": {
      // The scheme lives on the outermost list and is inherited downwards, the
      // same rule the generated CSS applies, so screen and export agree.
      const kind = node.type === "bulletList" ? "bullet" : "ordered";
      const declared = schemeById(node.attrs?.listScheme) ?? ctx.listScheme;
      const scheme = declared && declared.kind === kind ? declared : null;
      const prevScheme = ctx.listScheme;
      const prevDepth = ctx.listDepth;
      ctx.listScheme = declared;
      ctx.listDepth = prevScheme ? prevDepth + 1 : 0;
      const inner = (node.content ?? []).map((c) => nodeHtml(c, ctx)).join("");
      ctx.listScheme = prevScheme;
      ctx.listDepth = prevDepth;
      const attr = scheme ? ` data-list-scheme="${esc(scheme.id)}"` : "";
      const tag = kind === "bullet" ? "ul" : "ol";
      const start = kind === "ordered" && Number(node.attrs?.start) > 1 ? ` start="${Number(node.attrs?.start)}"` : "";
      return `<${tag}${attr}${start}>${inner}</${tag}>`;
    }
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
      return `<figure class="elium-figure elium-figure--${align}"${style}${refIdAttr(node)}>${img}${cap}</figure>`;
    }
    case "table": {
      // Le style ET les trames sortent ici : à l'écran les bandes sont des
      // décorations calculées, mais un HTML exporté n'a pas de plugin pour les
      // recalculer — les classes doivent donc être écrites.
      const style = tableStyleById(node.attrs?.tableStyle);
      const fit = fitCss(node.attrs?.tableFit);
      const rows = node.content ?? [];
      const hasHeader = ((rows[0]?.content ?? [])[0]?.type ?? "") === "tableHeader";
      const bodyHtml = rows
        .map((row, i) => {
          const cls = rowClasses(style, i, hasHeader);
          const cells = (row.content ?? [])
            .map((cell, j) => {
              const tag = cell.type === "tableHeader" ? "th" : "td";
              const span = Number(cell.attrs?.colspan ?? 1);
              const v = String(cell.attrs?.vAlign ?? "top");
              const attrs =
                (span > 1 ? ` colspan="${span}"` : "") +
                (v !== "top" ? ` data-valign="${esc(v)}"` : "") +
                (isBandedColumn(style, j) ? ' class="is-banded-col"' : "");
              return `<${tag}${attrs}>${(cell.content ?? []).map((c) => blockHtml(c, ctx)).join("")}</${tag}>`;
            })
            .join("");
          return `<tr${cls.length ? ` class="${cls.join(" ")}"` : ""}>${cells}</tr>`;
        })
        .join("");
      const styleAttr = fit ? ` style="${esc(fit)}"` : "";
      return `<table${refIdAttr(node)} data-table-style="${style.id}"${styleAttr}>${bodyHtml}</table>`;
    }
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
  return blockHtml(model.doc, {
    headings: collectHeadings(model.doc),
    hi: 0,
    footnotes: collectNotesJson(model.doc, "footnote"),
    endnotes: collectNotesJson(model.doc, "endnote"),
    targets: collectTargetsJson(model.doc),
    index: buildIndexJson(model.doc),
    captions: collectCaptionsJson(model.doc),
    listScheme: null,
    listDepth: 0,
  });
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

interface FlatCtx {
  headings: Heading[];
  fns: NoteEntry[];
  ens: NoteEntry[];
  targets: RefTarget[];
  index: IndexGroup[];
  captions: CaptionEntry[];
  /** Multilevel scheme inherited from the enclosing list. */
  scheme: ListScheme | null;
  /** 1-based counter stack of the enclosing lists, for `1.2.3` markers. */
  counters: number[];
}

const emptyFlatCtx = (doc: ProseMirrorNode): FlatCtx => ({
  headings: collectHeadings(doc),
  fns: collectNotesJson(doc, "footnote"),
  ens: collectNotesJson(doc, "endnote"),
  targets: collectTargetsJson(doc),
  index: buildIndexJson(doc),
  captions: collectCaptionsJson(doc),
  scheme: null,
  counters: [],
});

/**
 * Markers for a Markdown/text list. With a multilevel scheme the real marker is
 * rendered ("1.1", "Article II."); without one, Markdown's own conventions are
 * kept so the output stays valid Markdown.
 */
function listMarkers(node: ProseMirrorNode, ctx: FlatCtx): { markerAt: (i: number) => string; scheme: ListScheme | null } {
  const kind = node.type === "bulletList" ? "bullet" : "ordered";
  const declared = schemeById(node.attrs?.listScheme) ?? ctx.scheme;
  const scheme = declared && declared.kind === kind ? declared : null;
  const depth = ctx.counters.length;
  const start = Math.max(1, Number(node.attrs?.start) || 1);
  const markerAt = (i: number): string => {
    const n = start + i;
    if (!scheme) return kind === "bullet" ? "-" : `${n}.`;
    return markerText(scheme, depth, [...ctx.counters, n]);
  };
  return { markerAt, scheme: declared };
}

function listMd(node: ProseMirrorNode, ctx: FlatCtx): string {
  const { markerAt, scheme } = listMarkers(node, ctx);
  const depth = ctx.counters.length;
  const start = Math.max(1, Number(node.attrs?.start) || 1);
  const lines = (node.content ?? []).map((li, i) => {
    const inner = nodeMd(li, { ...ctx, scheme, counters: [...ctx.counters, start + i] }).trim();
    return `${"  ".repeat(depth)}${markerAt(i)} ${inner}`;
  });
  return lines.join("\n") + "\n";
}

/** Table of figures for the Markdown / plain-text exporters. */
function figureTableFlat(node: ProseMirrorNode, ctx: FlatCtx, markdown: boolean): string {
  const label = String(node.attrs?.label ?? "");
  const rows = buildFigureTable(ctx.captions, label || null, null);
  const title = figureTableTitle(label);
  if (!rows.length) return "";
  const lines = rows.map((r) => `${markdown ? "- " : "  "}${captionPrefix(r.label, r.number)}${r.text}`);
  return `${markdown ? "## " : ""}${title}\n${lines.join("\n")}\n`;
}

function nodeMd(node: ProseMirrorNode, ctx: FlatCtx): string {
  const inline = (n: ProseMirrorNode) =>
    (n.content ?? []).map((c) => (c.type === "text" || c.type === "hardBreak" ? inlineMd(c) : nodeMd(c, ctx))).join("");
  switch (node.type) {
    case "doc": return (node.content ?? []).map((c) => nodeMd(c, ctx)).join("\n");
    case "paragraph": return inline(node) + "\n";
    case "heading": return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${inline(node)}\n`;
    case "tableOfContents": return tocMd(ctx.headings);
    case "footnote":
    case "endnote": {
      // Markdown n'a qu'une syntaxe de note : les notes de fin sont préfixées
      // pour que les deux familles ne se télescopent pas dans le même espace de
      // noms (`[^1]` d'un côté, `[^en-i]` de l'autre).
      const kind: NoteKind = node.type;
      const entry = noteOf(kind === "endnote" ? ctx.ens : ctx.fns, node.attrs?.id);
      if (!entry) return "";
      return `[^${kind === "endnote" ? `en-${entry.marker}` : entry.marker}]`;
    }
    case "footnotesList":
    case "endnotesList": {
      const kind: NoteKind = node.type === "endnotesList" ? "endnote" : "footnote";
      const notes = kind === "endnote" ? ctx.ens : ctx.fns;
      if (!notes.length) return "";
      const key = (n: NoteEntry) => (kind === "endnote" ? `en-${n.marker}` : n.marker);
      return `\n### ${NOTE_TITLES[kind]}\n` + notes.map((n) => `[^${key(n)}]: ${n.text}`).join("\n") + "\n";
    }
    case "bookmark": return "";
    case "crossReference": return `[${xrefText(node, ctx.targets)}](#${String(node.attrs?.targetId ?? "")})`;
    case "indexEntry": return "";
    case "indexBlock": return `## ${indexText(ctx.index).replace(/^Index\n/, "Index\n\n")}`;
    case "caption": {
      // The number is derived from document order, never stored.
      const label = String(node.attrs?.label ?? "Figure");
      const text = inline(node).trim();
      const entry = ctx.captions.find((c) => c.label === label && c.text === text.replace(/\s+/g, " ").trim());
      return `*${captionPrefix(label, entry?.number ?? 1)}${text}*\n`;
    }
    case "tableOfFigures": return figureTableFlat(node, ctx, true);
    case "mergeField": return `«${String(node.attrs?.field ?? "")}»`;
    case "bulletList":
    case "orderedList": return listMd(node, ctx);
    case "listItem": case "taskItem": return inline(node);
    case "taskList": return (node.content ?? []).map((li) => `- [${li.attrs?.checked ? "x" : " "}] ${nodeMd(li, ctx).trim()}`).join("\n") + "\n";
    case "blockquote": return inline(node).split("\n").map((l) => `> ${l}`).join("\n") + "\n";
    case "codeBlock": return "```" + (node.attrs?.language ?? "") + "\n" + (node.content ?? []).map((c) => c.text ?? "").join("") + "\n```\n";
    case "horizontalRule": return "---\n";
    case "pageBreak": return "\n";
    case "sectionBreak": return "\n---\n";
    case "columnSection": return (node.content ?? []).map((c) => nodeMd(c, ctx)).join("\n");
    case "image": return `![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})\n`;
    case "figure": {
      const cap = inline(node).trim();
      return `![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})\n${cap ? `*${cap}*\n` : ""}`;
    }
    case "table": return tableMd(node, ctx);
    default: return inline(node);
  }
}

function tableMd(table: ProseMirrorNode, ctx: FlatCtx): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => (cell.content ?? []).map((c) => nodeMd(c, ctx).trim()).join(" ")),
  );
  if (!rows.length) return "";
  const head = rows[0];
  const sep = head.map(() => "---");
  const body = rows.slice(1);
  const fmt = (r: string[]) => `| ${r.join(" | ")} |`;
  return [fmt(head), fmt(sep), ...body.map(fmt)].join("\n") + "\n";
}

export function docToMarkdown(model: EliumDocumentModel): string {
  return nodeMd(model.doc, emptyFlatCtx(model.doc)).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// --- Plain text -----------------------------------------------------------

function inlineText(node: ProseMirrorNode, ctx: FlatCtx): string {
  return (node.content ?? []).map((c) =>
    c.type === "text" ? c.text ?? "" : c.type === "hardBreak" ? "\n" : nodeText(c, ctx),
  ).join("");
}

function tocText(headings: Heading[]): string {
  if (!headings.length) return "Table des matières\n";
  const lines = headings.map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}- ${h.text}`);
  return `Table des matières\n${lines.join("\n")}\n`;
}

function listText(node: ProseMirrorNode, ctx: FlatCtx): string {
  const { markerAt, scheme } = listMarkers(node, ctx);
  const depth = ctx.counters.length;
  const start = Math.max(1, Number(node.attrs?.start) || 1);
  return (
    (node.content ?? [])
      .map((li, i) => {
        const inner = nodeText(li, { ...ctx, scheme, counters: [...ctx.counters, start + i] }).trim();
        return `${"  ".repeat(depth)}${markerAt(i)} ${inner}`;
      })
      .join("\n") + "\n"
  );
}

function nodeText(node: ProseMirrorNode, ctx: FlatCtx): string {
  switch (node.type) {
    case "doc": return (node.content ?? []).map((c) => nodeText(c, ctx)).join("\n");
    case "paragraph": return inlineText(node, ctx) + "\n";
    case "heading": return inlineText(node, ctx) + "\n";
    case "tableOfContents": return tocText(ctx.headings);
    case "footnote":
    case "endnote": {
      const kind: NoteKind = node.type;
      const entry = noteOf(kind === "endnote" ? ctx.ens : ctx.fns, node.attrs?.id);
      return entry ? `[${entry.marker}]` : "";
    }
    case "footnotesList":
    case "endnotesList": {
      const kind: NoteKind = node.type === "endnotesList" ? "endnote" : "footnote";
      const notes = kind === "endnote" ? ctx.ens : ctx.fns;
      if (!notes.length) return "";
      return `\n${NOTE_TITLES[kind]}\n` + notes.map((n) => `[${n.marker}] ${n.text}`).join("\n") + "\n";
    }
    case "bookmark": return "";
    case "crossReference": return xrefText(node, ctx.targets);
    case "indexEntry": return "";
    case "indexBlock": return indexText(ctx.index);
    case "caption": {
      const label = String(node.attrs?.label ?? "Figure");
      const text = inlineText(node, ctx).trim();
      const entry = ctx.captions.find((c) => c.label === label && c.text === text.replace(/\s+/g, " ").trim());
      return `${captionPrefix(label, entry?.number ?? 1)}${text}\n`;
    }
    case "tableOfFigures": return figureTableFlat(node, ctx, false);
    case "mergeField": return `«${String(node.attrs?.field ?? "")}»`;
    case "bulletList":
    case "orderedList": return listText(node, ctx);
    case "taskList": return (node.content ?? []).map((li) => `[${li.attrs?.checked ? "x" : " "}] ${nodeText(li, ctx).trim()}`).join("\n") + "\n";
    case "listItem": case "taskItem": return inlineText(node, ctx);
    case "blockquote": return inlineText(node, ctx).split("\n").map((l) => `> ${l}`).join("\n") + "\n";
    case "codeBlock": return (node.content ?? []).map((c) => c.text ?? "").join("") + "\n";
    case "horizontalRule": return "----\n";
    case "pageBreak": return "\f\n";
    case "sectionBreak": return `\n— ${sectionBreakLabelFor(node.attrs?.kind)} —\n`;
    case "columnSection": return (node.content ?? []).map((c) => nodeText(c, ctx)).join("");
    case "image": return `[image: ${node.attrs?.alt ?? ""}]\n`;
    case "figure": {
      const cap = inlineText(node, ctx).trim();
      return `[image: ${node.attrs?.alt ?? ""}]${cap ? ` — ${cap}` : ""}\n`;
    }
    case "table": return tableMd(node, ctx);
    default: return inlineText(node, ctx);
  }
}

export function docToText(model: EliumDocumentModel): string {
  return nodeText(model.doc, emptyFlatCtx(model.doc)).replace(/\n{3,}/g, "\n\n").trim() + "\n";
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
  *{box-sizing:border-box} body{font-family:Inter,system-ui,Arial,sans-serif;color:#0f172a;line-height:1.6;max-width:760px;margin:32px auto;padding:0 24px;background-repeat:repeat-y;background-position:top center}
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
  /* list-style:none — le marqueur est écrit à la main (romains minuscules pour
     les notes de fin) ; la puce du navigateur ferait un double numéro. */
  .elium-footnotes ol{padding-left:20px;margin:8px 0;list-style:none} .elium-footnotes li{margin:3px 0}
  .elium-endnotes{margin-top:32px;font-size:13px;color:#475569;page-break-before:always}
  .elium-endnotes__title,.elium-footnotes__title{font-weight:700;color:#0f172a;margin:8px 0 4px}
  .elium-endnotes__list{padding-left:20px;margin:8px 0;list-style:none}
  .elium-endnotes__list li{margin:3px 0}
  .elium-endnotes__mark,.elium-footnotes__mark{font-weight:600;color:#1d4ed8;margin-right:4px}
  /* Lettrine : ::first-letter ne peut pas être stylé en ligne, d'où la règle
     ici et la taille passée en variable CSS par le paragraphe. */
  p[data-drop-cap]::first-letter{float:left;font-size:var(--elium-dropcap,4.5em);
    line-height:1;padding-right:.06em;margin-top:.05em;margin-bottom:-.08em;font-weight:600}
  p[data-drop-cap="margin"]::first-letter{margin-left:-.7em}
  .elium-fn-ref{font-weight:600} .elium-fn-ref a{color:#1d4ed8;text-decoration:none} .elium-fn-back{text-decoration:none;color:#94a3b8}
  .elium-columns{margin:14px 0}
  .elium-columns > *{break-inside:avoid-column}
  .elium-xref{color:#1d4ed8;text-decoration:none}
  .elium-mergefield{white-space:nowrap}
  .elium-index{margin-top:32px;page-break-inside:auto}
  .elium-index__title{font-size:1.2em;margin-bottom:8px}
  .elium-index__letter{margin-top:12px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.06em;font-size:.85em}
  .elium-index__list,.elium-index__sublist{list-style:none;margin:0;padding:0}
  .elium-index__sublist{padding-left:16px}
  .elium-index__list li{margin:2px 0}
  .elium-index__pages{color:#64748b;font-size:.9em}
`;

/**
 * Multilevel-list rules, generated from the SAME scheme table the editor uses
 * (`listSchemes.ts`), so an exported document numbers its lists exactly as the
 * screen did. Scoped to bare `ol`/`ul` because the export has no `.elium-prose`
 * wrapper.
 */
const LIST_SCHEME_CSS = schemesCss("") + tableStylesCss("");

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
  // Explicit millimetres rather than a named keyword: `size: A4` cannot express
  // A5, Legal, Tabloid or a custom sheet, and the orientation is already baked
  // into the width/height pair.
  const { width: pw, height: ph } = pageSizeOf(page);
  const size = `${pw}mm ${ph}mm`;
  const m = page.margins ?? { top: 20, right: 20, bottom: 20, left: 20 };
  const boxes: string[] = [];
  if (page.header) boxes.push(`@top-center{content:${cssStr(expandTokens(page.header, title))};font-size:9pt;color:#64748b}`);
  if (page.footer) boxes.push(`@bottom-center{content:${cssStr(expandTokens(page.footer, title))};font-size:9pt;color:#64748b}`);
  if (page.showPageNumbers) boxes.push(`@bottom-right{content:"Page " counter(page) " / " counter(pages);font-size:9pt;color:#64748b}`);
  return `@page{size:${size} ${page.orientation === "landscape" ? "landscape" : "portrait"};margin:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;${boxes.join("")}}
@media print{body{max-width:none;margin:0;padding:0}}`;
}

/**
 * `@font-face` rules for the typefaces the document carries, inlined as data
 * URLs. Without them an exported HTML/PDF falls back to a system font on any
 * machine that lacks the original — the whole point of embedding.
 */
function embeddedFontCss(file: EliumFile): string {
  const fonts = fontResources(file.resourceIndex)
    .map((meta) => {
      const bytes = file.resources.get(meta.id);
      return bytes ? { family: meta.family, ext: meta.ext, base64: bytesToBase64(bytes) } : null;
    })
    .filter((f): f is { family: string; ext: string; base64: string } => f !== null);
  return fonts.length ? fontFaceCss(fonts) : "";
}

export function buildStandaloneHtml(file: EliumFile, verdicts?: Record<string, SignatureVerdict>): string {
  // Le filigrane est un fond de page : il s'imprime, ne se sélectionne pas et
  // n'entre pas dans le flux — trois propriétés qu'un élément n'aurait pas.
  const size = pageSizeOf(file.document.page);
  const mark = watermarkCss(file.document.watermark as never, size.width, size.height);
  const markCss = mark ? `body{background-image:${mark}}` : "";
  return `<!doctype html><html lang="${esc(file.manifest.language)}"><head><meta charset="utf-8">
<title>${esc(file.manifest.title)}</title><style>${embeddedFontCss(file)}${PRINT_CSS}${LIST_SCHEME_CSS}${pageCss(file)}${markCss}</style></head>
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
