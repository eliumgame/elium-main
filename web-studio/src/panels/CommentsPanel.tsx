import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { MessageSquare, Check, Trash2, CornerUpLeft } from "lucide-react";
import { EmptyState } from "../ui/components";
import type { CommentAttrs } from "../editor/customExtensions";

interface CommentEntry extends CommentAttrs {
  pos: number;
}

/** Scan the editor document for comment marks, deduped by id (first wins). */
function collectComments(editor: Editor | null): CommentEntry[] {
  if (!editor) return [];
  const byId = new Map<string, CommentEntry>();
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      if (m.type.name === "comment" && m.attrs.id && !byId.has(m.attrs.id)) {
        byId.set(m.attrs.id, { ...(m.attrs as CommentAttrs), pos });
      }
    }
  });
  return [...byId.values()];
}

export default function CommentsPanel({ editor }: { editor: Editor | null }) {
  const [comments, setComments] = useState<CommentEntry[]>(() => collectComments(editor));

  // Re-derive the list whenever the document changes.
  useEffect(() => {
    if (!editor) return;
    const refresh = () => setComments(collectComments(editor));
    refresh();
    editor.on("update", refresh);
    editor.on("selectionUpdate", refresh);
    return () => {
      editor.off("update", refresh);
      editor.off("selectionUpdate", refresh);
    };
  }, [editor]);

  const jumpTo = (pos: number) => {
    if (!editor) return;
    editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
  };

  if (!editor) {
    return <EmptyState icon={<MessageSquare size={20} />} title="Éditeur indisponible" hint="Ouvrez un document en édition." />;
  }

  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);

  if (!comments.length) {
    return (
      <EmptyState
        icon={<MessageSquare size={20} />}
        title="Aucun commentaire"
        hint="Sélectionnez du texte puis cliquez sur « Commenter » dans la barre d'outils."
      />
    );
  }

  const row = (c: CommentEntry) => (
    <div key={c.id} className={`comment-card ${c.resolved ? "comment-card--resolved" : ""}`}>
      <div className="comment-card__head">
        <span className="comment-card__author">{c.author || "Anonyme"}</span>
        {c.createdAt && <span className="comment-card__date">{new Date(c.createdAt).toLocaleDateString()}</span>}
      </div>
      <p className="comment-card__text">{c.text}</p>
      <div className="comment-card__actions">
        <button className="eb eb--ghost eb--sm" title="Aller au passage" onClick={() => jumpTo(c.pos)}>
          <CornerUpLeft size={14} /> Voir
        </button>
        <button
          className="eb eb--ghost eb--sm"
          title={c.resolved ? "Rouvrir" : "Marquer comme résolu"}
          onClick={() => editor.chain().focus().resolveComment(c.id, !c.resolved).run()}
        >
          <Check size={14} /> {c.resolved ? "Rouvrir" : "Résoudre"}
        </button>
        <button
          className="eb eb--ghost eb--sm"
          title="Supprimer le commentaire"
          onClick={() => editor.chain().focus().removeComment(c.id).run()}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="comments-panel">
      {open.map(row)}
      {resolved.length > 0 && (
        <>
          <div className="comments-panel__sep">Résolus ({resolved.length})</div>
          {resolved.map(row)}
        </>
      )}
    </div>
  );
}
