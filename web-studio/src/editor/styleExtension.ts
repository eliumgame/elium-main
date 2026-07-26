/**
 * The TipTap side of named styles.
 *
 * A paragraph or heading remembers WHICH style it uses (`styleId`); applying a
 * style sets the block type, the paragraph attributes and the character marks in
 * one command. A character style is applied as a `styleId` attribute on the
 * `textStyle` mark plus the marks it implies.
 *
 * The style SET is supplied by the editor through `setStyleRegistry`, because the
 * document carries its own styles and they can change at runtime (the manager
 * edits them). Keeping it out of the extension's options avoids rebuilding the
 * whole editor whenever a style is modified.
 */
import { Extension } from "@tiptap/core";
import {
  BUILTIN_STYLES, mergeStyles, resolveStyle, styleAttrs, styleMarks, styleTextStyleAttrs,
  type DocStyle,
} from "./styles";

let registry: DocStyle[] = BUILTIN_STYLES;

/** Publish the document's effective style set (built-ins + its own). */
export function setStyleRegistry(custom: DocStyle[] | undefined): void {
  registry = mergeStyles(custom);
}
export function styleRegistry(): DocStyle[] {
  return registry;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    eliumStyles: {
      /** Apply a named style (paragraph or character) to the selection. */
      applyNamedStyle: (styleId: string) => ReturnType;
      /** Drop the style link, keeping the formatting as-is. */
      clearNamedStyle: () => ReturnType;
    };
  }
}

export const NamedStyles = Extension.create({
  name: "eliumStyles",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          styleId: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-style-id") || null,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.styleId ? { "data-style-id": String(attrs.styleId) } : {},
          },
        },
      },
      {
        types: ["textStyle"],
        attributes: {
          styleId: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-style-id") || null,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.styleId ? { "data-style-id": String(attrs.styleId) } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      applyNamedStyle:
        (styleId) =>
        ({ chain }) => {
          const style = resolveStyle(registry, styleId);
          if (!style) return false;
          const marks = styleMarks(style);

          if (style.kind === "character") {
            // A character style only touches the run.
            const c = chain().focus().setMark("textStyle", { ...styleTextStyleAttrs(style), styleId });
            if (marks.bold) c.setBold(); else c.unsetBold();
            if (marks.italic) c.setItalic(); else c.unsetItalic();
            if (marks.underline) c.setUnderline(); else c.unsetUnderline();
            if (marks.strike) c.setStrike(); else c.unsetStrike();
            if (marks.highlight) c.setHighlight({ color: marks.highlight });
            else c.unsetHighlight();
            return c.run();
          }

          const c = chain().focus();
          // Block type first, so the attributes land on the right node type.
          if (style.block?.type === "heading") c.setHeading({ level: (style.block.level ?? 1) as 1 | 2 | 3 | 4 });
          else c.setParagraph();
          const attrs = styleAttrs(style);
          c.updateAttributes(style.block?.type === "heading" ? "heading" : "paragraph", attrs);
          // The character part of a paragraph style restyles the WHOLE paragraph,
          // as in Word — with a collapsed cursor `setMark` would only arm the
          // stored marks for the next keystroke and leave the existing text as it
          // was. So the marks are applied over the block's own range.
          c.command(({ tr, state, dispatch }) => {
            if (!dispatch) return true;
            const $from = tr.doc.resolve(Math.min(state.selection.from, tr.doc.content.size));
            const depth = $from.depth;
            const from = state.selection.empty ? $from.start(depth) : state.selection.from;
            const to = state.selection.empty ? $from.end(depth) : state.selection.to;
            if (to <= from) return true;
            const schema = state.schema;
            const textStyle = schema.marks.textStyle;
            if (textStyle) {
              // Re-create the mark rather than merging: a style defines its
              // typography outright, so leftovers from the previous style go.
              tr.removeMark(from, to, textStyle);
              const attrsForMark = styleTextStyleAttrs(style);
              const any = Object.values(attrsForMark).some((v) => v != null);
              if (any) tr.addMark(from, to, textStyle.create(attrsForMark));
            }
            const toggles: [string, boolean][] = [
              ["bold", marks.bold],
              ["italic", marks.italic],
              ["underline", marks.underline],
              ["strike", marks.strike],
            ];
            for (const [name, on] of toggles) {
              const type = schema.marks[name];
              if (!type) continue;
              if (on) tr.addMark(from, to, type.create());
              else tr.removeMark(from, to, type);
            }
            const highlight = schema.marks.highlight;
            if (highlight) {
              tr.removeMark(from, to, highlight);
              if (marks.highlight) tr.addMark(from, to, highlight.create({ color: marks.highlight }));
            }
            return true;
          });
          return c.run();
        },

      clearNamedStyle:
        () =>
        ({ editor, commands }) => {
          const type = editor.isActive("heading") ? "heading" : "paragraph";
          return commands.updateAttributes(type, { styleId: null });
        },
    };
  },
});
