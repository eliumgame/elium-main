import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  Bold, Italic, Underline, Strikethrough, Code2, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, Quote, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Highlighter, Table as TableIcon, Image as ImageIcon, Minus, Undo2, Redo2, Link2, PenLine,
  Indent, Outdent, SeparatorHorizontal, Combine, Split, Plus, Trash2, ListTree, MessageSquarePlus,
  Superscript, Bookmark as BookmarkIcon, Hash, FileCog, Pencil, Check, X, Type, BarChart3,
  PanelLeft, PanelRight, Search, Columns, SplitSquareVertical, CornerDownRight, ScanSearch,
  GitCompareArrows, Users, Braces, ChevronDown, Subscript as SubscriptIcon, CaseSensitive,
  StickyNote, ArrowLeftRight, Ruler, Sigma, Baseline, Droplets,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical, ArrowDownAZ, ArrowUpAZ,
  RemoveFormatting, Palette, ChevronUp, Pilcrow, Tag, GalleryVerticalEnd,
} from "lucide-react";
import { figureTableTitle } from "./captions";
import { FONT_FAMILIES, FONT_SIZES, LINE_HEIGHTS, CODE_LANGUAGES } from "./typography";
import { isSuggesting } from "./TrackChanges";
import { useDialogs } from "../ui/dialogs";
import { customFontNames, registerCustomFont, fontCss } from "../ui/fonts";
import { LIST_SCHEMES, schemeById } from "./listSchemes";
import { clampColumns } from "./wordExtensions";
import { FONT_ACCEPT, fontNameFromFilename } from "../format/embedded-fonts";
import { CASE_LABELS } from "./charFormat";
import { resolveStyle, styleCss } from "./styles";
import { styleRegistry } from "./styleExtension";
import { DEFAULT_TABLE_STYLE, TABLE_FIT_LABELS, TABLE_STYLES } from "./tableStyles";

/**
 * The Documents ribbon.
 *
 * Same command surface as before, reorganised into Word-style tabs and dressed
 * in the shared workspace language (`.elx-*`, see src/ui/workspace.css) so
 * Documents, PDF, Tableur and Présentations look like one product.
 *
 * Contextual strips (image, table, code block, tracked changes) sit below the
 * ribbon and appear on selection regardless of the active tab — losing them
 * behind a tab would make table editing miserable.
 */

type RibbonTab = "home" | "insert" | "layout" | "references" | "merge" | "review" | "view";

const TABS: { id: RibbonTab; label: string }[] = [
  { id: "home", label: "Accueil" },
  { id: "insert", label: "Insertion" },
  { id: "layout", label: "Mise en page" },
  { id: "references", label: "Références" },
  { id: "merge", label: "Publipostage" },
  { id: "review", label: "Révision" },
  { id: "view", label: "Affichage" },
];

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
  /** Opens the statistics dialog. */
  onOpenStats?: () => void;
  /** Navigation pane (document outline). */
  outlineOpen?: boolean;
  onToggleOutline?: () => void;
  /** Right-hand inspector (comments, signatures, versions…). */
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  /** Find & replace bar. */
  onToggleFind?: () => void;
  /** Word-parity dialogs, hosted by the editor shell. */
  onOpenCrossRef?: () => void;
  onOpenIndexEntry?: () => void;
  onOpenColumns?: () => void;
  onOpenSectionBreak?: () => void;
  onOpenCompare?: () => void;
  onOpenMailMerge?: () => void;
  onOpenFont?: () => void;
  onOpenParagraph?: () => void;
  onOpenStyles?: () => void;
  onOpenCaption?: () => void;
  onOpenSymbol?: () => void;
  onOpenWatermark?: () => void;
  /** Règle graduée : visible et bascule. */
  rulerVisible?: boolean;
  onToggleRuler?: () => void;
}

/**
 * A ribbon button that opens a small panel (galleries, quick choices). Closes on
 * outside click and on Escape, like the rest of the workspace chrome.
 */
function Dropdown({
  label, title, icon, children, align = "left", big,
}: {
  label?: string;
  title: string;
  icon: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  big?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="elx-drop" ref={wrapRef}>
      <button
        type="button"
        className={`elx-cmd ${big ? "elx-cmd--big" : ""} ${open ? "is-active" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={title}
        aria-expanded={open}
      >
        <span className="elx-cmd__icon">{icon}</span>
        {label && <span className="elx-cmd__label">{label}</span>}
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && <div className={`elx-menu ${align === "right" ? "elx-menu--right" : ""}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

/**
 * L'index de colonne de la cellule où se trouve le curseur.
 *
 * Le tri porte sur « la colonne du curseur » : sans cela il faudrait un dialogue
 * pour choisir la colonne, alors que le curseur la désigne déjà.
 */
function currentCellIndex(editor: Editor): number {
  const $from = editor.state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") return $from.index(d - 1);
  }
  return 0;
}

function newCommentId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `cm-${c.randomUUID()}`;
  return `cm-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

function Cmd({
  active, disabled, onClick, title, label, big, danger, children,
}: {
  active?: boolean; disabled?: boolean; onClick: () => void; title: string;
  label?: string; big?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`elx-cmd ${big ? "elx-cmd--big" : ""} ${active ? "is-active" : ""} ${danger ? "is-danger" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      <span className="elx-cmd__icon">{children}</span>
      {label && <span className="elx-cmd__label">{label}</span>}
    </button>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="elx-group">
      <div className="elx-group__items">{children}</div>
      <div className="elx-group__title">{title}</div>
    </div>
  );
}

export default function Toolbar({
  editor, onInsertImage, onAddSignature, commentAuthor = "Vous", numberedHeadings,
  onToggleNumberedHeadings, onOpenPageSettings, onOpenStats, outlineOpen, onToggleOutline,
  inspectorOpen, onToggleInspector, onToggleFind, onOpenCrossRef, onOpenIndexEntry,
  onOpenColumns, onOpenSectionBreak, onOpenCompare, onOpenMailMerge, onOpenFont, onOpenParagraph, onOpenStyles, onOpenCaption,
  onOpenSymbol, onOpenWatermark, rulerVisible, onToggleRuler,
}: ToolbarProps) {
  const { prompt } = useDialogs();
  const fontInputRef = useRef<HTMLInputElement>(null);
  const [fontTick, setFontTick] = useState(0);
  const [tab, setTab] = useState<RibbonTab>("home");

  const importFont = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !editor) return;
    const name = fontNameFromFilename(f.name);
    registerCustomFont(name, new Uint8Array(await f.arrayBuffer()), f.name);
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

  const addEndnote = useCallback(async () => {
    if (!editor) return;
    const text = await prompt({ title: "Note de fin", label: "Texte de la note", multiline: true });
    if (text === null) return;
    editor.chain().focus().insertEndnote(text).run();
  }, [editor, prompt]);

  const addBookmark = useCallback(async () => {
    if (!editor) return;
    const label = await prompt({ title: "Insérer un signet", label: "Nom du signet (cible de renvoi)" });
    if (!label) return;
    editor.chain().focus().insertBookmark(label).run();
  }, [editor, prompt]);

  const addMergeField = useCallback(async () => {
    if (!editor) return;
    const field = await prompt({
      title: "Champ de fusion",
      label: "Nom du champ",
      placeholder: "ex. Nom",
    });
    if (!field?.trim()) return;
    editor.chain().focus().insertMergeField(field.trim()).run();
  }, [editor, prompt]);

  if (!editor) return <div className="elx-ribbon elx-ribbon--loading" />;

  // Which named style is in force where the cursor sits? The `styleId` attribute
  // is authoritative; a bare heading with no style falls back to its level's
  // built-in so the gallery still highlights the right entry.
  const currentStyleId = ((): string => {
    const charStyle = editor.getAttributes("textStyle").styleId;
    if (typeof charStyle === "string" && charStyle) return charStyle;
    const type = editor.isActive("heading") ? "heading" : "paragraph";
    const id = editor.getAttributes(type).styleId;
    if (typeof id === "string" && id) return id;
    if (editor.isActive("heading")) {
      const level = Number(editor.getAttributes("heading").level) || 1;
      return `Titre${Math.min(4, level)}`;
    }
    return "Normal";
  })();
  // Scheme of the list the cursor sits in — inherited from the outermost list,
  // which is where the attribute lives.
  const currentListScheme = ((): string | null => {
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

  // The gallery shows the styles flagged `quick`, previewed with their own CSS.
  const registry = styleRegistry();
  const quickStyles = registry.filter((s) => s.quick);
  const styleSampleCss = (id: string): React.CSSProperties => {
    const css = styleCss(resolveStyle(registry, id));
    const out: Record<string, string> = {};
    for (const decl of css.split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim();
      const value = decl.slice(i + 1).trim();
      // Margins would space the menu rows out; the sample is about type only.
      if (!prop || !value || prop.startsWith("margin")) continue;
      out[prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
    }
    return out as React.CSSProperties;
  };


  return (
    <div className="elx-ribbon" role="toolbar" aria-label="Mise en forme">
      <div className="elx-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`elx-tab ${tab === t.id ? "is-active" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="elx-ribbon__body">
        <Group title="Édition">
          <Cmd title="Annuler (Ctrl+Z)" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}><Undo2 size={17} /></Cmd>
          <Cmd title="Rétablir (Ctrl+Y)" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}><Redo2 size={17} /></Cmd>
        </Group>

        {tab === "home" && (
          <>
            <Group title="Police">
              <select
                key={`ff-${fontTick}`}
                className="elx-select elx-select--font"
                title="Police"
                value={editor.getAttributes("textStyle").fontFamily ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) editor.chain().focus().setFontFamily(v).run();
                  else editor.chain().focus().unsetFontFamily().run();
                }}
              >
                {FONT_FAMILIES.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
                {customFontNames().map((n) => <option key={n} value={fontCss(n)}>{n}</option>)}
              </select>
              <Cmd title="Importer une police (.ttf, .otf, .woff, .woff2)" onClick={() => fontInputRef.current?.click()}><Type size={16} /></Cmd>
              <input ref={fontInputRef} type="file" accept={FONT_ACCEPT} hidden onChange={importFont} />
              <select
                className="elx-select elx-select--size"
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
            </Group>

            <Group title="Caractère">
              <Cmd title="Gras (Ctrl+B)" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={17} /></Cmd>
              <Cmd title="Italique (Ctrl+I)" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={17} /></Cmd>
              <Cmd title="Souligné (Ctrl+U)" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline size={17} /></Cmd>
              <Cmd title="Barré" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={17} /></Cmd>
              <Cmd title="Surlignage" active={editor.isActive("highlight")} onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter size={17} /></Cmd>
              <Cmd title="Exposant (Ctrl+Maj+=)" active={editor.isActive("superscript")} onClick={() => editor.chain().focus().toggleSuperscript().run()}><Superscript size={17} /></Cmd>
              <Cmd title="Indice (Ctrl+=)" active={editor.isActive("subscript")} onClick={() => editor.chain().focus().toggleSubscript().run()}><SubscriptIcon size={17} /></Cmd>
              <Cmd title="Agrandir la police (Ctrl+Maj+>)" onClick={() => editor.chain().focus().growFontSize().run()}><ChevronUp size={17} /></Cmd>
              <Cmd title="Réduire la police (Ctrl+Maj+<)" onClick={() => editor.chain().focus().shrinkFontSize().run()}><ChevronDown size={17} /></Cmd>
              <Dropdown title="Modifier la casse" icon={<CaseSensitive size={17} />}>
                {(close) => (
                  <>
                    <div className="elx-menu__title">Modifier la casse</div>
                    {(["sentence", "lower", "upper", "title", "toggle"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className="elx-menu__item"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          editor.chain().focus().changeCase(mode).run();
                          close();
                        }}
                      >
                        {CASE_LABELS[mode]}
                      </button>
                    ))}
                  </>
                )}
              </Dropdown>
              <Cmd
                title="Effacer la mise en forme (Ctrl+Espace)"
                disabled={editor.state.selection.empty}
                onClick={() => editor.chain().focus().clearCharFormatting().run()}
              >
                <RemoveFormatting size={17} />
              </Cmd>
              <Cmd title="Police… (toutes les options de caractère)" onClick={() => onOpenFont?.()}><Palette size={17} /></Cmd>
              <label className="elx-colorbtn" title="Couleur du texte">
                <input
                  type="color"
                  value={(editor.getAttributes("textStyle").color as string) ?? "#1f2937"}
                  onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
                />
              </label>
            </Group>

            <Group title="Styles">
              {/* Word's Quick Style gallery: every entry previews itself. */}
              <Dropdown title="Galerie de styles" icon={<Type size={17} />} label="Styles" big>
                {(close) => (
                  <>
                    <div className="elx-menu__title">Styles rapides</div>
                    {quickStyles.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`elx-menu__item ${currentStyleId === s.id ? "is-active" : ""}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          editor.chain().focus().applyNamedStyle(s.id).run();
                          close();
                        }}
                        title={s.kind === "character" ? "Style de caractère" : "Style de paragraphe"}
                      >
                        <span className="elx-stylesample">
                          <span style={{ all: "unset", ...styleSampleCss(s.id) }}>{s.name}</span>
                        </span>
                      </button>
                    ))}
                    <div className="elx-menu__sep" />
                    <button
                      type="button"
                      className="elx-menu__item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onOpenStyles?.();
                        close();
                      }}
                    >
                      Gérer les styles…
                    </button>
                  </>
                )}
              </Dropdown>
              <Cmd title="Citation" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={17} /></Cmd>
              <Cmd title="Titre 1" active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 size={17} /></Cmd>
              <Cmd title="Titre 2" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={17} /></Cmd>
              <Cmd title="Titre 3" active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={17} /></Cmd>
            </Group>

            <Group title="Paragraphe">
              <Cmd title="Liste à puces" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={17} /></Cmd>
              <Cmd title="Liste numérotée" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={17} /></Cmd>
              <Dropdown title="Liste à plusieurs niveaux" icon={<ListTree size={17} />}>
                {(close) => (
                  <>
                    <div className="elx-menu__title">Bibliothèque de listes</div>
                    {LIST_SCHEMES.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`elx-menu__item ${currentListScheme === s.id ? "is-active" : ""}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          editor.chain().focus().setListScheme(s.id).run();
                          close();
                        }}
                      >
                        <span className="elx-listprev" aria-hidden="true">
                          {s.preview.map((p, i) => <span key={i}>{p} texte</span>)}
                        </span>
                        <span>{s.label}</span>
                      </button>
                    ))}
                    <div className="elx-menu__sep" />
                    <button
                      type="button"
                      className={`elx-menu__item ${!currentListScheme ? "is-active" : ""}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        editor.chain().focus().setListScheme(null).run();
                        close();
                      }}
                    >
                      Marqueurs par défaut
                    </button>
                  </>
                )}
              </Dropdown>
              <Cmd title="Liste de tâches" active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks size={17} /></Cmd>
              <Cmd title="Citation" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={17} /></Cmd>
              <Cmd title="Bloc de code" active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Code2 size={17} /></Cmd>
              <Cmd title="Paragraphe… (espacement, retraits, enchaînements, bordures)" onClick={() => onOpenParagraph?.()}><Pilcrow size={17} /></Cmd>
            </Group>

            <Group title="Alignement">
              <Cmd title="Aligner à gauche" active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()}><AlignLeft size={17} /></Cmd>
              <Cmd title="Centrer" active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()}><AlignCenter size={17} /></Cmd>
              <Cmd title="Aligner à droite" active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()}><AlignRight size={17} /></Cmd>
              <Cmd title="Justifier" active={editor.isActive({ textAlign: "justify" })} onClick={() => editor.chain().focus().setTextAlign("justify").run()}><AlignJustify size={17} /></Cmd>
              <Cmd title="Diminuer le retrait" onClick={() => editor.chain().focus().outdent().run()}><Outdent size={17} /></Cmd>
              <Cmd title="Augmenter le retrait" onClick={() => editor.chain().focus().indent().run()}><Indent size={17} /></Cmd>
              <select
                className="elx-select elx-select--size"
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
            </Group>

            <Group title="Rechercher">
              <Cmd title="Rechercher et remplacer (Ctrl+F)" onClick={() => onToggleFind?.()}><Search size={17} /></Cmd>
            </Group>
          </>
        )}

        {tab === "insert" && (
          <>
            <Group title="Illustrations">
              <Cmd big label="Image" title="Insérer une image" onClick={onInsertImage}><ImageIcon size={19} /></Cmd>
              <Cmd big label="Tableau" title="Insérer un tableau 3×3" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon size={19} /></Cmd>
            </Group>
            <Group title="Liens">
              <Cmd title="Lien" active={editor.isActive("link")} onClick={setLink}><Link2 size={17} /></Cmd>
              <Cmd title="Signet (cible de renvoi)" onClick={addBookmark}><BookmarkIcon size={17} /></Cmd>
            </Group>
            <Group title="Éléments">
              <Cmd title="Séparateur" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus size={17} /></Cmd>
              <Cmd title="Saut de page" onClick={() => editor.chain().focus().insertPageBreak().run()}><SeparatorHorizontal size={17} /></Cmd>
              <Cmd title="Table des matières" onClick={() => editor.chain().focus().insertTableOfContents().run()}><ListTree size={17} /></Cmd>
              <Cmd title="Note de bas de page" onClick={addFootnote}><Superscript size={17} /></Cmd>
              <Cmd title="Note de fin" onClick={addEndnote}><StickyNote size={17} /></Cmd>
              <Cmd title="Insérer un symbole" onClick={() => onOpenSymbol?.()}><Sigma size={17} /></Cmd>
            </Group>
            <Group title="Ornements">
              <Dropdown big label="Lettrine" title="Lettrine (première lettre agrandie)" icon={<Baseline size={19} />}>
                {(close) => (
                  <>
                    <div className="elx-menu__title">Lettrine</div>
                    {([["drop", "Dans le texte"], ["margin", "Dans la marge"]] as const).map(([k, label]) => (
                      <div key={k} className="elx-menu__group">
                        <div className="elx-menu__sub">{label}</div>
                        {[2, 3, 4, 5].map((n) => (
                          <button
                            key={`${k}${n}`}
                            type="button"
                            className="elx-menu__item"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => { editor.chain().focus().setDropCap(k, n).run(); close(); }}
                          >
                            {n} lignes
                          </button>
                        ))}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="elx-menu__item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { editor.chain().focus().setDropCap("none").run(); close(); }}
                    >
                      Aucune lettrine
                    </button>
                  </>
                )}
              </Dropdown>
              <Cmd big label="Filigrane" title="Filigrane du document" onClick={() => onOpenWatermark?.()}><Droplets size={19} /></Cmd>
            </Group>
            <Group title="Signature">
              <Cmd big label="Signer" title="Ajouter une signature" onClick={onAddSignature}><PenLine size={19} /></Cmd>
            </Group>
          </>
        )}

        {tab === "references" && (
          <>
            <Group title="Table des matières">
              <Cmd big label="Table des matières" title="Insérer une table des matières qui se met à jour" onClick={() => editor.chain().focus().insertTableOfContents().run()}><ListTree size={19} /></Cmd>
              <Cmd
                big
                label="Numéroter"
                title="Numéroter les titres (1. / 1.1 / 1.1.1)"
                active={!!numberedHeadings}
                onClick={() => onToggleNumberedHeadings?.()}
              >
                <Hash size={19} />
              </Cmd>
            </Group>

            <Group title="Renvois">
              <Cmd big label="Renvoi" title="Insérer un renvoi vers un titre, un signet, une figure, un tableau ou une note" onClick={() => onOpenCrossRef?.()}><CornerDownRight size={19} /></Cmd>
              <Cmd title="Signet (cible de renvoi)" onClick={addBookmark}><BookmarkIcon size={17} /></Cmd>
            </Group>

            <Group title="Notes">
              <Cmd big label="Note" title="Insérer une note de bas de page" onClick={addFootnote}><Superscript size={19} /></Cmd>
              <Cmd big label="Note de fin" title="Insérer une note de fin (numérotation i, ii, iii)" onClick={addEndnote}><StickyNote size={19} /></Cmd>
              <Dropdown title="Convertir les notes" icon={<ArrowLeftRight size={17} />}>
                {(close) => (
                  <>
                    <div className="elx-menu__title">Convertir les notes</div>
                    <button
                      type="button"
                      className="elx-menu__item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { editor.chain().focus().convertNotesTo("endnote").run(); close(); }}
                    >
                      Notes de bas de page → notes de fin
                    </button>
                    <button
                      type="button"
                      className="elx-menu__item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { editor.chain().focus().convertNotesTo("footnote").run(); close(); }}
                    >
                      Notes de fin → notes de bas de page
                    </button>
                  </>
                )}
              </Dropdown>
            </Group>

            <Group title="Légendes">
              <Cmd big label="Légende" title="Insérer une légende numérotée" onClick={() => onOpenCaption?.()}><Tag size={19} /></Cmd>
              <Dropdown title="Table des illustrations" icon={<GalleryVerticalEnd size={17} />}>
                {(close) => (
                  <>
                    <div className="elx-menu__title">Table des illustrations</div>
                    {["Figure", "Tableau", "Équation"].map((l) => (
                      <button
                        key={l}
                        type="button"
                        className="elx-menu__item"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          editor.chain().focus().insertTableOfFigures(l).run();
                          close();
                        }}
                      >
                        {figureTableTitle(l)}
                      </button>
                    ))}
                    <div className="elx-menu__sep" />
                    <button
                      type="button"
                      className="elx-menu__item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        editor.chain().focus().insertTableOfFigures("").run();
                        close();
                      }}
                    >
                      Toutes les légendes
                    </button>
                  </>
                )}
              </Dropdown>
            </Group>

            <Group title="Index">
              <Cmd
                big
                label="Marquer"
                title="Marquer une entrée d'index"
                onClick={() => onOpenIndexEntry?.()}
              >
                <ScanSearch size={19} />
              </Cmd>
              <Cmd big label="Index" title="Insérer l'index alphabétique" onClick={() => editor.chain().focus().insertIndexBlock().run()}><ListTree size={19} /></Cmd>
            </Group>
          </>
        )}

        {tab === "merge" && (
          <>
            <Group title="Publipostage">
              <Cmd big label="Assistant" title="Source de données, aperçu et fusion" onClick={() => onOpenMailMerge?.()}><Users size={19} /></Cmd>
            </Group>
            <Group title="Champs">
              <Cmd
                big
                label="Champ"
                title="Insérer un champ de fusion (nommez-le librement)"
                onClick={addMergeField}
              >
                <Braces size={19} />
              </Cmd>
            </Group>
          </>
        )}

        {tab === "layout" && (
          <>
            <Group title="Page">
              <Cmd big label="Mise en page" title="Format, marges, en-tête, pied de page" onClick={() => onOpenPageSettings?.()}><FileCog size={19} /></Cmd>
            </Group>

            <Group title="Colonnes">
              <Dropdown big label="Colonnes" title="Disposer le texte en colonnes" icon={<Columns size={19} />}>
                {(close) => (
                  <>
                    <div className="elx-menu__title">Colonnes</div>
                    {[1, 2, 3, 4].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`elx-menu__item ${columnCount === n ? "is-active" : ""}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          const chain = editor.chain().focus();
                          if (n <= 1) chain.unsetColumns().run();
                          else if (editor.isActive("columnSection")) chain.updateColumns({ count: n }).run();
                          else chain.setColumns({ count: n }).run();
                          close();
                        }}
                      >
                        <span className="elx-listprev" aria-hidden="true">
                          <span>{"▌".repeat(n)}</span>
                        </span>
                        <span>{n === 1 ? "Une (pleine largeur)" : `${n} colonnes`}</span>
                      </button>
                    ))}
                    <div className="elx-menu__sep" />
                    <button
                      type="button"
                      className="elx-menu__item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onOpenColumns?.();
                        close();
                      }}
                    >
                      Autres colonnes…
                    </button>
                  </>
                )}
              </Dropdown>
            </Group>

            <Group title="Sauts">
              <Dropdown big label="Sauts" title="Saut de page ou de section" icon={<SplitSquareVertical size={19} />}>
                {(close) => (
                  <>
                    <div className="elx-menu__title">Sauts de page</div>
                    <button
                      type="button"
                      className="elx-menu__item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        editor.chain().focus().insertPageBreak().run();
                        close();
                      }}
                    >
                      Saut de page
                    </button>
                    <div className="elx-menu__sep" />
                    <div className="elx-menu__title">Sauts de section</div>
                    {([
                      ["nextPage", "Page suivante"],
                      ["continuous", "Continu"],
                      ["evenPage", "Page paire"],
                      ["oddPage", "Page impaire"],
                    ] as const).map(([kind, label]) => (
                      <button
                        key={kind}
                        type="button"
                        className="elx-menu__item"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          editor
                            .chain()
                            .focus()
                            .insertSectionBreak({ kind, orientation: "", restartNumbering: false, startAt: 1, header: "", footer: "" })
                            .run();
                          close();
                        }}
                      >
                        {label}
                      </button>
                    ))}
                    <div className="elx-menu__sep" />
                    <button
                      type="button"
                      className="elx-menu__item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onOpenSectionBreak?.();
                        close();
                      }}
                    >
                      Saut de section paramétré…
                    </button>
                  </>
                )}
              </Dropdown>
            </Group>

            <Group title="Titres">
              <Cmd
                big
                label="Numéroter"
                title="Numéroter les titres (1. / 1.1 / 1.1.1)"
                active={!!numberedHeadings}
                onClick={() => onToggleNumberedHeadings?.()}
              >
                <Hash size={19} />
              </Cmd>
            </Group>
            <Group title="Retrait">
              <Cmd title="Diminuer le retrait" onClick={() => editor.chain().focus().outdent().run()}><Outdent size={17} /></Cmd>
              <Cmd title="Augmenter le retrait" onClick={() => editor.chain().focus().indent().run()}><Indent size={17} /></Cmd>
            </Group>
          </>
        )}

        {tab === "review" && (
          <>
            <Group title="Suivi">
              <Cmd
                big
                label="Suggestions"
                title="Suivi des modifications (mode suggestion)"
                active={isSuggesting(editor.state)}
                onClick={() => editor.chain().focus().toggleSuggesting().run()}
              >
                <Pencil size={19} />
              </Cmd>
              <Cmd title="Accepter toutes les modifications" onClick={() => editor.chain().focus().acceptAllChanges().run()}><Check size={17} /></Cmd>
              <Cmd title="Refuser toutes les modifications" danger onClick={() => editor.chain().focus().rejectAllChanges().run()}><X size={17} /></Cmd>
            </Group>
            <Group title="Commentaires">
              <Cmd
                big
                label="Commenter"
                title="Commenter la sélection"
                disabled={editor.state.selection.empty}
                onClick={addComment}
              >
                <MessageSquarePlus size={19} />
              </Cmd>
            </Group>
            <Group title="Comparer">
              <Cmd
                big
                label="Comparer"
                title="Comparer avec une autre version et voir les différences en suggestions"
                onClick={() => onOpenCompare?.()}
              >
                <GitCompareArrows size={19} />
              </Cmd>
            </Group>
            <Group title="Analyse">
              <Cmd big label="Statistiques" title="Mots, lisibilité, structure" onClick={() => onOpenStats?.()}><BarChart3 size={19} /></Cmd>
            </Group>
          </>
        )}

        {tab === "view" && (
          <>
            <Group title="Volets">
              <Cmd big label="Plan" title="Volet de navigation (plan du document)" active={!!outlineOpen} onClick={() => onToggleOutline?.()}><PanelLeft size={19} /></Cmd>
              <Cmd big label="Inspecteur" title="Volet de droite (commentaires, signatures, versions)" active={!!inspectorOpen} onClick={() => onToggleInspector?.()}><PanelRight size={19} /></Cmd>
            </Group>
            <Group title="Afficher">
              <Cmd
                big
                label="Règle"
                title="Règle graduée (poser des taquets de tabulation)"
                active={!!rulerVisible}
                onClick={() => onToggleRuler?.()}
              >
                <Ruler size={19} />
              </Cmd>
            </Group>
            <Group title="Document">
              <Cmd title="Table des matières" onClick={() => editor.chain().focus().insertTableOfContents().run()}><ListTree size={17} /></Cmd>
              <Cmd title="Statistiques" onClick={() => onOpenStats?.()}><BarChart3 size={17} /></Cmd>
            </Group>
          </>
        )}
      </div>

      {/* Contextual strips — always visible when they apply, whatever the tab. */}
      {(editor.isActive("figure") || editor.isActive("table") || editor.isActive("codeBlock") || editor.isActive("columnSection") || isSuggesting(editor.state)) && (
        <div className="elx-optionbar">
          {editor.isActive("columnSection") && (
            <>
              <span className="elx-optionbar__title"><Columns size={13} /> Colonnes</span>
              {[1, 2, 3, 4].map((n) => (
                <Cmd
                  key={n}
                  title={n === 1 ? "Une colonne (supprimer les colonnes)" : `${n} colonnes`}
                  active={columnCount === n}
                  onClick={() => {
                    const chain = editor.chain().focus();
                    if (n <= 1) chain.unsetColumns().run();
                    else chain.updateColumns({ count: n }).run();
                  }}
                >
                  <span className="elx-colcount">{n}</span>
                </Cmd>
              ))}
              <Cmd
                title="Ligne séparatrice"
                active={editor.getAttributes("columnSection").separator === true}
                onClick={() =>
                  editor.chain().focus().updateColumns({ separator: !(editor.getAttributes("columnSection").separator === true) }).run()
                }
              >
                <SeparatorHorizontal size={16} style={{ transform: "rotate(90deg)" }} />
              </Cmd>
              <Cmd title="Autres colonnes…" onClick={() => onOpenColumns?.()}><FileCog size={16} /></Cmd>
            </>
          )}

          {editor.isActive("figure") && (
            <>
              <span className="elx-optionbar__title"><ImageIcon size={13} /> Image</span>
              <Cmd title="Aligner à gauche (habillage)" active={editor.getAttributes("figure").align === "left"} onClick={() => editor.chain().focus().setFigureAlign("left").run()}><AlignLeft size={16} /></Cmd>
              <Cmd title="Centrer" active={editor.getAttributes("figure").align === "center"} onClick={() => editor.chain().focus().setFigureAlign("center").run()}><AlignCenter size={16} /></Cmd>
              <Cmd title="Aligner à droite (habillage)" active={editor.getAttributes("figure").align === "right"} onClick={() => editor.chain().focus().setFigureAlign("right").run()}><AlignRight size={16} /></Cmd>
              <select
                className="elx-select elx-select--size"
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
            </>
          )}

          {editor.isActive("table") && (
            <>
              <span className="elx-optionbar__title"><TableIcon size={13} /> Tableau</span>
              <Cmd title="Insérer une ligne" onClick={() => editor.chain().focus().addRowAfter().run()}><Plus size={16} /></Cmd>
              <Cmd title="Insérer une colonne" onClick={() => editor.chain().focus().addColumnAfter().run()}><Plus size={16} style={{ transform: "rotate(90deg)" }} /></Cmd>
              <Cmd title="Fusionner les cellules" onClick={() => editor.chain().focus().mergeCells().run()}><Combine size={16} /></Cmd>
              <Cmd title="Scinder la cellule" onClick={() => editor.chain().focus().splitCell().run()}><Split size={16} /></Cmd>
              <Cmd title="Supprimer la ligne" onClick={() => editor.chain().focus().deleteRow().run()}><Minus size={16} /></Cmd>
              <Cmd title="Supprimer la colonne" onClick={() => editor.chain().focus().deleteColumn().run()}><Minus size={16} style={{ transform: "rotate(90deg)" }} /></Cmd>
              <Cmd title="Supprimer le tableau" danger onClick={() => editor.chain().focus().deleteTable().run()}><Trash2 size={16} /></Cmd>
              <span className="elx-optionbar__sep" />
              <select
                className="elx-select"
                title="Style du tableau"
                value={(editor.getAttributes("table").tableStyle as string) || DEFAULT_TABLE_STYLE}
                onChange={(e) => editor.chain().focus().setTableStyle(e.target.value as never).run()}
              >
                {TABLE_STYLES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
              <select
                className="elx-select"
                title="Ajustement automatique"
                value={(editor.getAttributes("table").tableFit as string) || "auto"}
                onChange={(e) => editor.chain().focus().setTableFit(e.target.value as never).run()}
              >
                {(Object.keys(TABLE_FIT_LABELS) as (keyof typeof TABLE_FIT_LABELS)[]).map((f) => (
                  <option key={f} value={f}>{TABLE_FIT_LABELS[f]}</option>
                ))}
              </select>
              {/* Alignement vertical dans la cellule : les trois valeurs de w:vAlign. */}
              <Cmd
                title="Aligner en haut de la cellule"
                active={(editor.getAttributes("tableCell").vAlign ?? "top") === "top"}
                onClick={() => editor.chain().focus().setCellVAlign("top").run()}
              ><AlignStartVertical size={16} /></Cmd>
              <Cmd
                title="Centrer verticalement dans la cellule"
                active={editor.getAttributes("tableCell").vAlign === "center"}
                onClick={() => editor.chain().focus().setCellVAlign("center").run()}
              ><AlignCenterVertical size={16} /></Cmd>
              <Cmd
                title="Aligner en bas de la cellule"
                active={editor.getAttributes("tableCell").vAlign === "bottom"}
                onClick={() => editor.chain().focus().setCellVAlign("bottom").run()}
              ><AlignEndVertical size={16} /></Cmd>
              <span className="elx-optionbar__sep" />
              <Cmd
                title="Trier ce tableau sur la colonne du curseur (croissant)"
                onClick={() => editor.chain().focus().sortTableRows(currentCellIndex(editor), "asc").run()}
              ><ArrowDownAZ size={16} /></Cmd>
              <Cmd
                title="Trier ce tableau sur la colonne du curseur (décroissant)"
                onClick={() => editor.chain().focus().sortTableRows(currentCellIndex(editor), "desc").run()}
              ><ArrowUpAZ size={16} /></Cmd>
            </>
          )}

          {editor.isActive("codeBlock") && (
            <>
              <span className="elx-optionbar__title"><Code2 size={13} /> Code</span>
              <select
                className="elx-select"
                title="Langage du bloc de code"
                value={(editor.getAttributes("codeBlock").language as string) || "plaintext"}
                onChange={(e) => editor.chain().focus().updateAttributes("codeBlock", { language: e.target.value }).run()}
              >
                {CODE_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </>
          )}

          {isSuggesting(editor.state) && (
            <>
              <span className="elx-optionbar__title"><Pencil size={13} /> Suivi actif</span>
              <Cmd title="Accepter toutes les modifications" onClick={() => editor.chain().focus().acceptAllChanges().run()}><Check size={16} /></Cmd>
              <Cmd title="Refuser toutes les modifications" danger onClick={() => editor.chain().focus().rejectAllChanges().run()}><X size={16} /></Cmd>
            </>
          )}
        </div>
      )}
    </div>
  );
}
