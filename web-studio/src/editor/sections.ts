/**
 * Document sections — pure model.
 *
 * A `sectionBreak` node splits the document into sections. Each section may
 * override the document's page setup (orientation, header/footer) and restart
 * page numbering. This module turns a document's block list into that section
 * model, which the DOCX writer (`w:sectPr`), the print CSS and the on-screen
 * page counter all read.
 *
 * Convention: a break declares the settings of the section that STARTS at it.
 * The first section always inherits the document's own PageSettings.
 */

import type { PageFormat, PageSettings, ProseMirrorNode } from "../format/types";
import { pageSizeMm } from "../format/pageSizes";

export type SectionBreakKind = "nextPage" | "continuous" | "evenPage" | "oddPage";

export interface SectionMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SectionSetup {
  kind: SectionBreakKind;
  /** Sheet format of the section ("" on the break = inherit the document). */
  format: PageFormat;
  orientation: "portrait" | "landscape";
  customWidthMm?: number;
  customHeightMm?: number;
  margins: SectionMargins;
  header: string;
  footer: string;
  restartNumbering: boolean;
  startAt: number;
}

/** Physical geometry of a section, in millimetres — what the screen draws. */
export interface SectionGeometry {
  widthMm: number;
  heightMm: number;
  margins: SectionMargins;
}

export function sectionGeometry(setup: SectionSetup): SectionGeometry {
  const { width, height } = pageSizeMm(setup.format, setup.orientation, {
    widthMm: setup.customWidthMm,
    heightMm: setup.customHeightMm,
  });
  return { widthMm: width, heightMm: height, margins: setup.margins };
}

export interface DocumentSection {
  /** Index of the first top-level block of this section. */
  firstBlock: number;
  /** Index AFTER the last top-level block of this section. */
  endBlock: number;
  setup: SectionSetup;
}

const KINDS: SectionBreakKind[] = ["nextPage", "continuous", "evenPage", "oddPage"];

export function normalizeKind(v: unknown): SectionBreakKind {
  return KINDS.includes(v as SectionBreakKind) ? (v as SectionBreakKind) : "nextPage";
}

/** Does this break start a new PAGE (as opposed to continuing on the same one)? */
export function startsNewPage(kind: SectionBreakKind): boolean {
  return kind !== "continuous";
}

/** A margin override is honoured only when all four sides are finite numbers. */
function marginsFrom(a: Record<string, unknown>, page: PageSettings): SectionMargins {
  const m = a.margins as Partial<SectionMargins> | undefined;
  const sides: (keyof SectionMargins)[] = ["top", "right", "bottom", "left"];
  if (m && sides.every((s) => Number.isFinite(Number(m[s])))) {
    return {
      top: Number(m.top),
      right: Number(m.right),
      bottom: Number(m.bottom),
      left: Number(m.left),
    };
  }
  return { ...page.margins };
}

function setupFrom(attrs: Record<string, unknown> | undefined, page: PageSettings): SectionSetup {
  const a = attrs ?? {};
  const orientation = a.orientation === "landscape" || a.orientation === "portrait" ? a.orientation : page.orientation;
  const format = typeof a.format === "string" && a.format ? (a.format as PageFormat) : page.format;
  const startAt = Math.max(1, Math.round(Number(a.startAt) || 1));
  const custom =
    format === page.format
      ? { widthMm: page.customWidthMm, heightMm: page.customHeightMm }
      : { widthMm: Number(a.customWidthMm) || undefined, heightMm: Number(a.customHeightMm) || undefined };
  return {
    kind: normalizeKind(a.kind),
    format,
    orientation,
    customWidthMm: custom.widthMm,
    customHeightMm: custom.heightMm,
    margins: marginsFrom(a, page),
    header: typeof a.header === "string" && a.header ? a.header : (page.header ?? ""),
    footer: typeof a.footer === "string" && a.footer ? a.footer : (page.footer ?? ""),
    restartNumbering: a.restartNumbering === true,
    startAt,
  };
}

/**
 * Split a document into sections at its top-level `sectionBreak` nodes. The
 * break node itself belongs to neither section (it is a boundary marker), so
 * block ranges never include it.
 */
export function splitSections(doc: ProseMirrorNode, page: PageSettings): DocumentSection[] {
  const blocks = doc.content ?? [];
  const sections: DocumentSection[] = [];
  let current: DocumentSection = {
    firstBlock: 0,
    endBlock: blocks.length,
    setup: {
      kind: "nextPage",
      format: page.format,
      orientation: page.orientation,
      customWidthMm: page.customWidthMm,
      customHeightMm: page.customHeightMm,
      margins: { ...page.margins },
      header: page.header ?? "",
      footer: page.footer ?? "",
      restartNumbering: false,
      startAt: 1,
    },
  };

  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.type !== "sectionBreak") continue;
    current.endBlock = i;
    sections.push(current);
    current = { firstBlock: i + 1, endBlock: blocks.length, setup: setupFrom(blocks[i]!.attrs, page) };
  }
  sections.push(current);
  return sections;
}

/**
 * The page number each section starts on, given how many pages each section
 * occupies. Sections that restart numbering begin at their own `startAt`;
 * `evenPage` / `oddPage` breaks skip a page when the parity is wrong, exactly
 * like Word.
 */
export function sectionStartPages(sections: DocumentSection[], pagesPerSection: number[]): number[] {
  const out: number[] = [];
  let next = 1;
  for (let i = 0; i < sections.length; i++) {
    const setup = sections[i]!.setup;
    let start = next;
    if (i > 0) {
      if (setup.kind === "evenPage" && start % 2 !== 0) start += 1;
      if (setup.kind === "oddPage" && start % 2 === 0) start += 1;
    }
    if (setup.restartNumbering) start = setup.startAt;
    out.push(start);
    next = start + Math.max(0, pagesPerSection[i] ?? 0);
  }
  return out;
}

/** Whether a document uses sections at all (cheap guard for the exporters). */
export function hasSections(doc: ProseMirrorNode): boolean {
  return (doc.content ?? []).some((n) => n.type === "sectionBreak");
}

/**
 * Section index of every top-level block, by block index. A `sectionBreak` is a
 * boundary marker: it is reported as belonging to the section it OPENS, so the
 * on-screen marker sits with the geometry it announces.
 */
export function sectionIndexByBlock(blockTypes: string[]): number[] {
  const out: number[] = [];
  let index = 0;
  for (const type of blockTypes) {
    if (type === "sectionBreak") {
      index += 1;
      out.push(index);
      continue;
    }
    out.push(index);
  }
  return out;
}

/**
 * Do any two sections differ in geometry? Documents that do not (the vast
 * majority) take the single-sheet fast path on screen.
 */
export function hasMixedGeometry(sections: DocumentSection[]): boolean {
  if (sections.length < 2) return false;
  const first = sectionGeometry(sections[0]!.setup);
  return sections.some((s) => {
    const g = sectionGeometry(s.setup);
    return (
      g.widthMm !== first.widthMm ||
      g.heightMm !== first.heightMm ||
      g.margins.top !== first.margins.top ||
      g.margins.right !== first.margins.right ||
      g.margins.bottom !== first.margins.bottom ||
      g.margins.left !== first.margins.left
    );
  });
}

const KIND_LABELS: Record<SectionBreakKind, string> = {
  nextPage: "Saut de section — page suivante",
  continuous: "Saut de section — continu",
  evenPage: "Saut de section — page paire",
  oddPage: "Saut de section — page impaire",
};

/** Human label for a section-break kind (shared by the editor and exporters). */
export function sectionBreakLabelFor(kind: unknown): string {
  return KIND_LABELS[normalizeKind(kind)];
}
