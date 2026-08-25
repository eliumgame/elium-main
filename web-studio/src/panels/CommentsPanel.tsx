import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { MessageSquare, Check, Trash2, CornerUpLeft, Send } from "lucide-react";
import { EmptyState } from "../ui/components";
import type { CommentAttrs, CommentReply } from "../editor/customExtensions";

interface CommentEntry extends CommentAttrs {
  pos: number;
}

function newReplyId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `rp-${c.randomUUID()}`;
  return `rp-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
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

export default function CommentsPanel({ editor, commentAuthor }: { editor: Editor | null; commentAuthor?: string }) {
  const [comments, setComments] = useState<CommentEntry[]>(() => collectComments(editor));
  // Draft reply text, keyed by comment id — one composer per open card.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

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

  const sendReply = (id: string) => {
    if (!editor) return;
    const text = (drafts[id] ?? "").trim();
    if (!text) return;
    const reply: CommentReply = { id: newReplyId(), author: commentAuthor || "Vous", text, createdAt: new Date().toISOString() };
    editor.chain().focus().addCommentReply(id, reply).run();
    setDrafts((d) => ({ ...d, [id]: "" }));
  };

  if (!editor) {
    return (
      <EmptyState
        icon={<MessageSquare size={20} />}
        title="Éditeur indisponible"
        hint="Ouvrez un document en édition."
      />
    );
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

      {(c.replies ?? []).length > 0 && (
        <div className="comment-card__replies">
          {(c.replies ?? []).map((r) => (
            <div key={r.id} className="comment-reply">
              <div className="comment-reply__head">
                <span className="comment-reply__author">{r.author || "Anonyme"}</span>
                {r.createdAt && <span className="comment-reply__date">{new Date(r.createdAt).toLocaleDateString()}</span>}
                <button
                  className="comment-reply__remove"
                  title="Supprimer la réponse"
                  onClick={() => editor.chain().focus().removeCommentReply(c.id, r.id).run()}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <p className="comment-reply__text">{r.text}</p>
            </div>
          ))}
        </div>
      )}

      {!c.resolved && (
        <div className="comment-card__composer">
          <input
            type="text"
            className="comment-card__composer-input"
            placeholder="Répondre…"
            value={drafts[c.id] ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendReply(c.id);
            }}
          />
          <button className="eb eb--ghost eb--sm" title="Envoyer la réponse" onClick={() => sendReply(c.id)}>
            <Send size={13} />
          </button>
        </div>
      )}

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
