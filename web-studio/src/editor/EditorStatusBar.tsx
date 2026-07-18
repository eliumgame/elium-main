import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { PageInfo } from "./Pagination";

/** Counts words in a plain-text string (whitespace-separated, Unicode-friendly). */
function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

interface Stats {
  words: number;
  chars: number;
  selWords: number;
  selChars: number;
}

/**
 * Bottom status bar showing live word/character counts for the whole document,
 * and for the current selection when there is one. Read-only friendly.
 */
export default function EditorStatusBar({ editor, pageInfo }: { editor: Editor | null; pageInfo?: PageInfo }) {
  const [stats, setStats] = useState<Stats>({ words: 0, chars: 0, selWords: 0, selChars: 0 });

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const text = editor.getText({ blockSeparator: "\n" });
      const { from, to, empty } = editor.state.selection;
      let selWords = 0;
      let selChars = 0;
      if (!empty) {
        const selText = editor.state.doc.textBetween(from, to, "\n", " ");
        selChars = selText.length;
        selWords = countWords(selText);
      }
      setStats({ words: countWords(text), chars: text.length, selWords, selChars });
    };
    update();
    editor.on("update", update);
    editor.on("selectionUpdate", update);
    return () => {
      editor.off("update", update);
      editor.off("selectionUpdate", update);
    };
  }, [editor]);

  if (!editor) return null;
  const plural = (n: number) => (n > 1 ? "s" : "");
  const hasSel = stats.selChars > 0;

  return (
    <div className="editor-statusbar" role="status" aria-live="polite">
      {pageInfo && (
        <>
          <span>
            Page {pageInfo.currentPage.toLocaleString("fr-FR")} sur {pageInfo.pageCount.toLocaleString("fr-FR")}
          </span>
          <span className="editor-statusbar__sep">·</span>
        </>
      )}
      <span>{stats.words.toLocaleString("fr-FR")} mot{plural(stats.words)}</span>
      <span className="editor-statusbar__sep">·</span>
      <span>{stats.chars.toLocaleString("fr-FR")} caractère{plural(stats.chars)}</span>
      {hasSel && (
        <span className="editor-statusbar__sel">
          sélection : {stats.selWords.toLocaleString("fr-FR")} mot{plural(stats.selWords)} ·{" "}
          {stats.selChars.toLocaleString("fr-FR")} car.
        </span>
      )}
    </div>
  );
}
