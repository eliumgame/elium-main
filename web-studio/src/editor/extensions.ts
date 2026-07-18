/**
 * TipTap extension set for the Elium rich editor.
 *
 * StarterKit (v3) already bundles bold/italic/strike/code/heading/lists/
 * blockquote/HR/underline/link/history, so we only add what's missing and
 * disable StarterKit's plain code block in favour of syntax-highlighted blocks.
 */

import StarterKit from "@tiptap/starter-kit";
import { TextAlign } from "@tiptap/extension-text-align";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { TextStyle, Color, FontFamily, FontSize, LineHeight } from "@tiptap/extension-text-style";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import type { Extensions } from "@tiptap/react";
import { Indent, PageBreak, TableOfContents, Figure, Comment, Footnote, FootnotesList, ParagraphStyle, Bookmark } from "./customExtensions";
import { BUILTIN_FONTS } from "../ui/fonts";
import { Search } from "./Search";
import { Insertion, Deletion, TrackChanges } from "./TrackChanges";
import { Pagination, type PaginationOptions } from "./Pagination";

const lowlight = createLowlight(common);

export function buildExtensions(
  opts: {
    editable: boolean;
    author?: string;
    /** For the collaborative (Yjs) variant: disable StarterKit's own undo/redo
     *  so history is owned by the CRDT (Collaboration provides undo/redo). */
    disableHistory?: boolean;
    /** Extra extensions appended (e.g. Collaboration + CollaborationCaret).
     *  Kept as a param so Yjs never enters the main non-collaborative bundle. */
    extra?: Extensions;
    /** On-screen pagination (page sheets + live page count). Document editor only. */
    pagination?: PaginationOptions;
  } = { editable: true },
): Extensions {
  return [
    StarterKit.configure({
      codeBlock: false, // replaced by CodeBlockLowlight
      heading: { levels: [1, 2, 3, 4] },
      link: { openOnClick: !opts.editable, autolink: true },
      ...(opts.disableHistory ? { undoRedo: false as const } : {}),
    }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    LineHeight,
    Indent,
    ParagraphStyle,
    PageBreak,
    TableOfContents,
    Figure,
    Footnote,
    FootnotesList,
    Bookmark,
    Comment,
    Insertion,
    Deletion,
    TrackChanges.configure({ author: opts.author ?? "" }),
    Search,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Image.configure({ inline: false, allowBase64: true }),
    TableKit.configure({ table: { resizable: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: "plaintext" }),
    Placeholder.configure({
      placeholder: "Rédigez votre document… Utilisez la barre d'outils pour la mise en forme.",
    }),
    ...(opts.pagination ? [Pagination.configure(opts.pagination)] : []),
    ...(opts.extra ?? []),
  ];
}

export const CODE_LANGUAGES = [
  "plaintext",
  "javascript",
  "typescript",
  "python",
  "json",
  "bash",
  "html",
  "css",
  "sql",
  "markdown",
];

// Unified with the app-wide font registry (same families everywhere + imports).
export const FONT_FAMILIES = [
  { label: "Par défaut", value: "" },
  ...BUILTIN_FONTS.map((f) => ({ label: f.name, value: f.css })),
];

export const FONT_SIZES = ["8px", "9px", "10px", "11px", "12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px", "40px", "48px", "64px"];

export const LINE_HEIGHTS = [
  { label: "Simple", value: "1.3" },
  { label: "1,5", value: "1.6" },
  { label: "Double", value: "2.1" },
];
