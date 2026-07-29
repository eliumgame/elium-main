/**
 * Le menu de correction au clic droit.
 *
 * C'est le geste que tout le monde connaît : clic droit sur un mot souligné, la
 * bonne orthographe en tête de liste, un clic et c'est corrigé. Le volet du
 * correcteur reste utile pour une relecture d'ensemble ; ce menu est pour la faute
 * qu'on voit en écrivant.
 *
 * Il remplace le menu du navigateur (voir `handleDOMEvents.contextmenu`) : laisser
 * les deux se superposer aurait proposé les suggestions d'un autre dictionnaire que
 * celui du document.
 */
import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { BookPlus, Check, EyeOff } from "lucide-react";
import { ISSUE_LABELS } from "./proofing";
import { addToPersonal, ignoreWord, type ProofRequest } from "./proofingExtension";

export default function ProofPopover({
  editor,
  request,
  onClose,
}: {
  editor: Editor;
  request: ProofRequest;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // `capture` : un clic dans l'éditeur doit fermer le menu avant que
    // ProseMirror ne déplace la sélection sous lui.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const { issue } = request;

  /** Remplace à la POSITION du problème, pas par recherche-remplacement. */
  const apply = (replacement: string) => {
    editor
      .chain()
      .focus()
      .insertContentAt({ from: issue.docFrom, to: issue.docTo }, replacement)
      .run();
    onClose();
  };

  // Le menu est posé en coordonnées de fenêtre, puis ramené dans l'écran : ouvert
  // près du bord droit, il sortirait sinon de la vue.
  const style: React.CSSProperties = {
    left: Math.min(request.x, Math.max(8, window.innerWidth - 260)),
    top: Math.min(request.y, Math.max(8, window.innerHeight - 220)),
  };

  return (
    <div className="proofpop" ref={ref} style={style} role="menu">
      <div className="proofpop__head">
        <span className="proofpop__kind">{ISSUE_LABELS[issue.kind]}</span>
        <span className="proofpop__word">{issue.text.replace(/\s+/g, "␣")}</span>
      </div>

      {issue.suggestions.length > 0 ? (
        issue.suggestions.slice(0, 6).map((s) => (
          <button
            key={s}
            type="button"
            className="proofpop__item proofpop__item--fix"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => apply(s)}
          >
            <Check size={13} /> {s.replace(/\s+/g, "␣")}
          </button>
        ))
      ) : (
        <div className="proofpop__empty">Aucune correction proposée</div>
      )}

      {issue.kind === "unknown-word" && (
        <>
          <div className="proofpop__sep" />
          <button
            type="button"
            className="proofpop__item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              addToPersonal(issue.text);
              onClose();
            }}
          >
            <BookPlus size={13} /> Ajouter au dictionnaire
          </button>
          <button
            type="button"
            className="proofpop__item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              ignoreWord(issue.text);
              onClose();
            }}
          >
            <EyeOff size={13} /> Ignorer partout
          </button>
        </>
      )}
    </div>
  );
}
