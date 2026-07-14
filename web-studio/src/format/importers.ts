/**
 * Importers: plain text, Markdown and HTML → ProseMirror document node.
 *
 * Kept dependency-free. Markdown covers the common block + inline constructs;
 * HTML uses the browser DOMParser (falls back to a tag-strip when unavailable).
 */
import type { ProseMirrorNode } from "./types";

type Mark = NonNullable<ProseMirrorNode["marks"]>[number];

const t = (text: string, marks?: Mark[]): ProseMirrorNode => (marks?.length ? { type: "text", text, marks } : { type: "text", text });
const para = (children: ProseMirrorNode[]): ProseMirrorNode => (children.length ? { type: "paragraph", content: children } : { type: "paragraph" });
const wrapDoc = (content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content: content.length ? content : [{ type: "paragraph" }] });

// --- Plain text -----------------------------------------------------------

export function textToDoc(input: string): ProseMirrorNode {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  return wrapDoc(lines.map((l) => (l ? para([t(l)]) : { type: "paragraph" })));
}

// --- Markdown -------------------------------------------------------------

const INLINE: Array<{ re: RegExp; make: (m: RegExpExecArray) => ProseMirrorNode }> = [
  { re: /^`([^`]+)`/, make: (m) => t(m[1], [{ type: "code" }]) },
  { re: /^\*\*([^*]+)\*\*/, make: (m) => t(m[1], [{ type: "bold" }]) },
  { re: /^__([^_]+)__/, make: (m) => t(m[1], [{ type: "bold" }]) },
  { re: /^~~([^~]+)~~/, make: (m) => t(m[1], [{ type: "strike" }]) },
  { re: /^\*([^*]+)\*/, make: (m) => t(m[1], [{ type: "italic" }]) },
  { re: /^_([^_]+)_/, make: (m) => t(m[1], [{ type: "italic" }]) },
  { re: /^\[([^\]]+)\]\(([^)]+)\)/, make: (m) => t(m[1], [{ type: "link", attrs: { href: m[2] } }]) },
];

function parseInline(s: string): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(t(buf)); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const hit = INLINE.map((p) => ({ p, m: p.re.exec(rest) })).find((x) => x.m);
    if (hit && hit.m) {
      flush();
      out.push(hit.p.make(hit.m));
      i += hit.m[0].length;
    } else {
      buf += s[i++];
    }
  }
  flush();
  return out;
}

const BLOCK_START = /^(#{1,4}\s|```|>|[-*+]\s|\d+\.\s)/;

export function markdownToDoc(input: string): ProseMirrorNode {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const content: ProseMirrorNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const text = code.join("\n");
      content.push({ type: "codeBlock", ...(language ? { attrs: { language } } : {}), content: text ? [t(text)] : [] });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { content.push({ type: "heading", attrs: { level: h[1].length }, content: parseInline(h[2]) }); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { content.push({ type: "horizontalRule" }); i++; continue; }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      content.push({ type: "blockquote", content: [para(parseInline(q.join(" ")))] });
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      const items: ProseMirrorNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push({ type: "listItem", content: [para(parseInline(lines[i++].replace(/^[-*+]\s+/, "")))] });
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: ProseMirrorNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push({ type: "listItem", content: [para(parseInline(lines[i++].replace(/^\d+\.\s+/, "")))] });
      }
      content.push({ type: "orderedList", content: items });
      continue;
    }
    const par: string[] = [];
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]) && !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      par.push(lines[i++]);
    }
    content.push(para(parseInline(par.join(" "))));
  }
  return wrapDoc(content);
}

// --- HTML -----------------------------------------------------------------

const MARK_TAGS: Record<string, Mark> = {
  STRONG: { type: "bold" }, B: { type: "bold" },
  EM: { type: "italic" }, I: { type: "italic" },
  U: { type: "underline" }, S: { type: "strike" }, DEL: { type: "strike" },
  CODE: { type: "code" }, MARK: { type: "highlight" },
};

function inlineFromDom(node: ChildNode, marks: Mark[]): ProseMirrorNode[] {
  if (node.nodeType === 3) {
    const text = node.textContent ?? "";
    return text ? [t(text, marks.length ? marks : undefined)] : [];
  }
  if (node.nodeType !== 1) return [];
  const el = node as Element;
  if (el.tagName === "BR") return [{ type: "hardBreak" }];
  let nextMarks = marks;
  if (el.tagName === "A") {
    nextMarks = [...marks, { type: "link", attrs: { href: el.getAttribute("href") ?? "#" } }];
  } else if (MARK_TAGS[el.tagName]) {
    nextMarks = [...marks, MARK_TAGS[el.tagName]];
  }
  return [...el.childNodes].flatMap((c) => inlineFromDom(c, nextMarks));
}

function blockFromDom(el: Element): ProseMirrorNode[] {
  const tag = el.tagName;
  const inline = () => [...el.childNodes].flatMap((c) => inlineFromDom(c, []));
  switch (tag) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
      return [{ type: "heading", attrs: { level: Math.min(4, Number(tag[1])) }, content: inline() }];
    case "P": return [para(inline())];
    case "BLOCKQUOTE": return [{ type: "blockquote", content: [para(inline())] }];
    case "HR": return [{ type: "horizontalRule" }];
    case "PRE": return [{ type: "codeBlock", content: el.textContent ? [t(el.textContent)] : [] }];
    case "UL": case "OL":
      return [{
        type: tag === "UL" ? "bulletList" : "orderedList",
        content: [...el.children].filter((c) => c.tagName === "LI")
          .map((li) => ({ type: "listItem", content: [para([...li.childNodes].flatMap((c) => inlineFromDom(c, [])))] })),
      }];
    case "DIV": case "SECTION": case "ARTICLE": case "BODY":
      return [...el.children].flatMap(blockFromDom);
    default: {
      const content = inline();
      return content.length ? [para(content)] : [];
    }
  }
}

export function htmlToDoc(html: string): ProseMirrorNode {
  if (typeof DOMParser === "undefined") {
    return textToDoc(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }
  const dom = new DOMParser().parseFromString(html, "text/html");
  return wrapDoc([...dom.body.children].flatMap(blockFromDom));
}

// --- Dispatch -------------------------------------------------------------

/** Returns a doc node + whether the format was recognised (else treated as text). */
export function importToDoc(filename: string, text: string): ProseMirrorNode {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown") return markdownToDoc(text);
  if (ext === "html" || ext === "htm") return htmlToDoc(text);
  return textToDoc(text);
}

export const IMPORT_ACCEPT = ".elium,.txt,.md,.markdown,.html,.htm,.docx";
