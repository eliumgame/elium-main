import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import TopBar from "../components/TopBar";
import RichEditor from "../editor/RichEditor";
import InspectorPanel from "../panels/InspectorPanel";
import VerificationBanner from "../components/VerificationBanner";
import PageSettingsModal from "../components/PageSettingsModal";
import CommandPalette from "../components/CommandPalette";
import type { Studio } from "../studio/types";

export default function StudioView({ studio }: { studio: Studio }) {
  // The editor instance is owned here so the inspector (comments panel) can
  // read and mutate the document alongside the editor view.
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const commentAuthor = studio.identity ? `Clé ${studio.identity.fingerprint.slice(0, 8)}` : "Vous";

  // Keyboard shortcuts: Ctrl/Cmd+K (command palette), Ctrl/Cmd+\ (toggle inspector).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "\\") {
        e.preventDefault();
        setInspectorOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="studio">
      <TopBar studio={studio} />
      {!studio.editable && <VerificationBanner studio={studio} />}
      <div className="studio__body">
        <RichEditor
          documentModel={studio.file.document}
          editable={studio.editable}
          signatures={studio.file.signatures}
          selectedSignatureId={studio.selectedSig}
          verdicts={studio.verdicts}
          onDocChange={studio.onDocChange}
          onAddSignatureRequest={studio.openSignatureCreator}
          onUpdateSignature={studio.updateSignature}
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
        />
        <InspectorPanel
          studio={studio}
          editor={editor}
          open={inspectorOpen}
          onToggle={() => setInspectorOpen((v) => !v)}
        />
      </div>
      {pageSettingsOpen && (
        <PageSettingsModal
          page={studio.file.document.page}
          onUpdate={studio.updatePage}
          onClose={() => setPageSettingsOpen(false)}
        />
      )}
      {cmdkOpen && (
        <CommandPalette
          studio={studio}
          editor={editor}
          onOpenPageSettings={() => setPageSettingsOpen(true)}
          onClose={() => setCmdkOpen(false)}
        />
      )}
    </div>
  );
}
