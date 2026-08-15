/**
 * La boîte « Symbole », comme celle de Word : des groupes, une recherche, et une
 * grille cliquable. Le dialogue ne se ferme pas à chaque insertion — on vient
 * souvent y chercher plusieurs caractères de suite.
 */
import { useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button } from "../ui/components";
import { SYMBOL_GROUPS, findSymbols, isInvisible, symbolName, symbolsOf } from "./ornaments";

export default function SymbolModal({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [group, setGroup] = useState<string>(SYMBOL_GROUPS[0]!.id);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);

  const chars = useMemo(() => (query.trim() ? findSymbols(query) : symbolsOf(group)), [group, query]);

  const insert = (ch: string) => {
    editor.chain().focus().insertSymbol(ch).run();
    // Les derniers utilisés remontent : c'est le raccourci qui sert le plus.
    setRecent((prev) => [ch, ...prev.filter((c) => c !== ch)].slice(0, 12));
  };

  return (
    <Modal title="Insérer un symbole" onClose={onClose} wide footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="symdlg">
        <div className="symdlg__bar">
          <input
            className="settings__input"
            placeholder="Rechercher (nom ou U+00E9)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Rechercher un symbole"
          />
          <select
            className="settings__select"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            disabled={Boolean(query.trim())}
            aria-label="Groupe de symboles"
          >
            {SYMBOL_GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </div>

        {recent.length > 0 && !query.trim() && (
          <>
            <div className="symdlg__label">Récents</div>
            <div className="symdlg__grid">
              {recent.map((ch) => (
                <button
                  key={`r${ch}`}
                  type="button"
                  className={`symdlg__cell${isInvisible(ch) ? " is-invisible" : ""}`}
                  onClick={() => insert(ch)}
                  title={symbolName(ch)}
                >
                  {isInvisible(ch) ? "␣" : ch}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="symdlg__label">
          {query.trim() ? `${chars.length} résultat${chars.length > 1 ? "s" : ""}` : "Symboles"}
        </div>
        <div className="symdlg__grid symdlg__grid--main">
          {chars.map((ch) => (
            <button
              key={ch}
              type="button"
              className={`symdlg__cell${isInvisible(ch) ? " is-invisible" : ""}`}
              onClick={() => insert(ch)}
              title={symbolName(ch)}
            >
              {isInvisible(ch) ? "␣" : ch}
            </button>
          ))}
          {!chars.length && <div className="symdlg__empty">Aucun symbole pour cette recherche.</div>}
        </div>

        <p className="settings__hint">Le dialogue reste ouvert : insérez autant de symboles que nécessaire.</p>
      </div>
    </Modal>
  );
}
