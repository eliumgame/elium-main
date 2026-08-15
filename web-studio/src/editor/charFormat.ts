/**
 * Character formatting — the rest of Word's "Police" dialog.
 *
 * What already existed: bold, italic, underline, strike, highlight, colour, font
 * family and size. What this module adds:
 *   - superscript / subscript (own marks, mutually exclusive)
 *   - small caps, all caps
 *   - underline STYLE (double, dotted, dashed, wavy) and double strikethrough
 *   - character spacing (expanded / condensed) and raised / lowered position
 *   - change case, clear formatting, grow / shrink font
 *
 * The visual variants ride as attributes on the existing `textStyle` mark rather
 * than as a mark each, so a run keeps ONE mark carrying all of its typography and
 * the document JSON stays small.
 *
 * The case transformer and the size stepper are pure, so they are unit-tested.
 */
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { FONT_SIZES } from "./typography";

// =========================================================================
// Pure helpers
// =========================================================================

export type CaseMode = "upper" | "lower" | "sentence" | "title" | "toggle";

export const CASE_LABELS: Record<CaseMode, string> = {
  sentence: "Majuscule en début de phrase",
  lower: "minuscules",
  upper: "MAJUSCULES",
  title: "Chaque Mot En Majuscule",
  toggle: "iNVERSER LA cASSE",
};

/** Uppercase the first letter of each sentence, lowercase the rest. */
function toSentenceCase(text: string): string {
  const lower = text.toLocaleLowerCase("fr");
  // A sentence starts at the beginning or after . ! ? … followed by space(s).
  return lower.replace(/(^\s*|[.!?…]\s+)(\p{L})/gu, (_, lead: string, ch: string) => lead + ch.toLocaleUpperCase("fr"));
}

function toTitleCase(text: string): string {
  return (
    text
      .toLocaleLowerCase("fr")
      // Word capitalises after any non-letter, apostrophes and hyphens included.
      .replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, lead: string, ch: string) => lead + ch.toLocaleUpperCase("fr"))
  );
}

function toToggleCase(text: string): string {
  let out = "";
  for (const ch of text) {
    const upper = ch.toLocaleUpperCase("fr");
    out += ch === upper ? ch.toLocaleLowerCase("fr") : upper;
  }
  return out;
}

/** Apply a case mode to a string. Pure. */
export function transformCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case "upper":
      return text.toLocaleUpperCase("fr");
    case "lower":
      return text.toLocaleLowerCase("fr");
    case "sentence":
      return toSentenceCase(text);
    case "title":
      return toTitleCase(text);
    case "toggle":
      return toToggleCase(text);
    default:
      return text;
  }
}

/** Numeric px sizes offered by the size picker, ascending. */
const SIZE_STEPS: number[] = FONT_SIZES.map((s) => parseFloat(s))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);

export const DEFAULT_FONT_SIZE_PX = 16;

/**
 * Next size up or down, following the picker's steps then falling back to a
 * proportional step so the buttons never dead-end.
 */
export function stepFontSize(currentPx: number | null, direction: 1 | -1): number {
  const current = Number.isFinite(currentPx) && currentPx ? Number(currentPx) : DEFAULT_FONT_SIZE_PX;
  if (direction > 0) {
    const next = SIZE_STEPS.find((s) => s > current + 0.01);
    return Math.min(400, next ?? Math.round(current * 1.15));
  }
  const prev = [...SIZE_STEPS].reverse().find((s) => s < current - 0.01);
  return Math.max(4, prev ?? Math.max(4, Math.round(current / 1.15)));
}

/** Parse a CSS length like "14px" into a number of px. */
export function parsePx(value: unknown): number | null {
  const n = parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : null;
}

export type UnderlineStyle = "single" | "double" | "dotted" | "dashed" | "wavy" | "none";

export const UNDERLINE_LABELS: Record<UnderlineStyle, string> = {
  none: "Aucun",
  single: "Simple",
  double: "Double",
  dotted: "Pointillé",
  dashed: "Tirets",
  wavy: "Ondulé",
};

/** CSS for an underline style, as applied to the `textStyle` mark. */
export function underlineCss(style: UnderlineStyle): string {
  if (style === "none") return "";
  const line = style === "double" ? "double" : style === "single" ? "solid" : style;
  return `text-decoration-line:underline;text-decoration-style:${line}`;
}

// =========================================================================
// Marks: superscript / subscript
// =========================================================================

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    eliumCharFormat: {
      toggleSuperscript: () => ReturnType;
      toggleSubscript: () => ReturnType;
      toggleSmallCaps: () => ReturnType;
      toggleAllCaps: () => ReturnType;
      toggleDoubleStrike: () => ReturnType;
      setUnderlineStyle: (style: UnderlineStyle) => ReturnType;
      /** Letter spacing in px (0 = normal). */
      setLetterSpacing: (px: number) => ReturnType;
      /** Baseline offset in px (positive = raised). */
      setTextPosition: (px: number) => ReturnType;
      /** Rewrite the selected text in the given case. */
      changeCase: (mode: CaseMode) => ReturnType;
      /** Drop every character-level mark from the selection. */
      clearCharFormatting: () => ReturnType;
      growFontSize: () => ReturnType;
      shrinkFontSize: () => ReturnType;
    };
  }
}

export const Superscript = Mark.create({
  name: "superscript",
  excludes: "subscript",
  parseHTML() {
    return [{ tag: "sup" }, { style: "vertical-align=super" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(HTMLAttributes), 0];
  },
});

export const Subscript = Mark.create({
  name: "subscript",
  excludes: "superscript",
  parseHTML() {
    return [{ tag: "sub" }, { style: "vertical-align=sub" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sub", mergeAttributes(HTMLAttributes), 0];
  },
});

// =========================================================================
// Typography attributes on `textStyle`
// =========================================================================

/** Marks removed by "clear formatting" (block type and structure are kept). */
const CHAR_MARKS = [
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "highlight",
  "textStyle",
  "superscript",
  "subscript",
];

export const CharFormat = Extension.create({
  name: "eliumCharFormat",

  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          smallCaps: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.style.fontVariantCaps === "small-caps" ? true : null),
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.smallCaps ? { style: "font-variant-caps:small-caps" } : {},
          },
          allCaps: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.style.textTransform === "uppercase" ? true : null),
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.allCaps ? { style: "text-transform:uppercase" } : {},
          },
          doubleStrike: {
            default: null,
            parseHTML: (el: HTMLElement) =>
              el.style.textDecorationStyle === "double" && el.style.textDecorationLine.includes("line-through")
                ? true
                : null,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.doubleStrike ? { style: "text-decoration-line:line-through;text-decoration-style:double" } : {},
          },
          underlineStyle: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.textDecorationStyle || null,
            renderHTML: (attrs: Record<string, unknown>) => {
              const css = underlineCss(String(attrs.underlineStyle ?? "none") as UnderlineStyle);
              return css ? { style: css } : {};
            },
          },
          letterSpacing: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.letterSpacing || null,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.letterSpacing ? { style: `letter-spacing:${attrs.letterSpacing}` } : {},
          },
          textPosition: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.verticalAlign || null,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.textPosition ? { style: `vertical-align:${attrs.textPosition}` } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    /** Toggle a boolean textStyle attribute. */
    const toggleAttr =
      (name: string) =>
      () =>
      ({
        editor,
        commands,
      }: {
        editor: import("@tiptap/core").Editor;
        commands: { setMark: (n: string, a: Record<string, unknown>) => boolean };
      }) => {
        const on = editor.getAttributes("textStyle")[name] === true;
        return commands.setMark("textStyle", { [name]: on ? null : true });
      };

    return {
      toggleSuperscript:
        () =>
        ({ commands }) =>
          commands.toggleMark("superscript"),
      toggleSubscript:
        () =>
        ({ commands }) =>
          commands.toggleMark("subscript"),
      toggleSmallCaps: toggleAttr("smallCaps"),
      toggleAllCaps: toggleAttr("allCaps"),
      toggleDoubleStrike: toggleAttr("doubleStrike"),

      setUnderlineStyle:
        (style) =>
        ({ chain }) =>
          // "none" removes the underline entirely; any other style implies one.
          style === "none"
            ? chain().setMark("textStyle", { underlineStyle: null }).unsetMark("underline").run()
            : chain().setMark("textStyle", { underlineStyle: style }).setMark("underline").run(),

      setLetterSpacing:
        (px) =>
        ({ commands }) =>
          commands.setMark("textStyle", { letterSpacing: px ? `${px}px` : null }),

      setTextPosition:
        (px) =>
        ({ commands }) =>
          commands.setMark("textStyle", { textPosition: px ? `${px}px` : null }),

      clearCharFormatting:
        () =>
        ({ state, tr, dispatch }) => {
          const { from, to, empty } = state.selection;
          if (empty) return false;
          if (!dispatch) return true;
          for (const name of CHAR_MARKS) {
            const type = state.schema.marks[name];
            if (type) tr.removeMark(from, to, type);
          }
          dispatch(tr);
          return true;
        },

      changeCase:
        (mode) =>
        ({ state, tr, dispatch }) => {
          const { from, to, empty } = state.selection;
          if (empty) return false;
          // Collect first, rewrite back-to-front so earlier positions stay valid.
          const edits: { from: number; to: number; text: string }[] = [];
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isText || node.text == null) return true;
            const start = Math.max(pos, from);
            const end = Math.min(pos + node.nodeSize, to);
            if (end <= start) return true;
            const slice = node.text.slice(start - pos, end - pos);
            const next = transformCase(slice, mode);
            if (next !== slice) edits.push({ from: start, to: end, text: next });
            return true;
          });
          if (!edits.length) return false;
          if (!dispatch) return true;
          for (const edit of edits.reverse()) {
            const marks = state.doc.resolve(edit.from).marks();
            tr.replaceWith(edit.from, edit.to, state.schema.text(edit.text, marks));
          }
          dispatch(tr);
          return true;
        },

      growFontSize:
        () =>
        ({ editor, commands }) =>
          commands.setMark("textStyle", {
            fontSize: `${stepFontSize(parsePx(editor.getAttributes("textStyle").fontSize), 1)}px`,
          }),

      shrinkFontSize:
        () =>
        ({ editor, commands }) =>
          commands.setMark("textStyle", {
            fontSize: `${stepFontSize(parsePx(editor.getAttributes("textStyle").fontSize), -1)}px`,
          }),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Word's own shortcuts.
      "Mod-Shift-=": () => this.editor.commands.toggleSuperscript(),
      "Mod-=": () => this.editor.commands.toggleSubscript(),
      "Mod-Shift-k": () => this.editor.commands.toggleSmallCaps(),
      "Mod-Shift->": () => this.editor.commands.growFontSize(),
      "Mod-Shift-<": () => this.editor.commands.shrinkFontSize(),
      "Mod-Space": () => this.editor.commands.clearCharFormatting(),
    };
  },
});
