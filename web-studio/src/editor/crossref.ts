/**
 * Cross-references (renvois) — pure target collection + label rendering.
 *
 * A renvoi stores only an anchor id, a kind and a display mode; the text it
 * shows is derived from the CURRENT document every time it renders, so it can
 * never go stale. This module owns that derivation and knows nothing about
 * TipTap or the DOM, so it is unit-testable and shared by the editor node view,
 * the HTML/Markdown/text exporters and the DOCX writer.
 *
 * Anchors: bookmarks and footnotes already carry their own stable ids. Headings,
 * figures and tables get a `refId` stamped on them the first time a renvoi
 * points at them (the same trick Word uses — it inserts a hidden bookmark), so a
 * reference keeps pointing at the right object when content is reordered.
 */

import { noteMarker } from "./notes";
import type { ProseMirrorNode } from "../format/types";

export type RefKind = "bookmark" | "heading" | "figure" | "table" | "footnote" | "caption" | "endnote";

export type RefDisplay = "text" | "number" | "page" | "aboveBelow" | "full";

export const REF_KIND_LABELS: Record<RefKind, string> = {
  bookmark: "Signet",
  heading: "Titre",
  figure: "Figure",
  table: "Tableau",
  footnote: "Note de bas de page",
  endnote: "Note de fin",
  caption: "Légende",
};

export const REF_DISPLAY_LABELS: Record<RefDisplay, string> = {
  text: "Texte de la cible",
  number: "Numéro",
  page: "Numéro de page",
  aboveBelow: "Ci-dessus / ci-dessous",
  full: "Texte et numéro de page",
};

export interface RefTarget {
  /** Stable anchor id, or "" when the target has not been stamped yet. */
  anchorId: string;
  kind: RefKind;
  /** What the picker shows. */
  label: string;
  /** The target's own number: "2.1" for a heading, "Figure 3", "1" for a note. */
  number: string;
  /** The target's text content. */
  text: string;
  /** Document position of the target node (-1 when scanning plain JSON). */
  pos: number;
  /** Stable-within-a-dialog identity for React keys / select values. */
  key: string;
}

export interface RefContext {
  /** 1-based page the target sits on, when known. */
  targetPage?: number | null;
  /** 1-based page the reference itself sits on, when known. */
  refPage?: number | null;
  /** Document position of the reference itself (for ci-dessus / ci-dessous). */
  refPos?: number | null;
}

const MAX_LABEL = 70;

function shorten(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1)}…` : t;
}

/** A visitor over a document's nodes, in pre-order (parent before children). */
type Visit = (type: string, attrs: Record<string, unknown>, text: string, pos: number) => void;
type Walker = (visit: Visit) => void;

/**
 * Shared scan: assigns heading numbers (1 / 1.1 / 1.1.1 over H1–H3, matching
 * what the document itself renders when heading numbering is on) and figure /
 * table ordinals, in document order.
 */
function scanTargets(walk: Walker): RefTarget[] {
  const out: RefTarget[] = [];
  const headingCounters = [0, 0, 0];
  let figureNo = 0;
  let tableNo = 0;
  let footnoteNo = 0;
  let endnoteNo = 0;
  // Captions are numbered per label, exactly as captions.ts does it — a renvoi
  // to "Figure 3" must say the same number the caption itself displays.
  const captionCounters = new Map<string, number>();

  walk((type, attrs, text, pos) => {
    switch (type) {
      case "heading": {
        const level = Math.max(1, Math.min(4, Number(attrs.level) || 1));
        let number = "";
        if (level <= 3) {
          headingCounters[level - 1]! += 1;
          for (let i = level; i < 3; i++) headingCounters[i] = 0;
          number = headingCounters.slice(0, level).join(".");
        }
        out.push({
          anchorId: String(attrs.refId ?? "") || "",
          kind: "heading",
          label: shorten(text) || "Titre sans texte",
          number,
          text: shorten(text),
          pos,
          key: `heading:${pos}`,
        });
        break;
      }
      case "figure": {
        figureNo += 1;
        const caption = shorten(text);
        out.push({
          anchorId: String(attrs.refId ?? "") || "",
          kind: "figure",
          label: caption ? `Figure ${figureNo} — ${caption}` : `Figure ${figureNo}`,
          number: `Figure ${figureNo}`,
          text: caption,
          pos,
          key: `figure:${pos}`,
        });
        break;
      }
      case "table": {
        tableNo += 1;
        out.push({
          anchorId: String(attrs.refId ?? "") || "",
          kind: "table",
          label: `Tableau ${tableNo}`,
          number: `Tableau ${tableNo}`,
          text: `Tableau ${tableNo}`,
          pos,
          key: `table:${pos}`,
        });
        break;
      }
      case "caption": {
        const label = String(attrs.label ?? "Figure").replace(/\s+/g, " ").trim() || "Figure";
        const n = (captionCounters.get(label) ?? 0) + 1;
        captionCounters.set(label, n);
        const caption = shorten(text);
        out.push({
          anchorId: String(attrs.refId ?? "") || "",
          kind: "caption",
          label: caption ? `${label} ${n} — ${caption}` : `${label} ${n}`,
          number: `${label} ${n}`,
          text: caption,
          pos,
          key: `caption:${pos}`,
        });
        break;
      }
      case "bookmark": {
        const id = String(attrs.id ?? "");
        const label = String(attrs.label ?? "") || id;
        out.push({
          anchorId: id,
          kind: "bookmark",
          label: shorten(label),
          number: "",
          text: shorten(label),
          pos,
          key: `bookmark:${pos}`,
        });
        break;
      }
      case "footnote":
      case "endnote": {
        // Le marqueur suit la famille : arabe pour les notes de bas de page,
        // romain minuscule pour les notes de fin, comme à l'écran.
        const kind = type === "endnote" ? "endnote" : "footnote";
        const marker = kind === "endnote" ? noteMarker("endnote", (endnoteNo += 1)) : String((footnoteNo += 1));
        const noteText = shorten(String(attrs.text ?? ""));
        const name = kind === "endnote" ? "Note de fin" : "Note";
        out.push({
          anchorId: String(attrs.id ?? ""),
          kind,
          label: noteText ? `${name} ${marker} — ${noteText}` : `${name} ${marker}`,
          number: marker,
          text: noteText,
          pos,
          key: `${kind}:${pos}`,
        });
        break;
      }
    }
  });

  return out;
}

/** Minimal shape of a ProseMirror node, so this module needs no TipTap import. */
interface PMLike {
  descendants(fn: (node: { type: { name: string }; attrs: Record<string, unknown>; textContent: string }, pos: number) => boolean | void): void;
}

/** Collect referenceable targets from a live ProseMirror document (real positions). */
export function collectTargets(doc: PMLike): RefTarget[] {
  return scanTargets((visit) => {
    doc.descendants((node, pos) => {
      visit(node.type.name, node.attrs ?? {}, node.textContent ?? "", pos);
      return true;
    });
  });
}

function jsonText(node: ProseMirrorNode): string {
  if (node.text != null) return node.text;
  return (node.content ?? []).map(jsonText).join("");
}

/** Collect referenceable targets from plain document JSON (positions are -1). */
export function collectTargetsJson(doc: ProseMirrorNode): RefTarget[] {
  return scanTargets((visit) => {
    const walk = (node: ProseMirrorNode) => {
      visit(node.type, node.attrs ?? {}, jsonText(node), -1);
      (node.content ?? []).forEach(walk);
    };
    (doc.content ?? []).forEach(walk);
  });
}

/** The text a renvoi displays, for a given target and display mode. */
export function referenceLabel(target: RefTarget, display: RefDisplay, ctx: RefContext | null): string {
  const page = ctx?.targetPage;
  switch (display) {
    case "number":
      return target.number || target.text || target.label;
    case "page":
      return page ? `page ${page}` : "page ?";
    case "aboveBelow": {
      const refPos = ctx?.refPos;
      if (refPos == null || target.pos < 0) return "ci-dessus";
      return target.pos < refPos ? "ci-dessus" : "ci-dessous";
    }
    case "full": {
      const head = target.number ? `${target.number} ${target.text}`.trim() : target.text || target.label;
      return page ? `${head}, page ${page}` : head;
    }
    case "text":
    default:
      return target.text || target.label;
  }
}

/** Generate a stable anchor id for a heading / figure / table. */
export function newAnchorId(kind: RefKind): string {
  const c = globalThis.crypto;
  const rand =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID()
      : Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36);
  const prefix =
    kind === "heading" ? "ref-h" : kind === "figure" ? "ref-fig" : kind === "caption" ? "ref-cap" : "ref-tbl";
  return `${prefix}-${rand}`;
}
