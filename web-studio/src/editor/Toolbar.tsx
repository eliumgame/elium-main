import { useCallback, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  Bold, Italic, Underline, Strikethrough, Code2, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, Quote, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Highlighter, Table as TableIcon, Image as ImageIcon, Minus, Undo2, Redo2, Link2, PenLine,
  Indent, Outdent, SeparatorHorizontal, Combine, Split, Plus, Trash2, ListTree, MessageSquarePlus, Superscript,
  Bookmark as BookmarkIcon, Hash, FileCog, Pencil, Check, X, Type,
} from "lucide-react";
import { FONT_FAMILIES, FONT_SIZES, LINE_HEIGHTS, CODE_LANGUAGES } from "./extensions";
import { isSuggesting } from "./TrackChanges";
import { useDialogs } from "../ui/dialogs";
import { customFontNames, registerCustomFont, fontCss } from "../ui/fonts";

interface ToolbarProps {
  editor: Editor | null;
  onInsertImage: () => void;
  onAddSignature: () => void;
  /** Display name stamped on new comments (defaults to "Vous"). */
  commentAuthor?: string;
  /** Whether H1–H3 auto-numbering is on, and a toggle for it. */
  numberedHeadings?: boolean;
  onToggleNumberedHeadings?: () => void;
  /** Opens the page-setup dialog (format, header/footer, page numbers). */
  onOpenPageSettings?: () => void;
}

function newCommentId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `cm-${c.randomUUID()}`;
  return `cm-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

function ToolButton({
  active, disabled, onClick, title, children,
}: {
  active?: boolean; disabled?: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`tool-btn ${active ? "is-active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

export default function Toolbar({ editor, onInsertImage, onAddSignature, commentAuthor = "Vous", numberedHeadings, onToggleNumberedHeadings, onOpenPageSettings }: ToolbarProps) {
  const { prompt } = useDialogs();
  const fontInputRef = useRef<HTMLInputElement>(null);
  const [fontTick, setFontTick] = useState(0);
  const importFont = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !editor) return;
    const name = f.name.replace(/\.(ttf|otf)$/i, "");
    registerCustomFont(name, new Uint8Array(await f.arrayBuffer()));
    setFontTick((t) => t + 1);
    editor.chain().focus().setFontFamily(fontCss(name)).run();
  }, [editor]);
  const setLink = useCallback(async () => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = await prompt({ title: "Insérer un lien", label: "URL du lien", defaultValue: prev ?? "https://", placeholder: "https://exemple.com" });
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor, prompt]);

  const addComment = useCallback(async () => {
    if (!editor || editor.state.selection.empty) return;
    const text = await prompt({ title: "Ajouter un commentaire", label: "Commentaire", multiline: true });
    if (!text) return;
    editor.chain().focus().setComment({
      id: newCommentId(),
      author: commentAuthor,
      text,
      resolved: false,
      createdAt: new Date().toISOString(),
    }).run();
  }, [editor, commentAuthor, prompt]);

  const addFootnote = useCallback(async () => {
    if (!editor) return;
    const text = await prompt({ title: "Note de bas de page", label: "Texte de la note", multiline: true });
    if (text === null) return;
    editor.chain().focus().insertFootnote(text).run();
  }, [editor, prompt]);

  const addBookmark = useCallback(async () => {
    if (!editor) return;
    const label = await prompt({ title: "Insérer un signet", label: "Nom du signet (cible de renvoi)" });
    if (!label) return;
    editor.chain().focus().insertBookmark(label).run();
  }, [editor, prompt]);

  if (!editor) return <div className="toolbar toolbar--loading" />;

  // Named paragraph-style picker: maps block type + named paragraph variant.
  const currentStyle = (): string => {
    if (editor.isActive("heading", { level: 1 })) return "h1";
    if (editor.isActive("heading", { level: 2 })) return "h2";
    if (editor.isActive("heading", { level: 3 })) return "h3";
    if (editor.isActive("blockquote")) return "quote";
    const ds = editor.getAttributes("paragraph").dataStyle as string | null;
    if (ds === "subtitle" || ds === "lead") return ds;
    return "";
  };
  const applyStyle = (val: string) => {
    const chain = editor.chain().focus();
    switch (val) {
      case "h1": chain.setHeading({ level: 1 }).run(); break;
      case "h2": chain.setHeading({ level: 2 }).run(); break;
      case "h3": chain.setHeading({ level: 3 }).run(); break;
      case "quote": chain.toggleBlockquote().run(); break;
      case "subtitle": chain.setParagraph().updateAttributes("paragraph", { dataStyle: "subtitle" }).run(); break;
      case "lead": chain.setParagraph().updateAttributes("paragraph", { dataStyle: "lead" }).run(); break;
      default: chain.setParagraph().updateAttributes("paragraph", { dataStyle: null }).run(); break;
    }
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Mise en forme">
      <div className="tool-group">
        <ToolButton title="Annuler" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
          <Undo2 size={16} />
        </ToolButton>
        <ToolButton title="Rétablir" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
          <Redo2 size={16} />
        </ToolButton>
      </div>

      <div className="tool-group">
        <select
          key={`ff-${fontTick}`}
          className="tool-select"
          title="Police"
          value={editor.getAttributes("textStyle").fontFamily ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v) editor.chain().focus().setFontFamily(v).run();
            else editor.chain().focus().unsetFontFamily().run();
          }}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.label} value={f.value}>{f.label}</option>
          ))}
          {customFontNames().map((n) => (
            <option key={n} value={fontCss(n)}>{n}</option>
          ))}
        </select>
        <button type="button" className="icon-btn" title="Importer une police (.ttf/.otf)" onClick={() => fontInputRef.current?.click()}>
          <Type size={15} />
        </button>
        <input ref={fontInputRef} type="file" accept=".ttf,.otf" hidden onChange={importFont} />
        <select
          className="tool-select tool-select--sm"
          title="Taille"
          value={editor.getAttributes("textStyle").fontSize ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v) editor.chain().focus().setFontSize(v).run();
            else editor.chain().focus().unsetFontSize().run();
          }}
        >
          <option value="">Taille</option>
          {FONT_SIZES.map((s) => <option key={s} value={s}>{s.replace("px", "")}</option>)}
        </select>
      </div>

      <div className="tool-group">
        <ToolButton title="Gras" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={16} /></ToolButton>
        <ToolButton title="Italique" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={16} /></ToolButton>
        <ToolButton title="Souligné" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline size={16} /></ToolButton>
        <ToolButton title="Barré" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={16} /></ToolButton>
        <ToolButton title="Surlignage" active={editor.isActive("highlight")} onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter size={16} /></ToolButton>
        <label className="tool-color" title="Couleur du texte">
          <PenLine size={16} />
          <input
            type="color"
            value={(editor.getAttributes("textStyle").color as string) ?? "#1f2937"}
            onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
          />
        </label>
      </div>

      <div className="tool-group">
        <select
          className="tool-select"
          title="Style de paragraphe"
          value={currentStyle()}
          onChange={(e) => applyStyle(e.target.value)}
        >
          <option value="">Normal</option>
          <option value="h1">Titre 1</option>
          <option value="h2">Titre 2</option>
          <option value="h3">Titre 3</option>
          <option value="subtitle">Sous-titre</option>
          <option value="lead">Accroche</option>
          <option value="quote">Citation</option>
        </select>
      </div>

      <div className="tool-group">
        <ToolButton title="Titre 1" active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 size={16} /></ToolButton>
        <ToolButton title="Titre 2" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={16} /></ToolButton>
        <ToolButton title="Titre 3" active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={16} /></ToolButton>
      </div>

      <div className="tool-group">
        <ToolButton title="Liste à puces" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={16} /></ToolButton>
        <ToolButton title="Liste numérotée" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></ToolButton>
        <ToolButton title="Liste de tâches" active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks size={16} /></ToolButton>
        <ToolButton title="Citation" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={16} /></ToolButton>
        <ToolButton title="Bloc de code" active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Code2 size={16} /></ToolButton>
      </div>

      <div className="tool-group">
        <ToolButton title="Aligner à gauche" active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()}><AlignLeft size={16} /></ToolButton>
        <ToolButton title="Centrer" active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()}><AlignCenter size={16} /></ToolButton>
        <ToolButton title="Aligner à droite" active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()}><AlignRight size={16} /></ToolButton>
        <ToolButton title="Justifier" active={editor.isActive({ textAlign: "justify" })} onClick={() => editor.chain().focus().setTextAlign("justify").run()}><AlignJustify size={16} /></ToolButton>
      </div>

      <div className="tool-group">
        <ToolButton title="Diminuer le retrait" onClick={() => editor.chain().focus().outdent().run()}><Outdent size={16} /></ToolButton>
        <ToolButton title="Augmenter le retrait" onClick={() => editor.chain().focus().indent().run()}><Indent size={16} /></ToolButton>
        <select
          className="tool-select tool-select--sm"
          title="Interligne"
          value={editor.getAttributes("paragraph").lineHeight ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v) editor.chain().focus().setLineHeight(v).run();
            else editor.chain().focus().unsetLineHeight().run();
          }}
        >
          <option value="">Interligne</option>
          {LINE_HEIGHTS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </div>

      <div className="tool-group">
        <ToolButton title="Lien" active={editor.isActive("link")} onClick={setLink}><Link2 size={16} /></ToolButton>
        <ToolButton title="Image" onClick={onInsertImage}><ImageIcon size={16} /></ToolButton>
        <ToolButton title="Tableau" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon size={16} /></ToolButton>
        <ToolButton title="Séparateur" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus size={16} /></ToolButton>
        <ToolButton title="Saut de page" onClick={() => editor.chain().focus().insertPageBreak().run()}><SeparatorHorizontal size={16} /></ToolButton>
        <ToolButton title="Table des matières" onClick={() => editor.chain().focus().insertTableOfContents().run()}><ListTree size={16} /></ToolButton>
        <ToolButton
          title="Commenter la sélection"
          disabled={editor.state.selection.empty}
          onClick={addComment}
        >
          <MessageSquarePlus size={16} />
        </ToolButton>
        <ToolButton title="Note de bas de page" onClick={addFootnote}><Superscript size={16} /></ToolButton>
        <ToolButton title="Signet (cible de renvoi)" onClick={addBookmark}><BookmarkIcon size={16} /></ToolButton>
        <ToolButton title="Numéroter les titres (1. / 1.1 / 1.1.1)" active={!!numberedHeadings} onClick={() => onToggleNumberedHeadings?.()}><Hash size={16} /></ToolButton>
        <ToolButton title="Mise en page (format, en-tête, pied)" onClick={() => onOpenPageSettings?.()}><FileCog size={16} /></ToolButton>
        <ToolButton title="Suivi des modifications (mode suggestion)" active={isSuggesting(editor.state)} onClick={() => editor.chain().focus().toggleSuggesting().run()}><Pencil size={16} /></ToolButton>
      </div>

      {editor.isActive("figure") && (
        <div className="tool-group tool-group--context">
          <ToolButton title="Aligner à gauche (habillage)" active={editor.getAttributes("figure").align === "left"} onClick={() => editor.chain().focus().setFigureAlign("left").run()}><AlignLeft size={16} /></ToolButton>
          <ToolButton title="Centrer" active={editor.getAttributes("figure").align === "center"} onClick={() => editor.chain().focus().setFigureAlign("center").run()}><AlignCenter size={16} /></ToolButton>
          <ToolButton title="Aligner à droite (habillage)" active={editor.getAttributes("figure").align === "right"} onClick={() => editor.chain().focus().setFigureAlign("right").run()}><AlignRight size={16} /></ToolButton>
          <select
            className="tool-select tool-select--sm"
            title="Largeur de l'image"
            value={(editor.getAttributes("figure").width as string) || ""}
            onChange={(e) => editor.chain().focus().setFigureWidth(e.target.value).run()}
          >
            <option value="">Auto</option>
            <option value="25%">25 %</option>
            <option value="50%">50 %</option>
            <option value="75%">75 %</option>
            <option value="100%">100 %</option>
          </select>
        </div>
      )}

      {editor.isActive("table") && (
        <div className="tool-group tool-group--context">
          <ToolButton title="Insérer une ligne" onClick={() => editor.chain().focus().addRowAfter().run()}><Plus size={16} /></ToolButton>
          <ToolButton title="Insérer une colonne" onClick={() => editor.chain().focus().addColumnAfter().run()}><Plus size={16} style={{ transform: "rotate(90deg)" }} /></ToolButton>
          <ToolButton title="Fusionner les cellules" onClick={() => editor.chain().focus().mergeCells().run()}><Combine size={16} /></ToolButton>
          <ToolButton title="Scinder la cellule" onClick={() => editor.chain().focus().splitCell().run()}><Split size={16} /></ToolButton>
          <ToolButton title="Supprimer la ligne" onClick={() => editor.chain().focus().deleteRow().run()}><Minus size={16} /></ToolButton>
          <ToolButton title="Supprimer la colonne" onClick={() => editor.chain().focus().deleteColumn().run()}><Minus size={16} style={{ transform: "rotate(90deg)" }} /></ToolButton>
          <ToolButton title="Supprimer le tableau" onClick={() => editor.chain().focus().deleteTable().run()}><Trash2 size={16} /></ToolButton>
        </div>
      )}

      {editor.isActive("codeBlock") && (
        <div className="tool-group tool-group--context">
          <select
            className="tool-select"
            title="Langage du bloc de code"
            value={(editor.getAttributes("codeBlock").language as string) || "plaintext"}
            onChange={(e) => editor.chain().focus().updateAttributes("codeBlock", { language: e.target.value }).run()}
          >
            {CODE_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      )}

      {isSuggesting(editor.state) && (
        <div className="tool-group tool-group--context">
          <span className="tool-suggest-label">Suivi</span>
          <ToolButton title="Accepter toutes les modifications" onClick={() => editor.chain().focus().acceptAllChanges().run()}><Check size={16} /></ToolButton>
          <ToolButton title="Refuser toutes les modifications" onClick={() => editor.chain().focus().rejectAllChanges().run()}><X size={16} /></ToolButton>
        </div>
      )}

      <div className="tool-group tool-group--end">
        <button type="button" className="tool-btn tool-btn--accent" onClick={onAddSignature} title="Ajouter une signature">
          <PenLine size={16} /> Signer
        </button>
      </div>
    </div>
  );
}
