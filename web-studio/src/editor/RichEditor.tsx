import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { buildExtensions } from "./extensions";
import Toolbar from "./Toolbar";
import EditorStatusBar from "./EditorStatusBar";
import FindReplaceBar from "./FindReplaceBar";
import StatsDialog from "./StatsDialog";
import FontDialog from "./FontDialog";
import ParagraphDialog from "./ParagraphDialog";
import StylesManager from "./StylesManager";
import CaptionModal from "./CaptionModal";
import CrossRefModal from "./CrossRefModal";
import IndexEntryModal from "./IndexEntryModal";
import ColumnsModal from "./ColumnsModal";
import SectionBreakModal from "./SectionBreakModal";
import CompareModal from "./CompareModal";
import MailMergeModal from "./MailMergeModal";
import { ensureListSchemeStyles } from "./listSchemeStyles";
import { setMergePreview, setPageResolver } from "./wordExtensions";
import { setStyleRegistry } from "./styleExtension";
import { clampZoom, resolveZoom, stepZoom, type ZoomMode } from "./zoom";
import { hasMixedGeometry, sectionGeometry, splitSections } from "./sections";
import Ruler from "./Ruler";
import SymbolModal from "./SymbolModal";
import WatermarkModal from "./WatermarkModal";
import { watermarkCss } from "./ornaments";
import SignatureLayer from "../sign/SignatureLayer";
import type {
  EliumDocStyle,
  EliumDocumentModel,
  EliumSignature,
  ProseMirrorNode,
  SignatureVerdict,
  EliumWatermark,
} from "../format/types";
import { pageSizeOf } from "../format/pageSizes";
import {
  CSS_PX_PER_MM, pageAt,
  type PageMetrics, type PageInfo, type PagePlan, type PaginationOptions,
  type SectionInset, type SectionMetrics,
} from "./Pagination";

/** Visual gap drawn between two page sheets, in px. */
const SHEET_GAP_PX = 40;

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
  /** Navigation pane state, owned by the view. */
  outlineOpen?: boolean;
  onToggleOutline?: () => void;
  /** Right inspector state, owned by the view. */
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  /** Document title, used to expand the {titre} token in header/footer. */
  docTitle?: string;
  /** Persist the document's own named styles. */
  onStylesChange?: (styles: EliumDocStyle[]) => void;
  /** Le filigrane appartient au document : c'est la vue qui le persiste. */
  onWatermarkChange?: (mark: EliumWatermark) => void;
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
  outlineOpen,
  onToggleOutline,
  inspectorOpen,
  onToggleInspector,
  docTitle,
  onStylesChange,
  onWatermarkChange,
}: RichEditorProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // On-screen pagination: the plugin reads live page metrics through this ref
  // (updated each render below) and reports the page count back into state.
  const metricsRef = useRef<PageMetrics | null>(null);
  const sectionMetricsRef = useRef<SectionMetrics[] | null>(null);
  const sectionInsetsRef = useRef<SectionInset[]>([]);
  const planRef = useRef<PagePlan | null>(null);
  const [pageInfo, setPageInfo] = useState<PageInfo>({ pageCount: 1, currentPage: 1 });
  const [plan, setPlan] = useState<PagePlan | null>(null);
  const paginationOpts = useRef<PaginationOptions>({
    getMetrics: () => metricsRef.current,
    getSectionMetrics: () => sectionMetricsRef.current,
    getSectionInsets: () => sectionInsetsRef.current,
    onInfo: (i) =>
      setPageInfo((prev) => (prev.pageCount === i.pageCount && prev.currentPage === i.currentPage ? prev : i)),
    onPlan: (p) => {
      planRef.current = p;
      // Mixed-geometry documents draw one sheet per planned page, so the layer
      // needs the plan in React state (uniform documents ignore it).
      setPlan((prev) =>
        prev &&
        prev.pages.length === p.pages.length &&
        prev.pages.every(
          (q, i) =>
            q.top === p.pages[i]!.top && q.height === p.pages[i]!.height && q.sectionIndex === p.pages[i]!.sectionIndex,
        )
          ? prev
          : p,
      );
    },
  }).current;

  const editor = useEditor(
    {
      extensions: buildExtensions({ editable, author: commentAuthor, pagination: paginationOpts }),
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

  // The multilevel-list rules are generated from the scheme table, so inject
  // them once rather than duplicating them by hand in the stylesheet.
  useEffect(() => {
    ensureListSchemeStyles();
  }, []);

  // Publish the document's own named styles to the style commands. Kept out of
  // the extension options so editing a style does not rebuild the editor.
  useEffect(() => {
    setStyleRegistry(documentModel.styles as never);
  }, [documentModel.styles]);

  // Page numbers for renvois and the generated index come from the pagination
  // plan — the same numbers the reader sees in the status bar.
  useEffect(() => {
    if (!editor) return;
    setPageResolver((pos) => {
      const plan = planRef.current;
      return plan ? pageAt(plan, editor.state, pos) : 1;
    });
    return () => {
      setPageResolver(null);
      setMergePreview(null);
    };
  }, [editor]);

  // Find (Ctrl/Cmd+F) and replace (Ctrl/Cmd+H) — intercept the browser default.
  const [find, setFind] = useState<{ open: boolean; replace: boolean }>({ open: false, replace: false });
  const [statsOpen, setStatsOpen] = useState(false);
  // Word-parity dialogs (renvoi, index, colonnes, section, comparaison, fusion).
  type WordDialog = "xref" | "index" | "columns" | "section" | "compare" | "merge" | "font" | "paragraph" | "styles" | "caption" | "symbol" | "watermark" | null;
  const [dialog, setDialog] = useState<WordDialog>(null);

  // --- Zoom ---------------------------------------------------------------
  // The sheet has a physical width, so on a narrow pane it cannot fit: the zoom
  // fits it to the width instead of forcing horizontal scrolling. Applied as a
  // transform, which leaves layout (and therefore pagination) untouched.
  const scrollRef = useRef<HTMLDivElement>(null);
  // La règle est masquée par défaut : elle ne sert qu'à qui pose des taquets,
  // et elle mange de la hauteur utile sur un petit écran.
  const [rulerVisible, setRulerVisible] = useState(false);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fitWidth");
  const [manualZoom, setManualZoom] = useState(1);
  const [zoom, setZoom] = useState(1);
  /** Unscaled height of the sheet, measured — drives the scaled footprint. */
  const [sheetHeight, setSheetHeight] = useState(0);

  /** A manual zoom from the UI also leaves any fit mode. */
  const setZoomFromUi = useCallback((z: number) => {
    setZoomMode("manual");
    setManualZoom(clampZoom(z));
  }, []);
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

  // --- Sections -----------------------------------------------------------
  // Every section resolves to its own physical geometry. When they all agree
  // (the usual case) the editor keeps the single-sheet fast path; when they
  // differ, the sheet stack below draws one sheet per page at ITS section's
  // size, and the text of each section is inset to its own content width.
  const sections = useMemo(() => splitSections(documentModel.doc, page), [documentModel.doc, page]);
  const geometries = useMemo(() => sections.map((s) => sectionGeometry(s.setup)), [sections]);
  const mixedGeometry = useMemo(() => hasMixedGeometry(sections), [sections]);

  // Physical size is computed (not hard-coded per format×orientation CSS class)
  // so every format/orientation combination — including Letter + landscape —
  // renders correctly on screen, matching what DOCX/PDF export already do.
  // With mixed sections the container takes the WIDEST sheet.
  const pageClass = `elium-page${numberedHeadings ? " elium-page--numbered" : ""}`;
  const docSize = pageSizeOf(page);
  const widest = geometries.reduce((max, g) => Math.max(max, g.widthMm), docSize.width);
  const pageWidthMm = mixedGeometry ? widest : docSize.width;
  const pageHeightMm = mixedGeometry ? (geometries[0]?.heightMm ?? docSize.height) : docSize.height;
  /** Margins of the first section — what the single sheet uses for padding. */
  const baseMargins = mixedGeometry ? geometries[0]?.margins ?? page.margins : page.margins;

  // Refresh the pagination metrics from the current page geometry. `mm` renders
  // at a fixed 96px/25.4 in CSS, so the printable content height and side
  // margins convert deterministically (no DOM measurement / zoom assumptions).
  metricsRef.current = {
    pageContentPx: Math.max(0, (pageHeightMm - baseMargins.top - baseMargins.bottom) * CSS_PX_PER_MM),
    gapPx: SHEET_GAP_PX,
    marginLeftPx: baseMargins.left * CSS_PX_PER_MM,
    marginRightPx: baseMargins.right * CSS_PX_PER_MM,
  };

  // Per-section metrics + insets, only when the geometries actually differ.
  sectionMetricsRef.current = mixedGeometry
    ? geometries.map((g, i) => ({
        pageContentPx: Math.max(0, (g.heightMm - g.margins.top - g.margins.bottom) * CSS_PX_PER_MM),
        pageTotalPx: g.heightMm * CSS_PX_PER_MM,
        gapPx: SHEET_GAP_PX,
        marginLeftPx: g.margins.left * CSS_PX_PER_MM,
        marginRightPx: g.margins.right * CSS_PX_PER_MM,
        restartAt: sections[i]?.setup.restartNumbering ? sections[i]!.setup.startAt : null,
      }))
    : null;
  // The container is padded with the FIRST section's margins, so a section's
  // extra inset is the difference: half the width gap plus its own margin delta.
  sectionInsetsRef.current = mixedGeometry
    ? geometries.map((g) => {
        const sidePx = ((widest - g.widthMm) / 2) * CSS_PX_PER_MM;
        return {
          leftPx: Math.max(0, Math.round(sidePx + (g.margins.left - baseMargins.left) * CSS_PX_PER_MM)),
          rightPx: Math.max(0, Math.round(sidePx + (g.margins.right - baseMargins.right) * CSS_PX_PER_MM)),
        };
      })
    : [];

  // Expand header/footer field tokens for display ({titre}, {date}).
  const renderField = (tpl: string) =>
    tpl.replace(/\{titre\}/gi, docTitle ?? "").replace(/\{date\}/gi, new Date().toLocaleDateString("fr-FR"));

  // Recompute the zoom whenever the pane, the page geometry or the content
  // height changes. `fitWidth` is the default so a phone shows a readable page
  // straight away; on a roomy screen it resolves to (at most) 100%.
  const pageWidthPx = pageWidthMm * CSS_PX_PER_MM;
  const pageHeightPx = pageHeightMm * CSS_PX_PER_MM;
  useEffect(() => {
    const scroll = scrollRef.current;
    const sheet = pageRef.current;
    if (!scroll) return;
    const recompute = () => {
      const style = getComputedStyle(scroll);
      const gutter = parseFloat(style.paddingLeft) || 0;
      const input = {
        viewportWidth: scroll.clientWidth,
        viewportHeight: scroll.clientHeight,
        pageWidth: pageWidthPx,
        pageHeight: pageHeightPx,
        gutter,
      };
      // "fitWidth" never magnifies beyond 100%: a document is not meant to be
      // blown up just because the window is wide.
      const raw = resolveZoom(zoomMode, manualZoom, input);
      const next = zoomMode === "fitWidth" ? Math.min(1, raw) : raw;
      setZoom((prev) => (Math.abs(prev - next) < 0.005 ? prev : next));
      const h = sheet?.offsetHeight ?? 0;
      setSheetHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h));
    };
    recompute();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(recompute) : null;
    ro?.observe(scroll);
    if (sheet) ro?.observe(sheet);
    // `resize` as well as the observer: ResizeObserver only delivers while the
    // page is producing frames, so a window resize in a background tab (or a
    // host that is not compositing) would otherwise leave the zoom stale.
    window.addEventListener("resize", recompute);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [zoomMode, manualZoom, pageWidthPx, pageHeightPx, pageInfo.pageCount]);

  // Ctrl/Cmd + wheel zooms, like every document editor.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoomMode("manual");
      setManualZoom((z) => stepZoom(z, e.deltaY < 0 ? 1 : -1));
    };
    scroll.addEventListener("wheel", onWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="editor-shell">
      {editable && (
        <Toolbar
          editor={editor}
          onInsertImage={handleInsertImage}
          onAddSignature={onAddSignatureRequest}
          commentAuthor={commentAuthor}
          numberedHeadings={numberedHeadings}
          onToggleNumberedHeadings={onToggleNumberedHeadings}
          onOpenPageSettings={onOpenPageSettings}
          onOpenStats={() => setStatsOpen(true)}
          outlineOpen={outlineOpen}
          onToggleOutline={onToggleOutline}
          inspectorOpen={inspectorOpen}
          onToggleInspector={onToggleInspector}
          onToggleFind={() => setFind((f) => ({ open: !f.open, replace: f.replace }))}
          onOpenCrossRef={() => setDialog("xref")}
          onOpenIndexEntry={() => setDialog("index")}
          onOpenColumns={() => setDialog("columns")}
          onOpenSectionBreak={() => setDialog("section")}
          onOpenCompare={() => setDialog("compare")}
          onOpenMailMerge={() => setDialog("merge")}
          onOpenFont={() => setDialog("font")}
          onOpenParagraph={() => setDialog("paragraph")}
          onOpenStyles={() => setDialog("styles")}
          onOpenCaption={() => setDialog("caption")}
          onOpenSymbol={() => setDialog("symbol")}
          onOpenWatermark={() => setDialog("watermark")}
          rulerVisible={rulerVisible}
          onToggleRuler={() => setRulerVisible((v) => !v)}
        />
      )}

      {find.open && editor && (
        <FindReplaceBar
          editor={editor}
          canReplace={editable}
          startWithReplace={find.replace}
          onClose={() => setFind({ open: false, replace: false })}
        />
      )}

      {/* La règle vit HORS de la zone de défilement : elle doit rester visible
          quand on descend dans le document, comme dans Word. Elle reçoit le zoom
          pour que ses graduations tombent bien au-dessus de la feuille. */}
      {rulerVisible && (
        <Ruler
          editor={editor}
          widthMm={pageWidthMm}
          marginLeftMm={baseMargins.left}
          marginRightMm={baseMargins.right}
          zoom={zoom}
        />
      )}

      <div className="editor-scroll" ref={scrollRef} onClick={handleScrollClick}>
        {/* Zoom in two layers. The OUTER box reserves the scaled footprint in
            layout px (a transform occupies no space, so without it the scroll
            area would still reserve the full-size sheet). The INNER box carries
            the transform. Layout inside the sheet is therefore never scaled,
            which is what keeps the pagination engine measuring true block
            heights — its page plan is identical at every zoom level. */}
        <div
          className="elium-zoom"
          style={
            zoom === 1
              ? { width: `${pageWidthMm}mm` }
              : {
                  width: `${Math.round(pageWidthPx * zoom)}px`,
                  height: sheetHeight > 0 ? `${Math.round(sheetHeight * zoom)}px` : undefined,
                }
          }
        >
        <div
          className="elium-zoom__inner"
          style={
            zoom === 1
              ? undefined
              : { width: `${pageWidthMm}mm`, transform: `scale(${zoom})`, transformOrigin: "top left" }
          }
        >
        <div
          ref={pageRef}
          className={`${pageClass}${mixedGeometry ? " elium-page--stacked" : ""}`}
          style={{
            width: `${pageWidthMm}mm`,
            minHeight: `${pageHeightMm}mm`,
            paddingTop: `${baseMargins.top}mm`,
            paddingRight: `${baseMargins.right}mm`,
            paddingBottom: `${baseMargins.bottom}mm`,
            paddingLeft: `${baseMargins.left}mm`,
            // Le filigrane est un FOND, pas un élément : il ne doit être ni
            // sélectionnable, ni dans le flux, ni compté par la pagination — et
            // un fond s'imprime, contrairement à un pseudo-élément positionné
            // que certains moteurs escamotent. Il se répète pour couvrir chaque
            // page d'un document à feuille unique.
            backgroundImage: watermarkCss(
              documentModel.watermark as never,
              pageWidthMm,
              pageHeightMm,
            ) || undefined,
            backgroundRepeat: "repeat-y",
            backgroundPosition: "top center",
          }}
        >
          {/* Mixed sections: the container is transparent and each page is drawn
              as its OWN sheet, at its section's width/height and offset (taken
              from the pagination plan). Uniform documents keep the single sheet. */}
          {mixedGeometry && plan && (
            <div className="elium-sheets" aria-hidden="true">
              {plan.pages.map((p, i) => {
                const g = geometries[Math.min(p.sectionIndex, geometries.length - 1)] ?? geometries[0];
                if (!g) return null;
                return (
                  <div
                    key={`${i}-${p.top}`}
                    className="elium-sheet"
                    style={{
                      top: `${p.top}px`,
                      height: `${p.height}px`,
                      width: `${g.widthMm}mm`,
                      left: `${((widest - g.widthMm) / 2) * CSS_PX_PER_MM - baseMargins.left * CSS_PX_PER_MM}px`,
                    }}
                  />
                );
              })}
            </div>
          )}
          {/* Header/footer of the FIRST section (the sheet the reader starts on);
              per-section header text is honoured by the DOCX/PDF export. */}
          {(sections[0]?.setup.header || page.header) && (
            <div className="elium-page__header">{renderField(sections[0]?.setup.header || page.header || "")}</div>
          )}
          <EditorContent editor={editor} />
          {(sections[0]?.setup.footer || page.footer) && (
            <div className="elium-page__footer">{renderField(sections[0]?.setup.footer || page.footer || "")}</div>
          )}

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
        </div>
      </div>

      <EditorStatusBar
        editor={editor}
        pageInfo={pageInfo}
        zoom={zoom}
        zoomMode={zoomMode}
        onZoom={setZoomFromUi}
        onZoomMode={setZoomMode}
      />
      {statsOpen && <StatsDialog editor={editor} pages={pageInfo?.pageCount} onClose={() => setStatsOpen(false)} />}

      {editor && dialog === "font" && <FontDialog editor={editor} onClose={() => setDialog(null)} />}
      {editor && dialog === "paragraph" && <ParagraphDialog editor={editor} onClose={() => setDialog(null)} />}
      {editor && dialog === "styles" && (
        <StylesManager
          editor={editor}
          custom={documentModel.styles ?? []}
          onChange={(styles) => onStylesChange?.(styles)}
          onClose={() => setDialog(null)}
        />
      )}
      {editor && dialog === "caption" && <CaptionModal editor={editor} onClose={() => setDialog(null)} />}
      {editor && dialog === "symbol" && <SymbolModal editor={editor} onClose={() => setDialog(null)} />}
      {dialog === "watermark" && (
        <WatermarkModal
          value={documentModel.watermark as never}
          pageWidthMm={pageWidthMm}
          pageHeightMm={pageHeightMm}
          onApply={(mark) => onWatermarkChange?.(mark as never)}
          onClose={() => setDialog(null)}
        />
      )}
      {editor && dialog === "xref" && <CrossRefModal editor={editor} onClose={() => setDialog(null)} />}
      {editor && dialog === "index" && <IndexEntryModal editor={editor} onClose={() => setDialog(null)} />}
      {editor && dialog === "columns" && <ColumnsModal editor={editor} onClose={() => setDialog(null)} />}
      {editor && dialog === "section" && <SectionBreakModal editor={editor} onClose={() => setDialog(null)} />}
      {editor && dialog === "compare" && (
        <CompareModal
          editor={editor}
          onApply={(merged) => {
            // Replaces the content with the merged document; the differences are
            // ordinary tracked changes, so the Révision tab resolves them.
            editor.chain().focus().setContent(merged as never).run();
            onDocChange(editor.getJSON() as ProseMirrorNode);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {editor && dialog === "merge" && (
        <MailMergeModal
          editor={editor}
          onMerged={(merged) => {
            editor.chain().focus().setContent(merged as never).run();
            onDocChange(editor.getJSON() as ProseMirrorNode);
          }}
          onClose={() => setDialog(null)}
        />
      )}

      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onImageSelected} />
    </div>
  );
}
