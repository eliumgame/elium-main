/**
 * Paragraph formatting — the rest of Word's "Paragraphe" dialog.
 *
 * What already existed: alignment, indent level, line height. What this adds:
 *   - spacing before / after the paragraph
 *   - first-line and hanging indent
 *   - pagination control: keep with next, keep lines together, page break before
 *   - paragraph borders and shading
 *
 * The attributes ride on `paragraph` and `heading` as global attributes, so they
 * round-trip inside the document JSON with no package-format change. The
 * pagination flags are read by the page planner (`Pagination.ts`), which is why
 * `paragraphPaginationFlags` is exported as a pure helper.
 */
import { Extension } from "@tiptap/core";

export const PARAGRAPH_TYPES = ["paragraph", "heading"];

export type BorderSide = "top" | "right" | "bottom" | "left";

export interface ParagraphBorders {
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
  left?: boolean;
  /** Border colour, `#rrggbb`. */
  color?: string;
  /** Border width in px. */
  width?: number;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    eliumParagraphFormat: {
      /** Space above/below in px (null clears). */
      setParagraphSpacing: (opts: { before?: number | null; after?: number | null }) => ReturnType;
      /** First-line indent in px (positive) or hanging indent (negative). */
      setFirstLineIndent: (px: number | null) => ReturnType;
      toggleKeepNext: () => ReturnType;
      toggleKeepLines: () => ReturnType;
      togglePageBreakBefore: () => ReturnType;
      setParagraphBorders: (borders: ParagraphBorders | null) => ReturnType;
      setParagraphShading: (color: string | null) => ReturnType;
    };
  }
}

const px = (v: unknown): number | null => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

/** CSS for the border attribute. */
export function bordersCss(b: ParagraphBorders | null | undefined): string {
  if (!b) return "";
  const width = Number.isFinite(Number(b.width)) && Number(b.width) > 0 ? Number(b.width) : 1;
  const color = /^#[0-9a-fA-F]{6}$/.test(String(b.color ?? "")) ? String(b.color) : "#cbd5e1";
  const rule = `${width}px solid ${color}`;
  const parts: string[] = [];
  for (const side of ["top", "right", "bottom", "left"] as BorderSide[]) {
    if (b[side]) parts.push(`border-${side}:${rule}`);
  }
  // Borders hugging the text look wrong; Word insets them too.
  if (parts.length) parts.push("padding:4px 8px");
  return parts.join(";");
}

/** Pagination hints of a paragraph, as the page planner needs them. */
export interface ParagraphPaginationFlags {
  keepNext: boolean;
  keepLines: boolean;
  pageBreakBefore: boolean;
}

export function paragraphPaginationFlags(attrs: Record<string, unknown> | undefined): ParagraphPaginationFlags {
  return {
    keepNext: attrs?.keepNext === true,
    keepLines: attrs?.keepLines === true,
    pageBreakBefore: attrs?.pageBreakBefore === true,
  };
}

export const ParagraphFormat = Extension.create({
  name: "eliumParagraphFormat",

  addGlobalAttributes() {
    return [
      {
        types: PARAGRAPH_TYPES,
        attributes: {
          spaceBefore: {
            default: null,
            parseHTML: (el: HTMLElement) => px(el.style.marginTop),
            renderHTML: (attrs: Record<string, unknown>) =>
              px(attrs.spaceBefore) != null ? { style: `margin-top:${px(attrs.spaceBefore)}px` } : {},
          },
          spaceAfter: {
            default: null,
            parseHTML: (el: HTMLElement) => px(el.style.marginBottom),
            renderHTML: (attrs: Record<string, unknown>) =>
              px(attrs.spaceAfter) != null ? { style: `margin-bottom:${px(attrs.spaceAfter)}px` } : {},
          },
          firstLineIndent: {
            default: null,
            parseHTML: (el: HTMLElement) => px(el.style.textIndent),
            renderHTML: (attrs: Record<string, unknown>) => {
              const v = px(attrs.firstLineIndent);
              if (v == null || v === 0) return {};
              // A negative value is a hanging indent: the first line pulls left,
              // so the block needs matching left padding to stay on the page.
              return v < 0
                ? { style: `text-indent:${v}px;padding-left:${Math.abs(v)}px` }
                : { style: `text-indent:${v}px` };
            },
          },
          keepNext: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute("data-keep-next") === "true" ? true : null),
            renderHTML: (attrs: Record<string, unknown>) => (attrs.keepNext ? { "data-keep-next": "true" } : {}),
          },
          keepLines: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute("data-keep-lines") === "true" ? true : null),
            renderHTML: (attrs: Record<string, unknown>) => (attrs.keepLines ? { "data-keep-lines": "true" } : {}),
          },
          pageBreakBefore: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute("data-break-before") === "true" ? true : null),
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.pageBreakBefore ? { "data-break-before": "true", style: "break-before:page" } : {},
          },
          borders: {
            default: null,
            parseHTML: () => null,
            renderHTML: (attrs: Record<string, unknown>) => {
              const css = bordersCss(attrs.borders as ParagraphBorders | null);
              return css ? { style: css } : {};
            },
          },
          shading: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.backgroundColor || null,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.shading ? { style: `background-color:${String(attrs.shading)}` } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    /** Apply attributes to whichever of paragraph / heading is active. */
    const applyToBlock =
      (attrs: Record<string, unknown>) =>
      ({
        editor,
        commands,
      }: {
        editor: import("@tiptap/core").Editor;
        commands: { updateAttributes: (t: string, a: Record<string, unknown>) => boolean };
      }) => {
        const type = editor.isActive("heading") ? "heading" : "paragraph";
        return commands.updateAttributes(type, attrs);
      };

    const toggleFlag =
      (name: string) =>
      () =>
      ({
        editor,
        commands,
      }: {
        editor: import("@tiptap/core").Editor;
        commands: { updateAttributes: (t: string, a: Record<string, unknown>) => boolean };
      }) => {
        const type = editor.isActive("heading") ? "heading" : "paragraph";
        const on = editor.getAttributes(type)[name] === true;
        return commands.updateAttributes(type, { [name]: on ? null : true });
      };

    return {
      setParagraphSpacing: (opts) =>
        applyToBlock({
          ...(opts.before !== undefined ? { spaceBefore: opts.before } : {}),
          ...(opts.after !== undefined ? { spaceAfter: opts.after } : {}),
        }),
      setFirstLineIndent: (value) => applyToBlock({ firstLineIndent: value }),
      toggleKeepNext: toggleFlag("keepNext"),
      toggleKeepLines: toggleFlag("keepLines"),
      togglePageBreakBefore: toggleFlag("pageBreakBefore"),
      setParagraphBorders: (borders) => applyToBlock({ borders }),
      setParagraphShading: (color) => applyToBlock({ shading: color }),
    };
  },
});
