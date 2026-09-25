/**
 * XFDF import/export — the interchange format Acrobat uses for "Export
 * comments to a data file" / "Import comments". Round-tripping it is what lets
 * an Elium review be merged into an Acrobat review and back.
 *
 * The attributes follow Adobe's XFDF 3.0 specification, and what Acrobat
 * writes: coordinates in PDF user space (the crop box's origin included),
 * review states as `<text>` replies carrying `state` / `statemodel`, text-box
 * colours as `/DA` in `defaultappearance` (the element's `color` is the box's
 * fill, as `/C` of a FreeText), line endings by their PDF names.
 */

import { quadFromRect, rectOfPoints, rectOfQuads, round } from "../core/coords";
import type { Pt, Quad, Rect } from "../core/coords";
import { stampByName } from "../model/stamps";
import type { Annot, AnnotKind, LineEnding, Page, Reply, ReviewStatus } from "../model/types";
import { isTextMarkup, newId } from "../model/types";

const XFDF_KIND: Partial<Record<AnnotKind, string>> = {
  highlight: "highlight",
  underline: "underline",
  strikeout: "strikeout",
  squiggly: "squiggly",
  caret: "caret",
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
  redact: "redact",
};

const KIND_FROM_XFDF: Record<string, AnnotKind> = {
  highlight: "highlight",
  underline: "underline",
  strikeout: "strikeout",
  squiggly: "squiggly",
  caret: "caret",
  text: "note",
  freetext: "freetext",
  ink: "ink",
  square: "square",
  circle: "circle",
  line: "line",
  polygon: "polygon",
  polyline: "polyline",
  stamp: "stamp",
  redact: "redact",
};

const LE_NAME: Record<LineEnding, string> = {
  none: "None",
  arrow: "ClosedArrow",
  openArrow: "OpenArrow",
  circle: "Circle",
  square: "Square",
  diamond: "Diamond",
  butt: "Butt",
  slash: "Slash",
};
const LE_FROM: Record<string, LineEnding> = {
  none: "none",
  closedarrow: "arrow",
  openarrow: "openArrow",
  circle: "circle",
  square: "square",
  diamond: "diamond",
  butt: "butt",
  slash: "slash",
  // Not modelled: the nearest look.
  rclosedarrow: "arrow",
  ropenarrow: "openArrow",
};

const STATE_NAME: Record<ReviewStatus, string> = {
  none: "None",
  accepted: "Accepted",
  rejected: "Rejected",
  cancelled: "Cancelled",
  completed: "Completed",
};
const STATE_FROM: Record<string, ReviewStatus> = {
  none: "none",
  accepted: "accepted",
  rejected: "rejected",
  cancelled: "cancelled",
  completed: "completed",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:([Zz])|([+-])(\d{2})'?(\d{2})?'?)?/.exec(s.trim());
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const [, y, mo, da, h = "00", mi = "00", se = "00", z, sign, oh, om] = m;
  if (z || sign) {
    const off = sign ? (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om ?? 0)) : 0;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(se)) - off * 60_000;
    return new Date(utc).toISOString();
  }
  return new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(se)).toISOString();
}

/**
 * A page's frame for the conversion: its unrotated height and the origin of
 * its crop box in PDF user space. A bare number is a height at origin (0, 0).
 */
export type XfdfPageBox = number | { h: number; ox?: number; oy?: number };

interface Frame {
  h: number;
  ox: number;
  oy: number;
}
const frameOf = (b: XfdfPageBox | undefined): Frame =>
  typeof b === "number" ? { h: b, ox: 0, oy: 0 } : { h: b?.h ?? 842, ox: b?.ox ?? 0, oy: b?.oy ?? 0 };

const num = (v: number) => round(v, 2);
const px = (f: Frame, x: number) => num(x + f.ox);
const py = (f: Frame, y: number) => num(f.oy + f.h - y);

/** Page-space rect → XFDF `rect` (PDF space, bottom-left). */
const toPdfRect = (r: Rect, f: Frame) => [px(f, r.x), py(f, r.y + r.h), px(f, r.x + r.w), py(f, r.y)].join(",");

const toPdfPoints = (pts: readonly Pt[], f: Frame) => pts.map((p) => `${px(f, p.x)},${py(f, p.y)}`).join(";");

function toPdfQuads(quads: readonly Quad[], f: Frame): string {
  // XFDF `coords` uses the same odd order as /QuadPoints.
  return quads
    .map(([tl, tr, br, bl]) =>
      [px(f, tl.x), py(f, tl.y), px(f, tr.x), py(f, tr.y), px(f, bl.x), py(f, bl.y), px(f, br.x), py(f, br.y)].join(
        ",",
      ),
    )
    .join(";");
}

const hexColour = (c: string | null | undefined) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : "#000000");

function rgbOf(hex: string): string {
  const c = hexColour(hex);
  return [1, 3, 5].map((i) => round(parseInt(c.slice(i, i + 2), 16) / 255, 3)).join(" ");
}

function flagsOf(a: Annot): string {
  const f: string[] = [];
  if (a.hidden) f.push("hidden");
  const bits = a.pdf?.flags;
  if (bits === undefined || bits & 4) f.push("print");
  if (bits !== undefined) {
    if (bits & 8) f.push("nozoom");
    if (bits & 16) f.push("norotate");
    if (bits & 32) f.push("noview");
    if (bits & 64) f.push("readonly");
  }
  if (a.locked) f.push("locked");
  return f.join(",");
}

/**
 * Serialise annotations to XFDF. `pageBoxes` maps a page id to its frame
 * (unrotated height, crop-box origin).
 */
export function toXfdf(
  annots: readonly Annot[],
  pages: readonly Page[],
  pageBoxes: ReadonlyMap<string, XfdfPageBox>,
  sourceName: string,
): string {
  const indexOf = new Map(pages.map((p, i) => [p.id, i]));
  const body: string[] = [];

  for (const a of annots) {
    const tag = XFDF_KIND[a.kind];
    const page = indexOf.get(a.pageId);
    if (!tag || page === undefined) continue;
    const f = frameOf(pageBoxes.get(a.pageId));
    const name = a.pdf?.nm ?? a.id;
    const textKind = isTextContentKind(a.kind);

    const attrs: string[] = [
      `page="${page}"`,
      `rect="${toPdfRect(a.kind === "note" ? { ...a.rect, w: 20, h: 20 } : a.rect, f)}"`,
      `flags="${flagsOf(a)}"`,
      `date="${xfdfDate(a.modifiedAt)}"`,
      `creationdate="${xfdfDate(a.createdAt)}"`,
      `title="${esc(a.author)}"`,
      `name="${esc(name)}"`,
      `opacity="${round(a.opacity ?? 1, 3)}"`,
    ];
    // A text box's `color` is its FILL (/C of a FreeText); its text colour is in /DA.
    if (textKind) {
      if (a.textBg) attrs.push(`color="${hexColour(a.textBg)}"`);
    } else if (a.kind === "redact") {
      attrs.push(`color="${hexColour(a.color)}"`, `interior-color="${hexColour(a.redactFill ?? "#000000")}"`);
    } else {
      attrs.push(`color="${hexColour(a.color)}"`);
    }
    if (a.subject) attrs.push(`subject="${esc(a.subject)}"`);
    if (a.group) {
      // Acrobat's « Remplacer le texte »: the strike-out belongs to its Caret.
      const parent = annots.find((x) => x.id === a.group);
      attrs.push(`inreplyto="${esc(parent?.pdf?.nm ?? a.group)}"`, 'replyType="group"', 'intent="StrikeOutTextEdit"');
    }
    if (a.fill && !textKind && a.kind !== "redact") attrs.push(`interior-color="${hexColour(a.fill)}"`);
    attrs.push(`width="${round(a.strokeWidth ?? 0, 2)}"`);
    if (a.borderStyle === "dashed") attrs.push('style="dash"', `dashes="${(a.dash ?? [4, 3]).join(",")}"`);
    if (a.borderStyle === "cloudy" || a.kind === "cloud") attrs.push('style="cloudy"', 'intensity="1"');
    if (isTextMarkup(a.kind) && a.quads?.length) attrs.push(`coords="${toPdfQuads(a.quads, f)}"`);
    if (a.kind === "line" || a.kind === "arrow" || a.kind === "distance") {
      const pts = a.paths?.[0] ?? [
        { x: a.rect.x, y: a.rect.y },
        { x: a.rect.x + a.rect.w, y: a.rect.y + a.rect.h },
      ];
      const end = pts[pts.length - 1];
      attrs.push(`start="${px(f, pts[0].x)},${py(f, pts[0].y)}"`, `end="${px(f, end.x)},${py(f, end.y)}"`);
      const tail = a.lineEnd ?? (a.kind === "arrow" ? "arrow" : "none");
      attrs.push(`head="${LE_NAME[a.lineStart ?? "none"]}"`, `tail="${LE_NAME[tail]}"`);
      if (a.kind === "distance") attrs.push('intent="LineDimension"');
    }
    if (
      (a.kind === "polygon" ||
        a.kind === "polyline" ||
        a.kind === "cloud" ||
        a.kind === "area" ||
        a.kind === "perimeter") &&
      a.paths?.[0]
    ) {
      attrs.push(`vertices="${toPdfPoints(a.paths[0], f)}"`);
      if (a.kind === "area") attrs.push('intent="PolygonDimension"');
      if (a.kind === "perimeter") attrs.push('intent="PolyLineDimension"');
      if (a.kind === "polyline" || a.kind === "perimeter") {
        attrs.push(`head="${LE_NAME[a.lineStart ?? "none"]}"`, `tail="${LE_NAME[a.lineEnd ?? "none"]}"`);
      }
    }
    if (a.kind === "note") attrs.push(`icon="${esc(a.icon ?? "Comment")}"`, `open="${a.pdf?.open ? "yes" : "no"}"`);
    if (a.kind === "stamp" || a.kind === "image" || a.kind === "signature") {
      attrs.push(`icon="${esc(a.stampName ?? "Draft")}"`);
      if (a.stampLabel && !a.subject) attrs.push(`subject="${esc(a.stampLabel)}"`);
      if (a.rotation) attrs.push(`rotation="${round(a.rotation, 2)}"`);
    }
    if (a.kind === "redact" && a.redactText) attrs.push(`overlay-text="${esc(a.redactText)}"`);
    if (textKind) {
      const size = round(a.fontSize ?? 12, 2);
      const col = rgbOf(a.color);
      attrs.push(`defaultappearance="${col} rg ${col} RG /Helv ${size} Tf"`);
      attrs.push(
        `defaultstyle="${esc(`font: ${a.italic ? "italic " : ""}${a.bold ? "bold " : ""}${size}pt Helvetica; color:${hexColour(a.color)}`)}"`,
      );
      attrs.push(`justification="${a.align === "center" ? 1 : a.align === "right" ? 2 : 0}"`);
      if (a.kind === "typewriter") attrs.push('intent="FreeTextTypeWriter"');
      if (a.kind === "callout" && a.callout?.length) {
        attrs.push(
          'intent="FreeTextCallout"',
          `callout="${a.callout.map((p) => `${px(f, p.x)},${py(f, p.y)}`).join(",")}"`,
        );
        attrs.push(`head="${LE_NAME[a.lineEnd ?? "arrow"]}"`);
      }
    }

    const inner: string[] = [];
    if (a.kind === "ink" && a.paths?.length) {
      inner.push(`<inklist>${a.paths.map((p) => `<gesture>${toPdfPoints(p, f)}</gesture>`).join("")}</inklist>`);
    }
    const contents = a.contents ?? (textKind || a.kind === "note" ? a.text : undefined);
    if (contents) inner.push(`<contents>${esc(contents)}</contents>`);
    if (a.pdf?.rc && a.pdf.rcFor === (a.text ?? a.contents ?? ""))
      inner.push(`<contents-richtext>${a.pdf.rc}</contents-richtext>`);

    body.push(`<${tag} ${attrs.join(" ")}>${inner.join("")}</${tag}>`);

    if (a.checked) {
      body.push(
        `<text page="${page}" rect="${toPdfRect({ ...a.rect, w: 20, h: 20 }, f)}" inreplyto="${esc(name)}" ` +
          `replyType="reply" title="${esc(a.author)}" name="${esc(`${name}-marked`)}" date="${xfdfDate(a.modifiedAt)}" ` +
          `flags="hidden,print" state="Marked" statemodel="Marked"><contents>Marked</contents></text>`,
      );
    }
    for (const reply of a.replies ?? []) {
      const state = reply.status ? ` state="${STATE_NAME[reply.status]}" statemodel="Review"` : "";
      body.push(
        `<text page="${page}" rect="${toPdfRect({ ...a.rect, w: 20, h: 20 }, f)}" ` +
          `inreplyto="${esc(name)}" replyType="reply" title="${esc(reply.author)}" ` +
          `name="${esc(reply.id)}" date="${xfdfDate(reply.createdAt)}" creationdate="${xfdfDate(reply.createdAt)}" ` +
          `flags="hidden,print"${state}>` +
          `<contents>${esc(reply.text)}</contents></text>`,
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
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
  return s
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/** A number attribute; `fallback` only when it is absent or not a number (0 stays 0). */
function numAttr(el: Element, name: string, fallback: number): number {
  const v = el.getAttribute(name);
  if (v === null || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function colourAttr(el: Element, name: string): string | null {
  const v = el.getAttribute(name);
  return v && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : null;
}

/** The text colour and size of a `/DA` string ("r g b rg /Helv 12 Tf"). */
function parseDa(da: string | null): { color?: string; size?: number } {
  if (!da) return {};
  const out: { color?: string; size?: number } = {};
  const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  if (rg) {
    const h = (v: string) =>
      Math.max(0, Math.min(255, Math.round(Number(v) * 255)))
        .toString(16)
        .padStart(2, "0");
    out.color = `#${h(rg[1])}${h(rg[2])}${h(rg[3])}`;
  } else {
    const g = /([\d.]+)\s+g(?:\s|$)/.exec(da);
    if (g) {
      const v = Math.round(Number(g[1]) * 255)
        .toString(16)
        .padStart(2, "0");
      out.color = `#${v}${v}${v}`;
    }
  }
  const tf = /([\d.]+)\s+Tf/.exec(da);
  if (tf && Number(tf[1]) > 0) out.size = Number(tf[1]);
  return out;
}

function flagsFrom(s: string | null): { hidden: boolean; locked: boolean; bits: number } {
  const set = new Set(
    (s ?? "print")
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean),
  );
  let bits = 0;
  if (set.has("invisible")) bits |= 1;
  if (set.has("hidden")) bits |= 2;
  if (set.has("print")) bits |= 4;
  if (set.has("nozoom")) bits |= 8;
  if (set.has("norotate")) bits |= 16;
  if (set.has("noview")) bits |= 32;
  if (set.has("readonly")) bits |= 64;
  if (set.has("locked")) bits |= 128;
  return { hidden: set.has("hidden"), locked: set.has("locked"), bits };
}

/**
 * Parse XFDF into annotations bound to `pages` (by index). An imported
 * annotation takes the XFDF `name` as its id, so importing the same file
 * twice updates rather than duplicates (see `mergeImported`).
 */
export function fromXfdf(
  xml: string,
  pages: readonly Page[],
  pageBoxes: ReadonlyMap<string, XfdfPageBox>,
  defaultAuthor: string,
): Annot[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return [];
  const out: Annot[] = [];
  const replies: { parent: string; reply: Reply; stateModel: string | null }[] = [];
  const marks: { parent: string; checked: boolean; when: string }[] = [];
  const annotsEl = doc.getElementsByTagName("annots")[0];
  const scope = annotsEl ?? doc.documentElement;
  const nodes = Array.from(scope.children).filter((el) => KIND_FROM_XFDF[el.localName]);
  for (const el of nodes) {
    const pageIndex = numAttr(el, "page", 0);
    const page = pages[pageIndex];
    if (!page) continue;
    const f = frameOf(pageBoxes.get(page.id));
    const X = (x: number) => x - f.ox;
    const Y = (y: number) => f.oy + f.h - y;
    const contents = Array.from(el.children).find((c) => c.localName === "contents")?.textContent ?? "";
    const rich = Array.from(el.children).find((c) => c.localName === "contents-richtext");
    const inReplyTo = el.getAttribute("inreplyto");
    const created = parseXfdfDate(el.getAttribute("creationdate") ?? el.getAttribute("date"));
    const flags = flagsFrom(el.getAttribute("flags"));
    const isGroup =
      !!inReplyTo && (el.getAttribute("replyType") ?? el.getAttribute("replytype") ?? "").toLowerCase() === "group";

    if (inReplyTo && !isGroup) {
      const state = el.getAttribute("state");
      const model = el.getAttribute("statemodel");
      // The checkmark: a state of the comment, not a line of its thread.
      if ((model ?? "").toLowerCase() === "marked") {
        marks.push({ parent: inReplyTo, checked: (state ?? "").toLowerCase() === "marked", when: created });
        continue;
      }
      replies.push({
        parent: inReplyTo,
        stateModel: model,
        reply: {
          id: el.getAttribute("name") || newId("rp"),
          author: el.getAttribute("title") || defaultAuthor,
          text: contents,
          createdAt: created,
          ...(state && (model ?? "Review") === "Review" && STATE_FROM[state.toLowerCase()]
            ? { status: STATE_FROM[state.toLowerCase()] }
            : {}),
        },
      });
      continue;
    }

    const kind = KIND_FROM_XFDF[el.localName];
    const r = parseNums(el.getAttribute("rect"));
    const rect: Rect =
      r.length >= 4
        ? {
            x: X(Math.min(r[0], r[2])),
            y: Y(Math.max(r[1], r[3])),
            w: Math.abs(r[2] - r[0]),
            h: Math.abs(r[3] - r[1]),
          }
        : { x: 40, y: 40, w: 120, h: 40 };
    const style = (el.getAttribute("style") ?? "").toLowerCase();
    const intent = el.getAttribute("intent") ?? el.getAttribute("IT") ?? "";

    const annot: Annot = {
      id: el.getAttribute("name") || newId("an"),
      pageId: page.id,
      kind,
      rect,
      color: colourAttr(el, "color") ?? "#e11d48",
      fill: colourAttr(el, "interior-color"),
      opacity: numAttr(el, "opacity", 1),
      strokeWidth: numAttr(el, "width", 1),
      borderStyle: style === "dash" ? "dashed" : style === "cloudy" ? "cloudy" : "solid",
      author: el.getAttribute("title") || defaultAuthor,
      subject: el.getAttribute("subject") || undefined,
      contents: contents || undefined,
      createdAt: created,
      modifiedAt: parseXfdfDate(el.getAttribute("date") ?? el.getAttribute("creationdate")),
      status: "none",
      replies: [],
      hidden: flags.hidden,
      locked: flags.locked,
    };
    const name = el.getAttribute("name");
    annot.pdf = { flags: flags.bits, ...(name ? { nm: name } : {}) };
    if (isGroup) {
      // The strike-out of a « Remplacer le texte »: its text is its Caret's.
      annot.group = inReplyTo!;
      annot.contents = undefined;
    }
    if (rich?.innerHTML) annot.pdf = { ...annot.pdf, rc: rich.innerHTML, rcFor: contents };
    const dashes = parseNums(el.getAttribute("dashes"));
    if (dashes.length) annot.dash = dashes;
    const head = LE_FROM[(el.getAttribute("head") ?? "none").toLowerCase()] ?? "none";
    const tail = LE_FROM[(el.getAttribute("tail") ?? "none").toLowerCase()] ?? "none";

    if (isTextMarkup(kind)) {
      const coords = parseNums(el.getAttribute("coords"));
      const quads: Quad[] = [];
      for (let i = 0; i + 7 < coords.length; i += 8) {
        quads.push([
          { x: X(coords[i]), y: Y(coords[i + 1]) },
          { x: X(coords[i + 2]), y: Y(coords[i + 3]) },
          { x: X(coords[i + 6]), y: Y(coords[i + 7]) },
          { x: X(coords[i + 4]), y: Y(coords[i + 5]) },
        ]);
      }
      annot.quads = quads.length ? quads : [quadFromRect(rect)];
      annot.rect = rectOfQuads(annot.quads);
    } else if (kind === "ink") {
      const paths: Pt[][] = [];
      for (const gesture of Array.from(el.getElementsByTagName("gesture"))) {
        const nums = parseNums(gesture.textContent);
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: X(nums[i]), y: Y(nums[i + 1]) });
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
        annot.paths = [
          [
            { x: X(s[0]), y: Y(s[1]) },
            { x: X(e[0]), y: Y(e[1]) },
          ],
        ];
      }
      annot.lineStart = head;
      annot.lineEnd = tail;
      if (intent === "LineDimension") annot.kind = "distance";
      else if (head !== "none" || tail !== "none") annot.kind = "arrow";
    } else if (kind === "polygon" || kind === "polyline") {
      const nums = parseNums(el.getAttribute("vertices"));
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: X(nums[i]), y: Y(nums[i + 1]) });
      if (pts.length) {
        annot.paths = [pts];
        annot.rect = rectOfPoints(pts);
      }
      if (intent === "PolygonDimension") annot.kind = "area";
      else if (intent === "PolyLineDimension") annot.kind = "perimeter";
      else if (kind === "polygon" && style === "cloudy") annot.kind = "cloud";
      if (kind === "polyline") {
        annot.lineStart = head;
        annot.lineEnd = tail;
      }
    } else if (kind === "freetext") {
      const da = parseDa(el.getAttribute("defaultappearance"));
      annot.text = contents;
      annot.contents = undefined;
      annot.fontSize = da.size ?? 12;
      // `color` of a FreeText is its box; the text's is in the /DA.
      annot.textBg = colourAttr(el, "color");
      annot.color = da.color ?? "#0f172a";
      annot.fill = null;
      const j = numAttr(el, "justification", 0);
      annot.align = j === 1 ? "center" : j === 2 ? "right" : "left";
      if (intent === "FreeTextTypeWriter") annot.kind = "typewriter";
      if (intent === "FreeTextCallout") {
        annot.kind = "callout";
        const cl = parseNums(el.getAttribute("callout"));
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < cl.length; i += 2) pts.push({ x: X(cl[i]), y: Y(cl[i + 1]) });
        if (pts.length >= 2) annot.callout = pts;
        annot.lineEnd = head === "none" ? "arrow" : head;
      }
    } else if (kind === "note") {
      annot.text = contents;
      annot.rect = { ...annot.rect, w: 20, h: 20 };
      const icon = el.getAttribute("icon");
      if (icon) annot.icon = icon;
      annot.pdf = { ...annot.pdf, open: (el.getAttribute("open") ?? "no").toLowerCase() === "yes" };
    } else if (kind === "stamp") {
      const icon = el.getAttribute("icon") ?? undefined;
      const def = stampByName(icon);
      annot.stampLabel = def?.label ?? el.getAttribute("subject") ?? icon ?? "TAMPON";
      if (def) annot.stampTone = def.tone;
      if (icon) annot.stampName = icon;
      const rot = numAttr(el, "rotation", 0);
      if (rot) annot.rotation = rot;
    } else if (kind === "redact") {
      annot.redactFill = colourAttr(el, "interior-color") ?? "#000000";
      annot.fill = annot.redactFill;
      annot.color = "#000000";
      annot.strokeWidth = 0;
      const overlay = el.getAttribute("overlay-text");
      if (overlay) annot.redactText = overlay;
      const coords = parseNums(el.getAttribute("coords"));
      if (coords.length >= 8) {
        const quads: Quad[] = [];
        for (let i = 0; i + 7 < coords.length; i += 8) {
          quads.push([
            { x: X(coords[i]), y: Y(coords[i + 1]) },
            { x: X(coords[i + 2]), y: Y(coords[i + 3]) },
            { x: X(coords[i + 6]), y: Y(coords[i + 7]) },
            { x: X(coords[i + 4]), y: Y(coords[i + 5]) },
          ]);
        }
        annot.quads = quads;
      }
    }

    // Elium's former status element (files written before the state replies).
    const legacy = Array.from(el.children)
      .find((c) => c.localName === "status")
      ?.textContent?.trim();
    if (legacy && STATE_FROM[legacy]) annot.status = STATE_FROM[legacy];

    out.push(annot);
  }

  // Threads: replies to replies join the comment's thread.
  const byName = new Map(out.map((a) => [a.id, a]));
  const parentOf = new Map(replies.map((r) => [r.reply.id, r.parent]));
  const rootOf = (id: string, depth = 0): Annot | undefined =>
    byName.get(id) ?? (depth < 32 && parentOf.has(id) ? rootOf(parentOf.get(id)!, depth + 1) : undefined);
  for (const { parent, reply } of replies) {
    const target = rootOf(parent);
    if (target) target.replies = [...(target.replies ?? []), reply];
  }
  marks.sort((x, y) => x.when.localeCompare(y.when));
  for (const m of marks) {
    const target = rootOf(m.parent);
    if (target) target.checked = m.checked;
  }
  for (const a of out) {
    if (!a.replies?.length) continue;
    a.replies.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    const last = [...a.replies].reverse().find((r) => r.status);
    if (last?.status) a.status = last.status;
  }
  return out;
}

/**
 * Imported comments into the current ones: one with the id (XFDF `name`) of
 * a comment already there replaces it — importing a file twice, or a review
 * sent back, updates instead of piling up copies.
 */
export function mergeImported(current: readonly Annot[], imported: readonly Annot[]): Annot[] {
  const byId = new Map(imported.map((a) => [a.id, a]));
  const byNm = new Map(imported.filter((a) => a.pdf?.nm).map((a) => [a.pdf!.nm!, a]));
  const used = new Set<Annot>();
  /** Imported id → the id it ends up with (a local one it replaced). */
  const renamed = new Map<string, string>();
  const out = current.map((a) => {
    const hit = byId.get(a.id) ?? (a.pdf?.nm ? byNm.get(a.pdf.nm) : undefined) ?? byNm.get(a.id);
    if (!hit || used.has(hit)) return a;
    used.add(hit);
    renamed.set(hit.id, a.id);
    // Keep the local id: selections and the pristine-annotation tracking hold it.
    return { ...hit, id: a.id, pageId: hit.pageId };
  });
  for (const a of imported) if (!used.has(a)) out.push(a);
  // A group member follows its Caret's id.
  return out.map((a) => (a.group && renamed.has(a.group) ? { ...a, group: renamed.get(a.group)! } : a));
}
