/** Volet « Accessibilité » : liste les constats de a11y.ts, avec saut vers l'élément. */
import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";
import { A11Y_RULE_LABELS, checkAccessibility, summarizeA11y, type A11yIssue } from "./a11y";
import type { ProseMirrorNode } from "../format/types";

export default function A11yPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [issues, setIssues] = useState<A11yIssue[]>([]);
  const refresh = useCallback(() => {
    if (editor.isDestroyed) return;
    setIssues(checkAccessibility(editor.getJSON() as unknown as ProseMirrorNode));
  }, [editor]);
  useEffect(() => {
    refresh();
    editor.on("update", refresh);
    return () => {
      editor.off("update", refresh);
    };
  }, [editor, refresh]);

  const jump = (i: A11yIssue) => {
    if (i.pos < 0) return;
    const size = editor.state.doc.content.size;
    const at = Math.min(i.pos + 1, size);
    editor.chain().focus().setTextSelection(at).scrollIntoView().run();
  };
  const { errors, warnings } = summarizeA11y(issues);

  return (
    <div className="proof" role="region" aria-label="Vérificateur d'accessibilité">
      <div className="proof__head">
        <span className="proof__title">Accessibilité</span>
        <button type="button" className="inspector__close" onClick={onClose} title="Fermer" aria-label="Fermer">
          <X size={14} />
        </button>
      </div>
      <div className="proof__bar">
        {issues.length === 0 ? (
          <span>
            <CheckCircle2 size={14} /> Aucun problème d'accessibilité détecté.
          </span>
        ) : (
          <span>
            {errors} erreur{errors > 1 ? "s" : ""} · {warnings} avertissement{warnings > 1 ? "s" : ""}
          </span>
        )}
      </div>
      <ul className="proof__list">
        {issues.map((i, k) => (
          <li key={k} className="proof__item">
            <button type="button" className="proof__jump" onClick={() => jump(i)} disabled={i.pos < 0}>
              {i.severity === "error" ? <XCircle size={14} /> : <AlertTriangle size={14} />}{" "}
              <strong>{A11Y_RULE_LABELS[i.rule]}</strong>
              <span className="proof__ctx">{i.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
