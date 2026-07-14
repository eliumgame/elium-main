/**
 * Collaborative rich-text document. A TipTap editor with the FULL Elium
 * Documents extension set (headings, lists, tables, images, highlight, align,
 * links, track-changes, comments…) bound to a Y.Doc that syncs over the
 * end-to-end-encrypted channel — real multi-user editing with colored cursors +
 * presence. Content lives entirely as encrypted CRDT updates (no plaintext ever
 * reaches the server). Undo/redo is owned by the CRDT (Collaboration).
 */
import { useEffect, useMemo, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import {
  X, Wifi, WifiOff, Loader, Undo2, Redo2, Bold, Italic, Underline, Strikethrough,
  Heading1, Heading2, Heading3, List, ListOrdered, Quote, Code2, Highlighter,
  AlignLeft, AlignCenter, AlignRight, Link2,
} from "lucide-react";
import { buildExtensions } from "../../editor/extensions";
import { EncryptedYjsProvider, type CollabStatus, type CollabUser } from "../collab-provider";
import type { DriveApi } from "../api";

const PALETTE = ["#2563eb", "#16a34a", "#db2777", "#ca8a04", "#7c3aed", "#0ea5e9", "#dc2626", "#0d9488"];
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
function initials(s: string): string {
  const p = s.split(/[@\s.]+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

function Toolbar({ editor }: { editor: Editor }) {
  const btn = (active: boolean, title: string, run: () => void, icon: React.ReactNode) => (
    <button
      type="button"
      className={`icon-btn ${active ? "is-active" : ""}`}
      title={title}
      onMouseDown={(e) => { e.preventDefault(); run(); }}
    >
      {icon}
    </button>
  );
  const chain = () => editor.chain().focus();
  const setLink = () => {
    const prev = (editor.getAttributes("link").href as string) ?? "";
    const url = window.prompt("Adresse du lien (vide pour retirer) :", prev);
    if (url === null) return;
    if (url === "") chain().unsetLink().run();
    else chain().setLink({ href: url }).run();
  };
  return (
    <div className="dc-doc__toolbar">
      {btn(false, "Annuler", () => chain().undo().run(), <Undo2 size={16} />)}
      {btn(false, "Rétablir", () => chain().redo().run(), <Redo2 size={16} />)}
      <span className="dc-doc__tbsep" />
      {btn(editor.isActive("bold"), "Gras", () => chain().toggleBold().run(), <Bold size={16} />)}
      {btn(editor.isActive("italic"), "Italique", () => chain().toggleItalic().run(), <Italic size={16} />)}
      {btn(editor.isActive("underline"), "Souligné", () => chain().toggleUnderline().run(), <Underline size={16} />)}
      {btn(editor.isActive("strike"), "Barré", () => chain().toggleStrike().run(), <Strikethrough size={16} />)}
      {btn(editor.isActive("highlight"), "Surligner", () => chain().toggleHighlight().run(), <Highlighter size={16} />)}
      <span className="dc-doc__tbsep" />
      {btn(editor.isActive("heading", { level: 1 }), "Titre 1", () => chain().toggleHeading({ level: 1 }).run(), <Heading1 size={16} />)}
      {btn(editor.isActive("heading", { level: 2 }), "Titre 2", () => chain().toggleHeading({ level: 2 }).run(), <Heading2 size={16} />)}
      {btn(editor.isActive("heading", { level: 3 }), "Titre 3", () => chain().toggleHeading({ level: 3 }).run(), <Heading3 size={16} />)}
      <span className="dc-doc__tbsep" />
      {btn(editor.isActive("bulletList"), "Liste à puces", () => chain().toggleBulletList().run(), <List size={16} />)}
      {btn(editor.isActive("orderedList"), "Liste numérotée", () => chain().toggleOrderedList().run(), <ListOrdered size={16} />)}
      {btn(editor.isActive("blockquote"), "Citation", () => chain().toggleBlockquote().run(), <Quote size={16} />)}
      {btn(editor.isActive("codeBlock"), "Bloc de code", () => chain().toggleCodeBlock().run(), <Code2 size={16} />)}
      <span className="dc-doc__tbsep" />
      {btn(editor.isActive({ textAlign: "left" }), "Aligner à gauche", () => chain().setTextAlign("left").run(), <AlignLeft size={16} />)}
      {btn(editor.isActive({ textAlign: "center" }), "Centrer", () => chain().setTextAlign("center").run(), <AlignCenter size={16} />)}
      {btn(editor.isActive({ textAlign: "right" }), "Aligner à droite", () => chain().setTextAlign("right").run(), <AlignRight size={16} />)}
      {btn(editor.isActive("link"), "Lien", setLink, <Link2 size={16} />)}
    </div>
  );
}

export default function CollabDocEditor({
  api, nodeId, nodeKey, title, user, onClose, refetchKey,
}: {
  api: DriveApi;
  nodeId: string;
  nodeKey: Uint8Array;
  title: string;
  user: { id: string; name: string };
  onClose: () => void;
  refetchKey?: () => Promise<Uint8Array | null>;
}) {
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [canWrite, setCanWrite] = useState(false);
  const [peers, setPeers] = useState<CollabUser[]>([]);

  const me: CollabUser = useMemo(() => ({ name: user.name, color: colorFor(user.id) }), [user.id, user.name]);
  const [ydoc] = useState(() => new Y.Doc());
  const [provider] = useState(
    () => new EncryptedYjsProvider(api, nodeId, nodeKey, ydoc, me, { onStatus: setStatus, onReady: setCanWrite, ...(refetchKey ? { refetchKey } : {}) }),
  );

  const editor = useEditor({
    editable: false,
    extensions: buildExtensions({
      editable: true,
      author: me.name,
      disableHistory: true,
      extra: [
        Collaboration.configure({ document: ydoc }),
        CollaborationCaret.configure({ provider: provider as unknown as { awareness: unknown } }),
      ],
    }),
    editorProps: { attributes: { class: "dc-doc__prose" } },
  });

  useEffect(() => {
    void provider.connect();
    return () => provider.destroy();
  }, [provider]);

  useEffect(() => {
    if (editor) editor.setEditable(canWrite);
  }, [editor, canWrite]);

  useEffect(() => {
    const refresh = () => {
      const self = provider.awareness.clientID;
      const list: CollabUser[] = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === self) return;
        const u = (state as { user?: CollabUser }).user;
        if (u && u.name) list.push(u);
      });
      setPeers(list);
    };
    provider.awareness.on("change", refresh);
    refresh();
    return () => provider.awareness.off("change", refresh);
  }, [provider]);

  const statusLabel = status === "open" ? "Connecté" : status === "connecting" ? "Connexion…" : "Hors ligne";

  return (
    <div className="dc-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dc-doc">
        <header className="dc-doc__head">
          <span className="dc-doc__title" title={title}>{title}</span>
          <span className={`dc-doc__status dc-doc__status--${status}`}>
            {status === "open" ? <Wifi size={13} /> : status === "connecting" ? <Loader size={13} className="dc-spin" /> : <WifiOff size={13} />} {statusLabel}
          </span>
          <div className="dc-doc__peers">
            <span className="dc-doc-av" style={{ background: me.color }} title={`${me.name} (vous)`}>{initials(me.name)}</span>
            {peers.map((p, i) => (
              <span key={i} className="dc-doc-av" style={{ background: p.color }} title={p.name}>{initials(p.name)}</span>
            ))}
          </div>
          <div className="dc-doc__spacer" />
          {!canWrite && status === "open" && <span className="badge badge--neutral">Lecture seule</span>}
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </header>
        {canWrite && editor && <Toolbar editor={editor} />}
        <div className="dc-doc__body">
          <div className="dc-doc__page">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
    </div>
  );
}
