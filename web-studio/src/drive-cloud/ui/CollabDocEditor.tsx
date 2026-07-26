/**
 * Collaborative rich-text document. A TipTap editor with the FULL Elium
 * Documents extension set (headings, lists, tables, images, highlight, align,
 * links, track-changes, comments…) bound to a Y.Doc that syncs over the
 * end-to-end-encrypted channel — real multi-user editing with colored cursors +
 * presence. Content lives entirely as encrypted CRDT updates (no plaintext ever
 * reaches the server). Undo/redo is owned by the CRDT (Collaboration).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import {
  X, Wifi, WifiOff, Loader, Undo2, Redo2, Bold, Italic, Underline, Strikethrough,
  Heading1, Heading2, Heading3, List, ListOrdered, Quote, Code2, Highlighter,
  AlignLeft, AlignCenter, AlignRight, Link2, SplitSquareVertical, CornerDownRight,
  ScanSearch, ListTree,
} from "lucide-react";
import { buildExtensions } from "../../editor/extensions";
import { LIST_SCHEMES, schemeById } from "../../editor/listSchemes";
import { clampColumns, setPageResolver } from "../../editor/wordExtensions";
import { ensureListSchemeStyles } from "../../editor/listSchemeStyles";
import CrossRefModal from "../../editor/CrossRefModal";
import IndexEntryModal from "../../editor/IndexEntryModal";
import { CSS_PX_PER_MM, pageAt, type PageMetrics, type PageInfo, type PagePlan, type PaginationOptions } from "../../editor/Pagination";
import { DEFAULT_PAGE } from "../../format/document";
import { pageSizeMm } from "../../format/pageSizes";
import { EncryptedYjsProvider, type CollabStatus, type CollabUser } from "../collab-provider";
import type { DriveApi } from "../api";

// Collaborative docs have no per-document page model, so they paginate on the
// standard A4 geometry (same DEFAULT_PAGE as the local editor) — parity with the
// local Documents surface (dual-platform rule).
const COLLAB_PAGE = pageSizeMm(DEFAULT_PAGE.format, DEFAULT_PAGE.orientation);
const COLLAB_METRICS: PageMetrics = {
  pageContentPx: Math.max(0, (COLLAB_PAGE.height - DEFAULT_PAGE.margins.top - DEFAULT_PAGE.margins.bottom) * CSS_PX_PER_MM),
  gapPx: 40,
  marginLeftPx: DEFAULT_PAGE.margins.left * CSS_PX_PER_MM,
  marginRightPx: DEFAULT_PAGE.margins.right * CSS_PX_PER_MM,
};

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

function Toolbar({
  editor,
  onCrossRef,
  onIndexEntry,
}: {
  editor: Editor;
  onCrossRef: () => void;
  onIndexEntry: () => void;
}) {
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
  // Scheme of the enclosing list (it lives on the outermost list of the tree).
  const currentScheme = ((): string | null => {
    const $from = editor.state.selection.$from;
    for (let d = 1; d <= $from.depth; d++) {
      const node = $from.node(d);
      if (node.type.name === "bulletList" || node.type.name === "orderedList") {
        return schemeById(node.attrs.listScheme)?.id ?? null;
      }
    }
    return null;
  })();
  const columnCount = editor.isActive("columnSection") ? clampColumns(Number(editor.getAttributes("columnSection").count)) : 1;
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
      <span className="dc-doc__tbsep" />
      {/* Word-parity structure, same extensions as the local editor (dual-platform
          rule): multilevel lists, columns, section breaks, renvois and index. */}
      <select
        className="dc-doc__tbselect"
        title="Liste à plusieurs niveaux"
        value={currentScheme ?? ""}
        onChange={(e) => chain().setListScheme(e.target.value || null).run()}
      >
        <option value="">Marqueurs par défaut</option>
        {LIST_SCHEMES.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>
      <select
        className="dc-doc__tbselect"
        title="Colonnes"
        value={columnCount}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (n <= 1) chain().unsetColumns().run();
          else if (editor.isActive("columnSection")) chain().updateColumns({ count: n }).run();
          else chain().setColumns({ count: n }).run();
        }}
      >
        <option value={1}>1 colonne</option>
        <option value={2}>2 colonnes</option>
        <option value={3}>3 colonnes</option>
        <option value={4}>4 colonnes</option>
      </select>
      {btn(
        false,
        "Saut de section (page suivante)",
        () =>
          chain()
            .insertSectionBreak({ kind: "nextPage", orientation: "", restartNumbering: false, startAt: 1, header: "", footer: "" })
            .run(),
        <SplitSquareVertical size={16} />,
      )}
      {btn(false, "Insérer un renvoi", onCrossRef, <CornerDownRight size={16} />)}
      {btn(false, "Marquer une entrée d'index", onIndexEntry, <ScanSearch size={16} />)}
      {btn(false, "Insérer l'index", () => chain().insertIndexBlock().run(), <ListTree size={16} />)}
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

  // On-screen pagination (parity with the local Documents editor).
  const [pageInfo, setPageInfo] = useState<PageInfo>({ pageCount: 1, currentPage: 1 });
  const planRef = useRef<PagePlan | null>(null);
  const [paginationOpts] = useState<PaginationOptions>(() => ({
    getMetrics: () => COLLAB_METRICS,
    onInfo: (i) =>
      setPageInfo((prev) => (prev.pageCount === i.pageCount && prev.currentPage === i.currentPage ? prev : i)),
    onPlan: (plan) => {
      planRef.current = plan;
    },
  }));
  const [dialog, setDialog] = useState<"xref" | "index" | null>(null);

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
      pagination: paginationOpts,
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

  // Same generated multilevel-list CSS and page-number source as the local
  // editor, so a document authored on either surface renders identically.
  useEffect(() => {
    ensureListSchemeStyles();
  }, []);

  useEffect(() => {
    if (!editor) return;
    setPageResolver((pos) => {
      const plan = planRef.current;
      return plan ? pageAt(plan, editor.state, pos) : 1;
    });
    return () => setPageResolver(null);
  }, [editor]);

  // Revoked access closes the document for good — never editable, even if
  // the last known `canWrite` (from before the revocation) was true.
  const writable = canWrite && status !== "revoked";

  useEffect(() => {
    if (editor) editor.setEditable(writable);
  }, [editor, writable]);

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

  const statusLabel =
    status === "open" ? "Connecté" :
    status === "connecting" ? "Connexion…" :
    status === "revoked" ? "Accès révoqué — document fermé" :
    "Hors ligne";

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
          <span className="badge badge--neutral" title="Pagination">Page {pageInfo.currentPage} / {pageInfo.pageCount}</span>
          {!canWrite && status === "open" && <span className="badge badge--neutral">Lecture seule</span>}
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </header>
        {writable && editor && (
          <Toolbar editor={editor} onCrossRef={() => setDialog("xref")} onIndexEntry={() => setDialog("index")} />
        )}
        <div className="dc-doc__body">
          <div
            className="dc-doc__page"
            style={{
              width: `${COLLAB_PAGE.width}mm`,
              maxWidth: "none",
              minHeight: `${COLLAB_PAGE.height}mm`,
              paddingTop: `${DEFAULT_PAGE.margins.top}mm`,
              paddingRight: `${DEFAULT_PAGE.margins.right}mm`,
              paddingBottom: `${DEFAULT_PAGE.margins.bottom}mm`,
              paddingLeft: `${DEFAULT_PAGE.margins.left}mm`,
            }}
          >
            <EditorContent editor={editor} />
          </div>
        </div>
        {editor && dialog === "xref" && <CrossRefModal editor={editor} onClose={() => setDialog(null)} />}
        {editor && dialog === "index" && <IndexEntryModal editor={editor} onClose={() => setDialog(null)} />}
      </div>
    </div>
  );
}
