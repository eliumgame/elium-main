/**
 * Local Présentations editor — a thin shell around the shared <SlidesEditor>.
 * It supplies the local backend (useLocalDeckStore: undo/redo + IndexedDB) and
 * the local-only chrome (Accueil, PPTX/.elium export). The whole editing surface
 * is the shared component, so it stays in lockstep with the Drive collaborative
 * editor.
 */
import { useEffect, useRef, useState } from "react";
import { Download, FileDown, Save } from "lucide-react";
import { elementsOf, type Deck } from "../slides/model";
import { useLocalDeckStore } from "../slides/useLocalDeckStore";
import SlidesEditor from "../slides/SlidesEditor";
import { ToolbarPopover } from "../slides/ActionMenu";
import { useDialogs } from "../ui/dialogs";
import { deckToPptx } from "../slides/pptx";
import { downloadBlob } from "../export/exporters";
import type { VaultSecret } from "../crypto/local-vault";

export default function SlidesView({
  onHome,
  initial,
  onExportElium,
  vaultSecret,
}: {
  onHome: () => void;
  initial?: Deck;
  onExportElium: (data: Deck, title: string) => void;
  /** App-wide local vault secret (see crypto/local-vault.ts). When set, the
   *  IndexedDB autosave of this deck is encrypted at rest instead of plaintext. */
  vaultSecret?: VaultSecret;
}) {
  const dialogs = useDialogs();
  const store = useLocalDeckStore(initial, vaultSecret);
  const [exportMenu, setExportMenu] = useState(false);
  const exportMenuBtnRef = useRef<HTMLButtonElement>(null);

  // The local autosave couldn't be decrypted (app vault disabled/reset, or
  // unlocked with the wrong password, since it was last saved) — see
  // useLocalDeckStore.ts / deck-store.ts. The editor started on a blank deck
  // instead of silently overwriting the still-encrypted autosave; tell the
  // user so they don't mistake the blank deck for "nothing was ever saved".
  useEffect(() => {
    if (!store.loadError) return;
    void dialogs.alert({
      title: "Présentation autosauvegardée illisible",
      message: `${store.loadError}\n\nL'éditeur démarre sur une présentation vierge. La sauvegarde automatique chiffrée n'a PAS été effacée — réactivez le coffre avec le bon mot de passe pour la récupérer.`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.loadError]);

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
            <button ref={exportMenuBtnRef} className="eb eb--sm eb--outline" onClick={() => setExportMenu((v) => !v)}>
              <Download size={14} /> Exporter ▾
            </button>
            {exportMenu && (
              <ToolbarPopover
                className="sv-menu__pop sv-menu__pop--right sv-export-pop"
                ariaLabel="Exporter"
                onClose={() => setExportMenu(false)}
                triggerRef={exportMenuBtnRef}
              >
                <button
                  className="sv-menu__item"
                  role="menuitem"
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
                  role="menuitem"
                  onClick={() => {
                    setExportMenu(false);
                    saveElium();
                  }}
                >
                  <Save size={15} />
                  <span>Format .elium…</span>
                </button>
              </ToolbarPopover>
            )}
          </div>
        ),
      }}
    />
  );
}
