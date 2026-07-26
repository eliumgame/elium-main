import { useMemo } from "react";
import type { Editor } from "@tiptap/react";
import { Modal } from "../ui/components";
import { averageSentenceLength, formatMinutes, keywords, readability, textStats } from "./stats";

/**
 * The statistics dialog — Word's word count, plus the readability and keyword
 * views that make it actually useful for drafting.
 */

/** Structural counts read straight from the document tree. */
export function structureOf(editor: Editor | null) {
  const counts = { headings: 0, tables: 0, images: 0, footnotes: 0, links: 0, lists: 0, codeBlocks: 0 };
  if (!editor) return counts;
  editor.state.doc.descendants((node) => {
    switch (node.type.name) {
      case "heading": counts.headings++; break;
      case "table": counts.tables++; break;
      case "image": case "figure": counts.images++; break;
      case "footnote": counts.footnotes++; break;
      case "bulletList": case "orderedList": case "taskList": counts.lists++; break;
      case "codeBlock": counts.codeBlocks++; break;
      default: break;
    }
    for (const mark of node.marks ?? []) if (mark.type.name === "link") counts.links++;
  });
  return counts;
}

/** Words in the current selection, or 0 when nothing is selected. */
export function selectionText(editor: Editor | null): string {
  if (!editor) return "";
  const { from, to, empty } = editor.state.selection;
  if (empty) return "";
  return editor.state.doc.textBetween(from, to, "\n", " ");
}

export default function StatsDialog({ editor, pages, onClose }: {
  editor: Editor | null;
  pages?: number;
  onClose: () => void;
}) {
  const text = editor?.state.doc.textBetween(0, editor.state.doc.content.size, "\n", " ") ?? "";
  const selection = selectionText(editor);

  const paragraphs = useMemo(() => {
    let n = 0;
    editor?.state.doc.descendants((node) => {
      if (node.type.name === "paragraph" && node.textContent.trim()) n++;
    });
    return n;
  }, [editor, text.length]);

  const stats = useMemo(() => textStats(text, paragraphs), [text, paragraphs]);
  const selStats = useMemo(() => (selection ? textStats(selection) : null), [selection]);
  const structure = useMemo(() => structureOf(editor), [editor, text.length]);
  const ease = useMemo(() => readability(text), [text]);
  const top = useMemo(() => keywords(text, 10), [text]);

  const rows: [string, string | number][] = [
    ["Mots", stats.words.toLocaleString("fr-FR")],
    ["Caractères (espaces compris)", stats.characters.toLocaleString("fr-FR")],
    ["Caractères (sans espaces)", stats.charactersNoSpaces.toLocaleString("fr-FR")],
    ["Paragraphes", stats.paragraphs.toLocaleString("fr-FR")],
    ["Phrases", stats.sentences.toLocaleString("fr-FR")],
    ["Mots par phrase", averageSentenceLength(stats)],
    ...(pages ? ([["Pages", pages]] as [string, number][]) : []),
  ];

  const structureRows: [string, number][] = [
    ["Titres", structure.headings],
    ["Tableaux", structure.tables],
    ["Images", structure.images],
    ["Notes de bas de page", structure.footnotes],
    ["Listes", structure.lists],
    ["Liens", structure.links],
    ["Blocs de code", structure.codeBlocks],
  ];

  return (
    <Modal title="Statistiques du document" onClose={onClose} wide
      footer={<button className="eb eb--primary eb--sm" onClick={onClose}>Fermer</button>}>
      <div className="doc-stats">
        <section>
          <h4>Volume</h4>
          <dl className="elx-facts">
            {rows.map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
          {selStats && (
            <p className="elx-form__note">
              Sélection : <b>{selStats.words}</b> mot{selStats.words > 1 ? "s" : ""},{" "}
              <b>{selStats.characters}</b> caractères.
            </p>
          )}
        </section>

        <section>
          <h4>Temps</h4>
          <dl className="elx-facts">
            <div><dt>Lecture</dt><dd>{formatMinutes(stats.readingMinutes)}</dd></div>
            <div><dt>À voix haute</dt><dd>{formatMinutes(stats.speakingMinutes)}</dd></div>
          </dl>
        </section>

        <section>
          <h4>Lisibilité</h4>
          <div className="doc-stats__gauge">
            <span style={{ width: `${ease.score}%` }} />
          </div>
          <p className="elx-form__note">
            Indice Kandel-Moles : <b>{ease.score}/100</b> — {ease.label}.
            {" "}Plus l'indice est élevé, plus le texte se lit facilement.
          </p>
        </section>

        <section>
          <h4>Structure</h4>
          <dl className="elx-facts">
            {structureRows.map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        </section>

        {top.length > 0 && (
          <section>
            <h4>Mots les plus fréquents</h4>
            <div className="elx-chips">
              {top.map((k) => (
                <span key={k.word} className="elx-chip">{k.word} <b>{k.count}</b></span>
              ))}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
