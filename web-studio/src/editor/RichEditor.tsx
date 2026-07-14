import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { buildExtensions } from "./extensions";
import Toolbar from "./Toolbar";
import EditorStatusBar from "./EditorStatusBar";
import FindReplaceBar from "./FindReplaceBar";
import SignatureLayer from "../sign/SignatureLayer";
import type {
  EliumDocumentModel,
  EliumSignature,
  ProseMirrorNode,
  SignatureVerdict,
} from "../format/types";
import { pageSizeMm } from "../format/pageSizes";

interface RichEditorProps {
  documentModel: EliumDocumentModel;
  editable: boolean;
  signatures: EliumSignature[];
  selectedSignatureId: string | null;
  verdicts?: Record<string, SignatureVerdict>;
  onDocChange: (doc: ProseMirrorNode) => void;
  onAddSignatureRequest: () => void;
  onUpdateSignature: (sig: EliumSignature) => void;
  onSelectSignature: (id: string | null) => void;
  onRemoveSignature: (id: string) => void;
  onEditorReady?: (editor: Editor | null) => void;
  commentAuthor?: string;
  numberedHeadings?: boolean;
  onToggleNumberedHeadings?: () => void;
  onOpenPageSettings?: () => void;
  /** Document title, used to expand the {titre} token in header/footer. */
  docTitle?: string;
}

export default function RichEditor({
  documentModel,
  editable,
  signatures,
  selectedSignatureId,
  verdicts,
  onDocChange,
  onAddSignatureRequest,
  onUpdateSignature,
  onSelectSignature,
  onRemoveSignature,
  onEditorReady,
  commentAuthor,
  numberedHeadings,
  onToggleNumberedHeadings,
  onOpenPageSettings,
  docTitle,
}: RichEditorProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor(
    {
      extensions: buildExtensions({ editable, author: commentAuthor }),
      content: documentModel.doc,
      editable,
      editorProps: { attributes: { class: "elium-prose" } },
      onUpdate: ({ editor }) => onDocChange(editor.getJSON() as ProseMirrorNode),
    },
    [],
  );

  // Expose the editor instance to sibling panels (e.g. the comments panel).
  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  // Find (Ctrl/Cmd+F) and replace (Ctrl/Cmd+H) — intercept the browser default.
  const [find, setFind] = useState<{ open: boolean; replace: boolean }>({ open: false, replace: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "f") {
        e.preventDefault();
        setFind({ open: true, replace: false });
      } else if (k === "h" && editable) {
        e.preventDefault();
        setFind({ open: true, replace: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable]);

  const handleInsertImage = () => fileInputRef.current?.click();

  const onImageSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editor) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Insert as a Figure (image + editable caption + alignment) rather than a
      // bare image, so authors can caption and wrap it.
      editor.chain().focus().setFigure({ src: reader.result as string, alt: file.name }).run();
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // Internal-link navigation: clicking an anchor whose href is "#id" scrolls to
  // the matching bookmark/element inside the page (cross-references & signets).
  const handleScrollClick = (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest("a[href^='#']") as HTMLAnchorElement | null;
    if (anchor) {
      const id = decodeURIComponent((anchor.getAttribute("href") || "").slice(1));
      if (id) {
        const target = pageRef.current?.querySelector(
          `[id="${CSS.escape(id)}"], [data-bookmark-id="${CSS.escape(id)}"]`,
        );
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
      }
    }
    onSelectSignature(null);
  };

  const page = documentModel.page;
  // Physical size is computed (not hard-coded per format×orientation CSS class)
  // so every format/orientation combination — including Letter + landscape —
  // renders correctly on screen, matching what DOCX/PDF export already do.
  const pageClass = `elium-page${numberedHeadings ? " elium-page--numbered" : ""}`;
  const { width: pageWidthMm, height: pageHeightMm } = pageSizeMm(page.format, page.orientation);

  // Expand header/footer field tokens for display ({titre}, {date}).
  const renderField = (tpl: string) =>
    tpl.replace(/\{titre\}/gi, docTitle ?? "").replace(/\{date\}/gi, new Date().toLocaleDateString("fr-FR"));

  return (
    <div className="editor-shell">
      {editable && (
        <Toolbar editor={editor} onInsertImage={handleInsertImage} onAddSignature={onAddSignatureRequest} commentAuthor={commentAuthor} numberedHeadings={numberedHeadings} onToggleNumberedHeadings={onToggleNumberedHeadings} onOpenPageSettings={onOpenPageSettings} />
      )}

      {find.open && editor && (
        <FindReplaceBar
          editor={editor}
          canReplace={editable}
          startWithReplace={find.replace}
          onClose={() => setFind({ open: false, replace: false })}
        />
      )}

      <div className="editor-scroll" onClick={handleScrollClick}>
        <div
          ref={pageRef}
          className={pageClass}
          style={{
            width: `${pageWidthMm}mm`,
            minHeight: `${pageHeightMm}mm`,
            paddingTop: `${page.margins.top}mm`,
            paddingRight: `${page.margins.right}mm`,
            paddingBottom: `${page.margins.bottom}mm`,
            paddingLeft: `${page.margins.left}mm`,
          }}
        >
          {page.header && <div className="elium-page__header">{renderField(page.header)}</div>}
          <EditorContent editor={editor} />
          {page.footer && <div className="elium-page__footer">{renderField(page.footer)}</div>}

          <SignatureLayer
            pageRef={pageRef}
            signatures={signatures}
            editable={editable}
            selectedId={selectedSignatureId}
            verdicts={verdicts}
            onSelect={onSelectSignature}
            onChange={onUpdateSignature}
            onRemove={onRemoveSignature}
          />
        </div>
      </div>

      <EditorStatusBar editor={editor} />

      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onImageSelected} />
    </div>
  );
}
