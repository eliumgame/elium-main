/**
 * Local Présentations editor — a thin shell around the shared <SlidesEditor>.
 * It supplies the local backend (useLocalDeckStore: undo/redo + IndexedDB) and
 * the local-only chrome (Accueil, PPTX/.elium export). The whole editing surface
 * is the shared component, so it stays in lockstep with the Drive collaborative
 * editor. Each deck is a workspace item (`session`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileDown, Pencil, Save } from "lucide-react";
import { elementsOf, type Deck } from "../slides/model";
import { useLocalDeckStore } from "../slides/useLocalDeckStore";
import SlidesEditor from "../slides/SlidesEditor";
import { ToolbarPopover } from "../slides/ActionMenu";
import { useDialogs } from "../ui/dialogs";
import { useI18n } from "../i18n";
import { deckToPptx } from "../slides/pptx";
import { downloadBlob } from "../export/exporters";
import type { VaultSecret } from "../crypto/local-vault";
import { useRegisterCommands, type AppCommand } from "../commands/registry";
import { useItemSync, type ItemSession } from "../workspace/useItemSync";
import type { WorkspaceApi } from "../workspace/useWorkspace";

export default function SlidesView({
  onHome,
  initial,
  onExportElium,
  vaultSecret,
  session,
  workspace,
}: {
  onHome: () => void;
  initial?: Deck;
  onExportElium: (data: Deck, title: string) => void;
  /** App-wide local vault secret (see crypto/local-vault.ts). When set, the
   *  IndexedDB autosave of this deck is encrypted at rest instead of plaintext. */
  vaultSecret?: VaultSecret;
  session?: ItemSession;
  workspace: WorkspaceApi;
}) {
  const { t } = useI18n();
  const dialogs = useDialogs();
  const sync = useItemSync(workspace, session, "slides");
  const store = useLocalDeckStore(
    initial,
    vaultSecret,
    session ? { id: session.id, isNew: session.isNew, onSaved: sync.onSaved } : undefined,
  );
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
      title: t("slides.load_error_title"),
      message: t("slides.load_error_body", { error: store.loadError }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.loadError]);

  const saveElium = async () => {
    const active = store.deck.slides[store.active];
    const els = active ? (active.elements ?? elementsOf(active)) : [];
    const suggested =
      sync.title ||
      (els.find((e) => e.type === "text")?.html || t("kind.slides")).replace(/<[^>]+>/g, "").slice(0, 60) ||
      t("kind.slides");
    const title = await dialogs.prompt({
      title: t("sheet.save_elium_title"),
      label: t("slides.save_elium_label"),
      defaultValue: suggested,
    });
    if (title === null) return;
    onExportElium(store.deck, title);
  };
  const exportPptx = () => {
    const bytes = deckToPptx(store.deck);
    downloadBlob(
      `${sync.title || "presentation"}.pptx`,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes,
    );
  };

  const storeRef = useRef(store);
  storeRef.current = store;
  const latest = useRef({ exportPptx, saveElium });
  latest.current = { exportPptx, saveElium };
  const actions = useMemo<AppCommand[]>(
    () => [
      {
        id: "slides.undo",
        label: t("slides.cmd.undo"),
        group: "module",
        hint: "Ctrl+Z",
        run: () => storeRef.current.undo?.(),
      },
      {
        id: "slides.redo",
        label: t("slides.cmd.redo"),
        group: "module",
        hint: "Ctrl+Y",
        run: () => storeRef.current.redo?.(),
      },
      {
        id: "slides.add",
        label: t("slides.cmd.add_slide"),
        group: "module",
        keywords: "diapositive slide",
        run: () => storeRef.current.addSlide(),
      },
      {
        id: "slides.add_blank",
        label: t("slides.cmd.add_blank"),
        group: "module",
        run: () => storeRef.current.addSlide(true),
      },
      {
        id: "slides.duplicate",
        label: t("slides.cmd.duplicate"),
        group: "module",
        run: () => storeRef.current.duplicateSlide(storeRef.current.active),
      },
      {
        id: "slides.remove",
        label: t("slides.cmd.remove"),
        group: "module",
        run: () => storeRef.current.removeSlide(storeRef.current.active),
      },
      {
        id: "slides.pptx",
        label: t("slides.cmd.export_pptx"),
        group: "file",
        keywords: "powerpoint",
        run: () => latest.current.exportPptx(),
      },
      {
        id: "slides.elium",
        label: t("slides.cmd.save_elium"),
        group: "file",
        shortcutId: "save",
        keywords: "enregistrer",
        run: () => void latest.current.saveElium(),
      },
      ...(session
        ? [
            {
              id: "slides.rename",
              label: t("slides.cmd.rename"),
              group: "module" as const,
              run: () => void sync.rename(),
            },
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, session, sync.title],
  );
  useRegisterCommands("slides", actions);

  return (
    <SlidesEditor
      store={store}
      chrome={{
        title: sync.title ? `${t("kind.slides")} — ${sync.title}` : t("kind.slides"),
        onHome,
        headerActions: (
          <>
            {session && (
              <button className="eb eb--sm eb--ghost" onClick={() => void sync.rename()} title={t("common.rename")}>
                <Pencil size={14} /> {t("common.rename")}
              </button>
            )}
            <div className="sv-menu">
              <button ref={exportMenuBtnRef} className="eb eb--sm eb--outline" onClick={() => setExportMenu((v) => !v)}>
                <Download size={14} /> {t("slides.export")} ▾
              </button>
              {exportMenu && (
                <ToolbarPopover
                  className="sv-menu__pop sv-menu__pop--right sv-export-pop"
                  ariaLabel={t("slides.export")}
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
                    <span>{t("slides.format_elium")}</span>
                  </button>
                </ToolbarPopover>
              )}
            </div>
          </>
        ),
      }}
    />
  );
}
