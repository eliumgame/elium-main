/**
 * Le volet du correcteur : la liste des problèmes, avec correction en un clic.
 *
 * Chaque entrée applique sa suggestion **par position dans le document**, pas par
 * recherche-remplacement du texte : deux fautes identiques dans deux paragraphes
 * doivent se corriger séparément, et un remplacement global corrigerait les deux.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Check, EyeOff, BookPlus, X, Upload } from "lucide-react";
import { Button } from "../ui/components";
import { ISSUE_LABELS, parseDictionary, summarize, type IssueKind } from "./proofing";
import {
  addToPersonal, collectIssues, ignoreWord, onProofingChange, proofingSettings, setDictionary,
  setProofingEnabled, type DocIssue,
} from "./proofingExtension";

export default function ProofingPanel({
  editor,
  onClose,
}: {
  editor: Editor;
  onClose: () => void;
}) {
  const [issues, setIssues] = useState<DocIssue[]>([]);
  const [settings, setSettings] = useState(() => proofingSettings());

  const refresh = useCallback(() => {
    if (editor.isDestroyed) return;
    setIssues(collectIssues(editor.state.doc as never));
    setSettings(proofingSettings());
  }, [editor]);

  useEffect(() => {
    refresh();
    editor.on("update", refresh);
    // Les réglages vivent hors du document : sans cet abonnement, charger un
    // dictionnaire ne rafraîchirait la liste qu'à la frappe suivante.
    const stop = onProofingChange(refresh);
    return () => {
      editor.off("update", refresh);
      stop();
    };
  }, [editor, refresh]);

  /** Applique une suggestion à la position exacte du problème. */
  const apply = useCallback(
    (issue: DocIssue, suggestion: string) => {
      editor
        .chain()
        .focus()
        .insertContentAt({ from: issue.docFrom, to: issue.docTo }, suggestion)
        .run();
    },
    [editor],
  );

  const jump = useCallback(
    (issue: DocIssue) => {
      editor.chain().focus().setTextSelection({ from: issue.docFrom, to: issue.docTo }).scrollIntoView().run();
    },
    [editor],
  );

  const importDictionary = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const raw = await file.text();
    setDictionary(parseDictionary(raw));
  }, []);

  const grouped = useMemo(() => {
    const by = new Map<IssueKind, DocIssue[]>();
    for (const i of issues) {
      const list = by.get(i.kind) ?? [];
      list.push(i);
      by.set(i.kind, list);
    }
    return [...by.entries()];
  }, [issues]);

  return (
    <div className="proof">
      <div className="proof__head">
        <span className="proof__title">Correcteur</span>
        <button type="button" className="inspector__close" onClick={onClose} title="Fermer" aria-label="Fermer">
          <X size={14} />
        </button>
      </div>

      <div className="proof__bar">
        <label className="proof__toggle">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => setProofingEnabled(e.target.checked)}
          />
          Correction active
        </label>
        <label className="proof__import" title="Charger une liste de mots ou un fichier .dic">
          <Upload size={13} />
          Dictionnaire
          <input type="file" accept=".dic,.txt,.lst,text/plain" onChange={importDictionary} hidden />
        </label>
      </div>

      {!settings.hasDictionary && (
        <p className="proof__hint">
          L'orthographe est vérifiée par le correcteur du navigateur (soulignement rouge natif).
          Chargez un dictionnaire pour que Elium signale aussi les mots inconnus dans cette liste.
        </p>
      )}

      <div className="proof__count">{summarize(issues)}</div>

      {!issues.length && <div className="proof__empty">Rien à signaler dans ce document.</div>}

      {grouped.map(([kind, list]) => (
        <section key={kind} className="proof__group">
          <div className="proof__group-title">
            {ISSUE_LABELS[kind]} <span className="proof__badge">{list.length}</span>
          </div>
          {list.map((issue) => (
            <div key={`${issue.docFrom}-${issue.kind}`} className="proof__item">
              <button type="button" className="proof__snippet" onClick={() => jump(issue)} title={issue.message}>
                {issue.text.replace(/\s+/g, "␣")}
              </button>
              <div className="proof__actions">
                {issue.suggestions.slice(0, 3).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="proof__fix"
                    onClick={() => apply(issue, s)}
                    title={`Remplacer par « ${s.replace(/\s+/g, "␣")} »`}
                  >
                    <Check size={12} /> {s.replace(/\s+/g, "␣")}
                  </button>
                ))}
                {issue.kind === "unknown-word" && (
                  <>
                    <button
                      type="button"
                      className="proof__ghost"
                      onClick={() => addToPersonal(issue.text)}
                      title="Ajouter au dictionnaire personnel"
                    >
                      <BookPlus size={12} /> Ajouter
                    </button>
                    <button
                      type="button"
                      className="proof__ghost"
                      onClick={() => ignoreWord(issue.text)}
                      title="Ignorer ce mot pour cette session"
                    >
                      <EyeOff size={12} /> Ignorer
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </section>
      ))}

      <div className="proof__foot">
        <Button variant="ghost" onClick={refresh}>Réanalyser</Button>
      </div>
    </div>
  );
}
