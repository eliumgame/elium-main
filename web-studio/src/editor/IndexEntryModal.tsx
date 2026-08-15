import { useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field } from "../ui/components";
import { indexTerms } from "./indexing";
import type { ProseMirrorNode } from "../format/types";

/**
 * Mark an index entry (Word's "Marquer une entrée d'index").
 *
 * The selected text pre-fills the term, existing terms are offered for
 * completion so the index does not fragment into near-duplicates, and
 * "Marquer tout" marks every other occurrence of the term in the document.
 */
export default function IndexEntryModal({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const selection = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, " ").trim();
  const known = useMemo(() => indexTerms(editor.getJSON() as ProseMirrorNode), [editor]);
  const [term, setTerm] = useState(selection);
  const [sub, setSub] = useState("");
  const [markedAll, setMarkedAll] = useState<number | null>(null);

  const clean = term.replace(/\s+/g, " ").trim();

  const markOne = () => {
    if (!clean) return;
    editor.chain().focus().insertIndexEntry({ term: clean, sub: sub.trim() }).run();
    onClose();
  };

  /** Mark every occurrence of the term: one entry right after each match. */
  const markAll = () => {
    if (!clean) return;
    const needle = clean.toLowerCase();
    const hits: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return true;
      const haystack = node.text.toLowerCase();
      let at = haystack.indexOf(needle);
      while (at !== -1) {
        hits.push(pos + at + clean.length);
        at = haystack.indexOf(needle, at + needle.length);
      }
      return true;
    });
    if (!hits.length) {
      setMarkedAll(0);
      return;
    }
    const type = editor.state.schema.nodes.indexEntry;
    if (!type) return;
    const tr = editor.state.tr;
    // Insert from the end so earlier positions stay valid.
    for (const at of hits.sort((a, b) => b - a)) {
      tr.insert(at, type.create({ term: clean, sub: sub.trim() }));
    }
    editor.view.dispatch(tr);
    setMarkedAll(hits.length);
  };

  return (
    <Modal
      title="Marquer une entrée d'index"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Fermer
          </Button>
          <Button variant="outline" onClick={markAll} disabled={!clean}>
            Marquer tout
          </Button>
          <Button onClick={markOne} disabled={!clean}>
            Marquer
          </Button>
        </>
      }
    >
      <div className="settings">
        <section className="settings__section">
          <Field label="Entrée principale" hint="Les variantes de casse et d'accent sont regroupées automatiquement.">
            <input
              className="settings__input"
              list="elium-index-terms"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="ex. Chiffrement"
              autoFocus
            />
          </Field>
          <datalist id="elium-index-terms">
            {known.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <Field label="Sous-entrée (facultatif)">
            <input
              className="settings__input"
              value={sub}
              onChange={(e) => setSub(e.target.value)}
              placeholder="ex. AES-256"
            />
          </Field>
        </section>

        <section className="settings__section">
          <p className="muted">
            La marque reste visible pendant l'édition mais ne s'imprime pas. Insérez le bloc « Index » depuis l'onglet
            Insertion pour voir la liste alphabétique avec ses numéros de page.
          </p>
          {markedAll != null && (
            <p className="muted">
              {markedAll === 0
                ? `Aucune occurrence de « ${clean} » trouvée.`
                : `${markedAll} occurrence${markedAll > 1 ? "s" : ""} marquée${markedAll > 1 ? "s" : ""}.`}
            </p>
          )}
        </section>
      </div>
    </Modal>
  );
}
