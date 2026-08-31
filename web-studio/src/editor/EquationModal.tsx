/**
 * Insert/edit an equation (Word calls this "Équation"). Minimal by design: a
 * LaTeX textarea plus a live KaTeX preview — see equationExtension.ts's module
 * header for why LaTeX-in/KaTeX-out is the whole model here.
 *
 * Reused for both actions: with no `editingPos` it inserts a new equation;
 * with one (set by clicking a rendered equation — see equationExtension.ts's
 * `onEquationEditRequest`) it updates that node in place instead.
 */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field } from "../ui/components";

const EXAMPLES = ["x^2 + y^2 = z^2", "\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}", "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}"];

export default function EquationModal({
  editor,
  editingPos,
  initialLatex,
  onClose,
}: {
  editor: Editor;
  /** Position of the equation node being edited, or undefined to insert a new one. */
  editingPos?: number;
  initialLatex?: string;
  onClose: () => void;
}) {
  const [latex, setLatex] = useState(initialLatex ?? "");
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const el = previewRef.current;
    if (!el) return;
    if (!latex.trim()) {
      el.textContent = "Aperçu…";
      return;
    }
    void import("katex")
      .then((mod) => {
        if (cancelled || !previewRef.current) return;
        const katex = mod.default ?? mod;
        katex.render(latex, previewRef.current, { throwOnError: false, displayMode: true });
      })
      .catch(() => {
        if (!cancelled && previewRef.current) previewRef.current.textContent = latex;
      });
    return () => {
      cancelled = true;
    };
  }, [latex]);

  const commit = () => {
    const trimmed = latex.trim();
    if (!trimmed) return onClose();
    if (editingPos != null) editor.chain().focus().updateEquation(editingPos, trimmed).run();
    else editor.chain().focus().insertEquation(trimmed).run();
    onClose();
  };

  return (
    <Modal
      title={editingPos != null ? "Modifier l'équation" : "Insérer une équation"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={commit}>{editingPos != null ? "Mettre à jour" : "Insérer"}</Button>
        </>
      }
    >
      <div className="settings">
        <section className="settings__section">
          <Field label="Formule (LaTeX)">
            <textarea
              className="settings__input"
              rows={3}
              value={latex}
              onChange={(e) => setLatex(e.target.value)}
              placeholder="ex. x^2 + y^2 = z^2"
              autoFocus
              spellCheck={false}
            />
          </Field>
          <div className="settings__hint" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {EXAMPLES.map((ex) => (
              <Button key={ex} type="button" variant="outline" size="sm" onClick={() => setLatex(ex)}>
                {ex}
              </Button>
            ))}
          </div>
        </section>
        <section className="settings__section">
          <h3 className="settings__title">Aperçu</h3>
          <div className="xref-preview" ref={previewRef} />
          <p className="muted">
            Repli à l'export (PDF/DOCX/Markdown) : la source LaTeX en texte, sans rendu — le document reste réédité
            correctement quand on la réimporte.
          </p>
        </section>
      </div>
    </Modal>
  );
}
