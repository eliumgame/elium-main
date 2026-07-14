import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { X, ArrowUp, ArrowDown, Replace, CaseSensitive, Regex } from "lucide-react";
import { searchPluginKey } from "./Search";

interface FindReplaceBarProps {
  editor: Editor;
  /** Show replace controls (hidden in read-only documents). */
  canReplace: boolean;
  /** Open directly with the replace row expanded (Ctrl+H). */
  startWithReplace?: boolean;
  onClose: () => void;
}

/**
 * Floating find & replace bar. Pushes the search term/options into the editor's
 * search plugin and reads back match counts to drive the UI. Clears the search
 * highlight on unmount.
 */
export default function FindReplaceBar({ editor, canReplace, startWithReplace, onClose }: FindReplaceBarProps) {
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(!!startWithReplace && canReplace);
  const [, forceRender] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Push the current search parameters into the plugin.
  useEffect(() => {
    editor.commands.setSearch(term, { caseSensitive, useRegex });
  }, [editor, term, caseSensitive, useRegex]);

  // Re-render whenever a transaction may have changed the match state.
  useEffect(() => {
    const onTx = () => forceRender((n) => n + 1);
    editor.on("transaction", onTx);
    return () => {
      editor.off("transaction", onTx);
    };
  }, [editor]);

  // Focus the input on open; clear the highlight when the bar closes.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      editor.commands.clearSearch();
    };
  }, [editor]);

  const s = searchPluginKey.getState(editor.state);
  const total = s?.matches.length ?? 0;
  const position = total > 0 ? (s as { current: number }).current + 1 : 0;

  const next = () => editor.commands.searchNext();
  const prev = () => editor.commands.searchPrev();

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="find-bar" role="search" aria-label="Rechercher et remplacer" onKeyDown={onKeyDown}>
      <div className="find-bar__row">
        <input
          ref={inputRef}
          className="find-bar__input"
          placeholder="Rechercher"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <span className="find-bar__count">{total > 0 ? `${position} / ${total}` : term ? "Aucun" : ""}</span>
        <button type="button" className="icon-btn" title="Précédent (Maj+Entrée)" onClick={prev} disabled={total === 0}>
          <ArrowUp size={16} />
        </button>
        <button type="button" className="icon-btn" title="Suivant (Entrée)" onClick={next} disabled={total === 0}>
          <ArrowDown size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn ${caseSensitive ? "is-active" : ""}`}
          title="Respecter la casse"
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          <CaseSensitive size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn ${useRegex ? "is-active" : ""}`}
          title="Expression régulière"
          aria-pressed={useRegex}
          onClick={() => setUseRegex((v) => !v)}
        >
          <Regex size={16} />
        </button>
        {canReplace && (
          <button
            type="button"
            className={`icon-btn ${showReplace ? "is-active" : ""}`}
            title="Remplacer"
            aria-pressed={showReplace}
            onClick={() => setShowReplace((v) => !v)}
          >
            <Replace size={16} />
          </button>
        )}
        <button type="button" className="icon-btn" title="Fermer (Échap)" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {canReplace && showReplace && (
        <div className="find-bar__row">
          <input
            className="find-bar__input"
            placeholder="Remplacer par"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <button
            type="button"
            className="eb eb--sm eb--outline"
            onClick={() => editor.commands.replaceCurrent(replacement)}
            disabled={total === 0}
          >
            Remplacer
          </button>
          <button
            type="button"
            className="eb eb--sm eb--outline"
            onClick={() => editor.commands.replaceAll(replacement)}
            disabled={total === 0}
          >
            Tout
          </button>
        </div>
      )}
    </div>
  );
}
