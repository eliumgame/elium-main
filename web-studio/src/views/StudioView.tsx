import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import TopBar from "../components/TopBar";
import RichEditor from "../editor/RichEditor";
import InspectorPanel from "../panels/InspectorPanel";
import VerificationBanner from "../components/VerificationBanner";
import PageSettingsModal from "../components/PageSettingsModal";
import { useStudioCommands } from "../commands/useStudioCommands";
import OutlinePanel from "../editor/OutlinePanel";
import type { Studio } from "../studio/types";
import { readPref, useMediaQuery, writePref } from "../studio/useMediaQuery";

/** Sous cette largeur, les volets latéraux deviennent des tiroirs superposés (voile + fermeture au clic/Échap). */
const DRAWER_QUERY = "(max-width: 1099px)";
const PREF_OPEN = "elium.docs.inspector.open";
const PREF_WIDTH = "elium.docs.inspector.width";
const INSPECTOR_MIN = 280;
const INSPECTOR_MAX = 560;
const INSPECTOR_DEFAULT = 340;

export default function StudioView({ studio }: { studio: Studio }) {
  // The editor instance is owned here so the inspector (comments panel) can
  // read and mutate the document alongside the editor view.
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const drawerMode = useMediaQuery(DRAWER_QUERY);
  // Écran large : le panneau est ouvert par défaut et son état est mémorisé. Écran étroit : tiroir,
  // FERMÉ par défaut (il recouvre l'éditeur) ; son état n'est jamais mémorisé.
  const [wideOpen, setWideOpen] = useState(() => readPref(PREF_OPEN) !== "0");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const n = Number(readPref(PREF_WIDTH));
    return Number.isFinite(n) && n >= INSPECTOR_MIN && n <= INSPECTOR_MAX ? n : INSPECTOR_DEFAULT;
  });
  const inspectorOpen = drawerMode ? drawerOpen : wideOpen;
  const setInspectorOpen = useCallback(
    (v: boolean | ((o: boolean) => boolean)) => {
      if (drawerMode) {
        setDrawerOpen((o) => {
          const next = typeof v === "function" ? v(o) : v;
          if (next) setOutlineOpen(false);
          return next;
        });
      } else {
        setWideOpen((o) => {
          const next = typeof v === "function" ? v(o) : v;
          writePref(PREF_OPEN, next ? "1" : "0");
          return next;
        });
      }
    },
    [drawerMode],
  );
  const toggleOutline = useCallback(() => {
    setOutlineOpen((o) => {
      if (!o && drawerMode) setDrawerOpen(false);
      return !o;
    });
  }, [drawerMode]);
  const changeInspectorWidth = useCallback((w: number) => {
    const c = Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(w)));
    setInspectorWidth(c);
    writePref(PREF_WIDTH, String(c));
  }, []);
  const closeDrawers = useCallback(() => {
    setDrawerOpen(false);
    setOutlineOpen(false);
  }, []);
  const commentAuthor = studio.identity ? `Clé ${studio.identity.fingerprint.slice(0, 8)}` : "Vous";

  // Les actions du module sont déclarées dans le registre de commandes : la palette GLOBALE (Ctrl/Cmd+K, gérée par App) les liste.
  useStudioCommands(studio, editor, () => setPageSettingsOpen(true));

  // Keyboard shortcuts: Ctrl/Cmd+\ (toggle inspector).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "\\") {
        e.preventDefault();
        if (e.shiftKey) toggleOutline();
        else setInspectorOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleOutline, setInspectorOpen]);

  // Tiroir ouvert : Échap le referme (sauf si une boîte de dialogue est au-dessus).
  const drawerShown = drawerMode && (drawerOpen || outlineOpen);
  useEffect(() => {
    if (!drawerShown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[role=dialog]")) closeDrawers();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerShown, closeDrawers]);

  return (
    <div className="studio">
      <TopBar studio={studio} inspectorOpen={inspectorOpen} onToggleInspector={() => setInspectorOpen((v) => !v)} />
      {!studio.editable && <VerificationBanner studio={studio} />}
      <div className="studio__body" style={{ "--inspector-w": `${inspectorWidth}px` } as React.CSSProperties}>
        {outlineOpen && (
          <aside className="studio__outline elx">
            <OutlinePanel editor={editor} />
          </aside>
        )}
        {drawerShown && <div className="studio__scrim" onClick={closeDrawers} aria-hidden="true" />}
        <RichEditor
          documentModel={studio.file.document}
          editable={studio.editable}
          signatures={studio.file.signatures}
          selectedSignatureId={studio.selectedSig}
          verdicts={studio.verdicts}
          onDocChange={studio.onDocChange}
          onAddSignatureRequest={studio.openSignatureCreator}
          onUpdateSignature={studio.updateSignature}
          onCommitSignature={studio.commitSignature}
          onSelectSignature={studio.selectSignature}
          onRemoveSignature={studio.removeSignature}
          onEditorReady={setEditor}
          commentAuthor={commentAuthor}
          docTitle={studio.file.manifest.title}
          numberedHeadings={studio.file.document.page.numberedHeadings ?? false}
          onToggleNumberedHeadings={() =>
            studio.updatePage({ numberedHeadings: !(studio.file.document.page.numberedHeadings ?? false) })
          }
          onOpenPageSettings={() => setPageSettingsOpen(true)}
          outlineOpen={outlineOpen}
          onToggleOutline={toggleOutline}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
          onStylesChange={studio.updateStyles}
          onThemeChange={studio.updateDocTheme}
          onWatermarkChange={studio.updateWatermark}
          // Le quadrillage est un réglage de page : il suit le même chemin que
          // les marges ou le format, donc il est persisté dans le `.elium`.
          onGridChange={(grid) => studio.updatePage({ grid })}
        />
        <InspectorPanel
          studio={studio}
          editor={editor}
          open={inspectorOpen}
          onToggle={() => setInspectorOpen((v) => !v)}
          drawer={drawerMode}
          width={inspectorWidth}
          onWidthChange={changeInspectorWidth}
          widthRange={[INSPECTOR_MIN, INSPECTOR_MAX]}
          commentAuthor={commentAuthor}
        />
      </div>
      {pageSettingsOpen && (
        <PageSettingsModal
          page={studio.file.document.page}
          onUpdate={studio.updatePage}
          onClose={() => setPageSettingsOpen(false)}
        />
      )}
    </div>
  );
}
