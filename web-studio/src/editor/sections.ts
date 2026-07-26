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

import type { PageSettings, ProseMirrorNode } from "../format/types";

export type SectionBreakKind = "nextPage" | "continuous" | "evenPage" | "oddPage";

export interface SectionSetup {
  kind: SectionBreakKind;
  orientation: "portrait" | "landscape";
  header: string;
  footer: string;
  restartNumbering: boolean;
  startAt: number;
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

function setupFrom(attrs: Record<string, unknown> | undefined, page: PageSettings): SectionSetup {
  const a = attrs ?? {};
  const orientation = a.orientation === "landscape" || a.orientation === "portrait" ? a.orientation : page.orientation;
  const startAt = Math.max(1, Math.round(Number(a.startAt) || 1));
  return {
    kind: normalizeKind(a.kind),
    orientation,
    header: typeof a.header === "string" && a.header ? a.header : page.header ?? "",
    footer: typeof a.footer === "string" && a.footer ? a.footer : page.footer ?? "",
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
      orientation: page.orientation,
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
