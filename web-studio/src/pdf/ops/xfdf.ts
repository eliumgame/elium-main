/**
 * XFDF import/export — the interchange format Acrobat uses for "Export
 * comments to a data file" / "Import comments". Round-tripping it is what lets
 * an Elium review be merged into an Acrobat review and back.
 */

import { quadFromRect, rectOfPoints, rectOfQuads, round } from "../core/coords";
import type { Pt, Quad, Rect } from "../core/coords";
import type { Annot, AnnotKind, Page, Reply, ReviewStatus } from "../model/types";
import { isTextMarkup, newId } from "../model/types";

const XFDF_KIND: Partial<Record<AnnotKind, string>> = {
  highlight: "highlight",
  underline: "underline",
  strikeout: "strikeout",
  squiggly: "squiggly",
  note: "text",
  freetext: "freetext",
  typewriter: "freetext",
  callout: "freetext",
  ink: "ink",
  square: "square",
  circle: "circle",
  line: "line",
  arrow: "line",
  polygon: "polygon",
  cloud: "polygon",
  polyline: "polyline",
  stamp: "stamp",
  image: "stamp",
  signature: "stamp",
  distance: "line",
  perimeter: "polyline",
  area: "polygon",
};

const KIND_FROM_XFDF: Record<string, AnnotKind> = {
  highlight: "highlight",
  underline: "underline",
  strikeout: "strikeout",
  squiggly: "squiggly",
  text: "note",
  freetext: "freetext",
  ink: "ink",
  square: "square",
  circle: "circle",
  line: "line",
  polygon: "polygon",
  polyline: "polyline",
  stamp: "stamp",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function xfdfDate(iso: string): string {
  const d = new Date(iso);
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -t.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `D:${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
}

function parseXfdfDate(s: string | null): string {
  if (!s) return new Date().toISOString();
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(s.trim());
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const [, y, mo, da, h = "00", mi = "00", se = "00"] = m;
  return new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(se)).toISOString();
}

/** Page-space rect → XFDF `rect` (PDF space, bottom-left). */
const toPdfRect = (r: Rect, h: number) => [r.x, h - r.y - r.h, r.x + r.w, h - r.y].map((v) => round(v, 2)).join(",");

const toPdfPoints = (pts: readonly Pt[], h: number) =>
  pts.map((p) => `${round(p.x, 2)},${round(h - p.y, 2)}`).join(";");

function toPdfQuads(quads: readonly Quad[], h: number): string {
  // XFDF `coords` uses the same odd order as /QuadPoints.
  return quads
    .map(([tl, tr, br, bl]) =>
      [tl.x, h - tl.y, tr.x, h - tr.y, bl.x, h - bl.y, br.x, h - br.y].map((v) => round(v, 2)).join(","))
    .join(";");
}

const hexColour = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : "#000000");

/**
 * Serialise annotations to XFDF. `pageHeights` maps a page id to its unrotated
 * height, needed for the y-flip.
 */
export function toXfdf(
  annots: readonly Annot[],
  pages: readonly Page[],
  pageHeights: ReadonlyMap<string, number>,
  sourceName: string,
): string {
  const indexOf = new Map(pages.map((p, i) => [p.id, i]));
  const body: string[] = [];

  for (const a of annots) {
    const tag = XFDF_KIND[a.kind];
    const page = indexOf.get(a.pageId);
    if (!tag || page === undefined) continue;
    const h = pageHeights.get(a.pageId) ?? 842;

    const attrs: string[] = [
      `page="${page}"`,
      `rect="${toPdfRect(a.rect, h)}"`,
      `color="${hexColour(a.color)}"`,
      `opacity="${round(a.opacity ?? 1, 3)}"`,
      `flags="print"`,
      `date="${xfdfDate(a.modifiedAt)}"`,
      `creationdate="${xfdfDate(a.createdAt)}"`,
      `title="${esc(a.author)}"`,
      `name="${esc(a.id)}"`,
    ];
    if (a.subject) attrs.push(`subject="${esc(a.subject)}"`);
    if (a.fill) attrs.push(`interior-color="${hexColour(a.fill)}"`);
    if (a.strokeWidth) attrs.push(`width="${round(a.strokeWidth, 2)}"`);
    if (isTextMarkup(a.kind) && a.quads?.length) attrs.push(`coords="${toPdfQuads(a.quads, h)}"`);
    if (a.kind === "line" || a.kind === "arrow" || a.kind === "distance") {
      const pts = a.paths?.[0] ?? [{ x: a.rect.x, y: a.rect.y }, { x: a.rect.x + a.rect.w, y: a.rect.y + a.rect.h }];
      attrs.push(`start="${round(pts[0].x, 2)},${round(h - pts[0].y, 2)}"`);
      const end = pts[pts.length - 1];
      attrs.push(`end="${round(end.x, 2)},${round(h - end.y, 2)}"`);
      attrs.push(`head="${a.lineStart === "arrow" ? "OpenArrow" : "None"}"`);
      attrs.push(`tail="${a.lineEnd === "arrow" ? "OpenArrow" : "None"}"`);
    }
    if ((a.kind === "polygon" || a.kind === "polyline" || a.kind === "cloud" || a.kind === "area" || a.kind === "perimeter") && a.paths?.[0]) {
      attrs.push(`vertices="${toPdfPoints(a.paths[0], h)}"`);
    }
    if (a.kind === "note") attrs.push('icon="Comment"', 'open="no"');

    const inner: string[] = [];
    if (a.kind === "ink" && a.paths?.length) {
      inner.push(`<inklist>${a.paths.map((p) => `<gesture>${toPdfPoints(p, h)}</gesture>`).join("")}</inklist>`);
    }
    const contents = a.contents ?? (isTextContentKind(a.kind) ? a.text : undefined);
    if (contents) inner.push(`<contents>${esc(contents)}</contents>`);
    if (a.status && a.status !== "none") inner.push(`<elium:status>${a.status}</elium:status>`);

    body.push(`<${tag} ${attrs.join(" ")}>${inner.join("")}</${tag}>`);

    for (const reply of a.replies ?? []) {
      body.push(
        `<text page="${page}" rect="${toPdfRect({ ...a.rect, w: 20, h: 20 }, h)}" ` +
        `inreplyto="${esc(a.id)}" replyType="R" title="${esc(reply.author)}" ` +
        `name="${esc(reply.id)}" date="${xfdfDate(reply.createdAt)}" creationdate="${xfdfDate(reply.createdAt)}" ` +
        `flags="hidden">` +
        `<contents>${esc(reply.text)}</contents></text>`,
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xmlns:elium="https://elium.app/xfdf" xml:space="preserve">
<f href="${esc(sourceName)}"/>
<annots>
${body.join("\n")}
</annots>
</xfdf>`;
}

function isTextContentKind(k: AnnotKind): boolean {
  return k === "freetext" || k === "callout" || k === "typewriter";
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function parseNums(s: string | null): number[] {
  if (!s) return [];
  return s.split(/[,;\s]+/).map(Number).filter((n) => Number.isFinite(n));
}

/** Parse XFDF into annotations bound to `pages` (by index). */
export function fromXfdf(
  xml: string,
  pages: readonly Page[],
  pageHeights: ReadonlyMap<string, number>,
  defaultAuthor: string,
): Annot[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return [];
  const out: Annot[] = [];
  const replies: { parent: string; reply: Reply }[] = [];

  const nodes = Array.from(doc.getElementsByTagName("*")).filter((el) => KIND_FROM_XFDF[el.localName]);
  for (const el of nodes) {
    const pageIndex = Number(el.getAttribute("page") ?? "0");
    const page = pages[pageIndex];
    if (!page) continue;
    const h = pageHeights.get(page.id) ?? 842;
    const flip = (y: number) => h - y;
    const contents = el.getElementsByTagName("contents")[0]?.textContent ?? "";
    const inReplyTo = el.getAttribute("inreplyto");
    const created = parseXfdfDate(el.getAttribute("creationdate") ?? el.getAttribute("date"));

    if (inReplyTo) {
      replies.push({
        parent: inReplyTo,
        reply: { id: el.getAttribute("name") || newId("rp"), author: el.getAttribute("title") || defaultAuthor, text: contents, createdAt: created },
      });
      continue;
    }

    const kind = KIND_FROM_XFDF[el.localName];
    const r = parseNums(el.getAttribute("rect"));
    const rect: Rect = r.length >= 4
      ? { x: Math.min(r[0], r[2]), y: flip(Math.max(r[1], r[3])), w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) }
      : { x: 40, y: 40, w: 120, h: 40 };

    const annot: Annot = {
      id: el.getAttribute("name") || newId("an"),
      pageId: page.id,
      kind,
      rect,
      color: (el.getAttribute("color") || "#e11d48").toLowerCase(),
      fill: el.getAttribute("interior-color")?.toLowerCase() ?? null,
      opacity: Number(el.getAttribute("opacity") ?? "1") || 1,
      strokeWidth: Number(el.getAttribute("width") ?? "2") || 2,
      author: el.getAttribute("title") || defaultAuthor,
      subject: el.getAttribute("subject") || undefined,
      contents: contents || undefined,
      createdAt: created,
      modifiedAt: parseXfdfDate(el.getAttribute("date") ?? el.getAttribute("creationdate")),
      status: (el.getElementsByTagName("status")[0]?.textContent as ReviewStatus) || "none",
      replies: [],
    };

    if (isTextMarkup(kind)) {
      const coords = parseNums(el.getAttribute("coords"));
      const quads: Quad[] = [];
      for (let i = 0; i + 7 < coords.length; i += 8) {
        quads.push([
          { x: coords[i], y: flip(coords[i + 1]) },
          { x: coords[i + 2], y: flip(coords[i + 3]) },
          { x: coords[i + 6], y: flip(coords[i + 7]) },
          { x: coords[i + 4], y: flip(coords[i + 5]) },
        ]);
      }
      annot.quads = quads.length ? quads : [quadFromRect(rect)];
      annot.rect = rectOfQuads(annot.quads);
    } else if (kind === "ink") {
      const paths: Pt[][] = [];
      for (const gesture of Array.from(el.getElementsByTagName("gesture"))) {
        const nums = parseNums(gesture.textContent);
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: flip(nums[i + 1]) });
        if (pts.length) paths.push(pts);
      }
      if (paths.length) {
        annot.paths = paths;
        annot.rect = rectOfPoints(paths.flat());
      }
    } else if (kind === "line") {
      const s = parseNums(el.getAttribute("start"));
      const e = parseNums(el.getAttribute("end"));
      if (s.length >= 2 && e.length >= 2) {
        annot.paths = [[{ x: s[0], y: flip(s[1]) }, { x: e[0], y: flip(e[1]) }]];
        if ((el.getAttribute("tail") || "").toLowerCase().includes("arrow")) {
          annot.kind = "arrow";
          annot.lineEnd = "arrow";
        }
      }
    } else if (kind === "polygon" || kind === "polyline") {
      const nums = parseNums(el.getAttribute("vertices"));
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: flip(nums[i + 1]) });
      if (pts.length) {
        annot.paths = [pts];
        annot.rect = rectOfPoints(pts);
      }
    } else if (kind === "freetext") {
      annot.text = contents;
      annot.fontSize = 12;
      annot.textBg = null;
    } else if (kind === "note") {
      annot.text = contents;
    }

    out.push(annot);
  }

  for (const { parent, reply } of replies) {
    const target = out.find((a) => a.id === parent);
    if (target) target.replies = [...(target.replies ?? []), reply];
  }
  return out;
}
