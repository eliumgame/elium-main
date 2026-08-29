/**
 * Local Présentations editor — a thin shell around the shared <SlidesEditor>.
 * It supplies the local backend (useLocalDeckStore: undo/redo + IndexedDB) and
 * the local-only chrome (Accueil, PPTX/.elium export). The whole editing surface
 * is the shared component, so it stays in lockstep with the Drive collaborative
 * editor.
 */
import { useState } from "react";
import { Download, FileDown, Save } from "lucide-react";
import { elementsOf, type Deck } from "../slides/model";
import { useLocalDeckStore } from "../slides/useLocalDeckStore";
import SlidesEditor from "../slides/SlidesEditor";
import { useDialogs } from "../ui/dialogs";
import { deckToPptx } from "../slides/pptx";
import { downloadBlob } from "../export/exporters";

export default function SlidesView({
  onHome,
  initial,
  onExportElium,
}: {
  onHome: () => void;
  initial?: Deck;
  onExportElium: (data: Deck, title: string) => void;
}) {
  const dialogs = useDialogs();
  const store = useLocalDeckStore(initial);
  const [exportMenu, setExportMenu] = useState(false);

  const saveElium = async () => {
    const active = store.deck.slides[store.active];
    const els = active ? (active.elements ?? elementsOf(active)) : [];
    const suggested =
      (els.find((e) => e.type === "text")?.html || "Présentation").replace(/<[^>]+>/g, "").slice(0, 60) ||
      "Présentation";
    const title = await dialogs.prompt({
      title: "Enregistrer en .elium",
      label: "Nom de la présentation",
      defaultValue: suggested,
    });
    if (title === null) return;
    onExportElium(store.deck, title);
  };
  const exportPptx = () => {
    const bytes = deckToPptx(store.deck);
    downloadBlob(
      "presentation.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes,
    );
  };

  return (
    <SlidesEditor
      store={store}
      chrome={{
        title: "Présentations",
        onHome,
        headerActions: (
          <div className="sv-menu">
            <button className="eb eb--sm eb--outline" onClick={() => setExportMenu((v) => !v)}>
              <Download size={14} /> Exporter ▾
            </button>
            {exportMenu && (
              <div className="sv-menu__pop sv-menu__pop--right sv-export-pop" onMouseLeave={() => setExportMenu(false)}>
                <button
                  className="sv-menu__item"
                  onClick={() => {
                    setExportMenu(false);
                    exportPptx();
                  }}
                >
                  <FileDown size={15} />
                  <span>PowerPoint (.pptx)</span>
                </button>
                <button
                  className="sv-menu__item"
                  onClick={() => {
                    setExportMenu(false);
                    saveElium();
                  }}
                >
                  <Save size={15} />
                  <span>Format .elium…</span>
                </button>
              </div>
            )}
          </div>
        ),
      }}
    />
  );
}
