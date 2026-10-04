/**
 * Accueil et espace de travail local : tableau de bord (créer, récents,
 * récupération), bibliothèque (dossiers, étiquettes, favoris, glisser-déposer,
 * sélection multiple), corbeille et recherche dans tout l'espace.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  UploadCloud,
  PenLine,
  ShieldCheck,
  Lock,
  Settings,
  FileSpreadsheet,
  Presentation,
  ArrowRight,
  FileText,
  FileType,
  Cloud,
  Users,
  BookOpen,
  ScanSearch,
  Search,
  Clock,
  Star,
  DatabaseBackup,
  Command,
} from "lucide-react";
import { TEMPLATES, type Template } from "../editor/templates";
import { IMPORT_ACCEPT } from "../format/importers";
import { listDrafts, deleteDraft, type DraftEntry } from "../format/drafts-store";
import { listPdfDrafts, type PdfDraftEntry } from "../pdf/model/recovery";
import type { EliumProfile } from "../format/types";
import { useDialogs } from "../ui/dialogs";
import { reportError } from "../ui/crash-log";
import { useI18n, type MessageKey } from "../i18n";
import { usePrefs, setPrefs, backupReminderDue } from "../settings/prefs";
import VersionFooter from "./VersionFooter";
import SecurityLevelPicker from "../components/SecurityLevelPicker";
import Sidebar, { type ShellView } from "../workspace/ui/Sidebar";
import Library, { type LibraryHandlers, type SortState, type ViewMode } from "../workspace/ui/Library";
import TrashView from "../workspace/ui/TrashView";
import SearchView from "../workspace/ui/SearchView";
import RecoveryPanel, { type PdfDraftLine } from "../workspace/ui/RecoveryPanel";
import { FolderPickerDialog, TagsDialog } from "../workspace/ui/Pickers";
import { emptySelection, pruneSelection, type DragPayload, type SelectionState } from "../workspace/ui/selection";
import { canMoveFolder, collectTags, folderPath, recentItems, childFolders } from "../workspace/model";
import { classifyDrafts, type RecoverableDraft } from "../workspace/recovery";
import type { WorkspaceApi } from "../workspace/useWorkspace";
import type { SearchApi } from "../workspace/useSearch";
import type { ReplaceDeps } from "../workspace/replace";
import type { ItemKind, WorkItem } from "../workspace/types";
import { handleFromDrop, type PickedFile } from "../workspace/fs-access";
import "../drive-cloud/drive-cloud.css";
import "../workspace/ui/workspace-shell.css";

export interface HomeViewProps {
  ws: WorkspaceApi;
  search: SearchApi;
  replaceDeps: ReplaceDeps;
  view: ShellView;
  onView: (v: ShellView) => void;
  searchQuery: string;
  onSearchQuery: (q: string) => void;
  onCreate: (tpl: Template, profile?: EliumProfile) => void;
  /** Ouvre ce que l'utilisateur dépose ou choisit (.elium, .docx, PDF…). */
  onOpenPicked: (files: PickedFile[]) => void;
  /** « Ouvrir… » : sélecteur natif quand il existe, sinon null (la vue ouvre son <input>). */
  onPickNative: () => Promise<boolean>;
  onOpenItem: (item: WorkItem) => void;
  onOpenSettings: (target?: { category?: string; section?: string }) => void;
  onNewSheet: () => void;
  onNewSlides: () => void;
  onNewPdf: () => void;
  onOpenDriveCloud: () => void;
  onOpenDocumentation: () => void;
  onOpenDetector: () => void;
  onOpenPalette: () => void;
  /** Incrémenté par le raccourci « Nouveau document » : ouvre le choix du niveau de protection. */
  newDocSignal?: number;
  onRecoverDraft: (id: string) => void;
  onDownloadDraft: (id: string) => void;
  onReopenPdfDraft: (id: string) => void;
  /** Fermeture anormale détectée au démarrage. */
  uncleanExit: boolean;
  previousStartedAt: string | null;
  notify: (message: string) => void;
}

const KIND_ICON: Record<ItemKind, React.ReactNode> = {
  doc: <FileText size={20} />,
  sheet: <FileSpreadsheet size={20} />,
  slides: <Presentation size={20} />,
  pdf: <FileType size={20} />,
};
const KIND_KEY: Record<ItemKind, MessageKey> = {
  doc: "kind.doc",
  sheet: "kind.sheet",
  slides: "kind.slides",
  pdf: "kind.pdf",
};

export default function HomeView(p: HomeViewProps) {
  const { t, tn, fmt } = useI18n();
  const prefs = usePrefs();
  const { confirm, alert, prompt } = useDialogs();
  const { ws } = p;
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<Template | null>(null);
  const lastSignal = useRef(p.newDocSignal ?? 0);
  useEffect(() => {
    if ((p.newDocSignal ?? 0) === lastSignal.current) return;
    lastSignal.current = p.newDocSignal ?? 0;
    setPendingTemplate(TEMPLATES.find((x) => x.id === "blank") ?? TEMPLATES[0]);
  }, [p.newDocSignal]);

  // --- Bibliothèque ---------------------------------------------------------
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    localStorage.getItem("elium_view_mode") === "list" ? "list" : "grid",
  );
  const [sort, setSort] = useState<SortState>({ key: "modifiedAt", dir: "desc" });
  const [kindFilter, setKindFilter] = useState<ItemKind[]>([]);
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [mover, setMover] = useState<{ itemIds: string[]; folderIds: string[] } | null>(null);
  const [tagger, setTagger] = useState<string[] | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("elium_view_mode", viewMode);
    } catch {
      /* préférence d'affichage : sans importance */
    }
  }, [viewMode]);

  const live = useMemo(() => ws.items.filter((i) => !i.trashedAt), [ws.items]);
  const liveFolders = useMemo(() => ws.folders.filter((f) => !f.trashedAt), [ws.folders]);
  const trashCount =
    ws.items.filter((i) => i.trashedAt && !i.trashedBy).length +
    ws.folders.filter((f) => f.trashedAt && !f.trashedBy).length;
  const tags = useMemo(() => collectTags(ws.items), [ws.items]);

  // Éléments et dossiers affichés selon la vue.
  const shown = useMemo(() => {
    if (p.view === "starred") return { items: live.filter((i) => i.starred), folders: [] as typeof liveFolders };
    if (p.view === "recent") return { items: recentItems(live, 60), folders: [] as typeof liveFolders };
    if (activeTag) return { items: live.filter((i) => i.tags.includes(activeTag)), folders: [] as typeof liveFolders };
    return {
      items: live.filter((i) => i.folderId === ws.currentFolderId),
      folders: childFolders(liveFolders, ws.currentFolderId),
    };
  }, [p.view, live, liveFolders, activeTag, ws.currentFolderId]);

  useEffect(() => {
    const order = [...shown.folders.map((f) => `f:${f.id}`), ...shown.items.map((i) => `i:${i.id}`)];
    setSelection((s) => pruneSelection(s, order));
  }, [shown]);
  // Changer de vue ou de dossier efface la sélection.
  useEffect(() => setSelection(emptySelection), [p.view, ws.currentFolderId, activeTag]);

  // --- Récupération ----------------------------------------------------------
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const [pdfDrafts, setPdfDrafts] = useState<PdfDraftEntry[]>([]);
  const [showAllDrafts, setShowAllDrafts] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const reloadDrafts = () => {
    listDrafts()
      .then(setDrafts)
      .catch((e) => reportError("drafts-list", e));
    listPdfDrafts()
      .then(setPdfDrafts)
      .catch((e) => reportError("pdf-drafts-list", e));
  };
  useEffect(reloadDrafts, []);

  const classified: RecoverableDraft[] = useMemo(() => {
    const libDates = new Map(ws.items.filter((i) => i.contentStore === "drive").map((i) => [i.id, i.modifiedAt]));
    return classifyDrafts(drafts, libDates, p.previousStartedAt);
  }, [drafts, ws.items, p.previousStartedAt]);

  const pdfLines: PdfDraftLine[] = pdfDrafts.map((d) => ({
    id: d.id,
    name: d.name,
    updatedAt: d.updatedAt,
    size: d.size,
    canReopen: !!d.handle,
  }));

  const removeDraft = async (id: string) => {
    if (
      !(await confirm({
        title: t("recovery.delete_title"),
        message: t("recovery.delete_body"),
        danger: true,
        confirmLabel: t("common.delete"),
      }))
    )
      return;
    await deleteDraft(id).catch((e) => reportError("draft-delete", e));
    reloadDrafts();
  };
  const clearAll = async () => {
    const pending = classified.filter((d) => !d.saved);
    if (
      !(await confirm({
        title: t("recovery.clear_title"),
        message: tn("recovery.clear_body", pending.length),
        danger: true,
        confirmLabel: t("recovery.clear_all"),
      }))
    )
      return;
    for (const d of pending) await deleteDraft(d.id).catch((e) => reportError("draft-delete", e));
    reloadDrafts();
  };
  const clearSaved = async () => {
    for (const d of classified.filter((x) => x.saved))
      await deleteDraft(d.id).catch((e) => reportError("draft-delete", e));
    reloadDrafts();
  };

  // --- Actions sur les éléments ------------------------------------------------
  const run = ws.run;

  const handlers: LibraryHandlers = {
    open: p.onOpenItem,
    openFolder: (id) => {
      setActiveTag(null);
      ws.setCurrentFolderId(id);
      p.onView("library");
    },
    rename: async (target) => {
      const cur =
        target.kind === "item"
          ? ws.items.find((i) => i.id === target.id)?.title
          : ws.folders.find((f) => f.id === target.id)?.name;
      const name = await prompt({
        title: t("workspace.rename_title"),
        label: target.kind === "folder" ? t("workspace.folder.name_label") : t("workspace.rename_label"),
        defaultValue: cur ?? "",
      });
      if (name === null || !name.trim() || name.trim() === cur) return;
      await run("rename", (s) =>
        target.kind === "item" ? s.rename(target.id, name.trim()) : s.renameFolder(target.id, name.trim()),
      );
    },
    duplicate: async (ids) => {
      const out = await run("duplicate", (s) => s.duplicate(ids));
      if (out) p.notify(tn("workspace.duplicated", out.length));
    },
    move: (sel) => setMover(sel),
    tag: (ids) => setTagger(ids),
    star: async (ids, value) => void (await run("star", (s) => s.setStarred(ids, value))),
    trash: async (sel) => {
      if (sel.folderIds.length > 0) {
        if (
          !(await confirm({
            title: t("workspace.trash.folder_confirm_title"),
            message: t("workspace.trash.folder_confirm_body"),
            confirmLabel: t("workspace.trash.move"),
          }))
        )
          return;
      }
      await run("trash", (s) => s.trash(sel));
      setSelection(emptySelection);
      p.notify(tn("workspace.trash.moved", sel.itemIds.length + sel.folderIds.length));
    },
    createFolder: () => void createFolder(ws.currentFolderId),
    drop: (target, payload) => void moveTo(target, payload),
  };

  async function createFolder(parentId: string | null) {
    const name = await prompt({
      title: t("workspace.folder.new"),
      label: t("workspace.folder.name_label"),
      defaultValue: t("workspace.folder.default_name"),
    });
    if (name === null) return;
    await run("folder-create", (s) => s.createFolder(name, parentId));
  }

  async function moveTo(target: string | null, payload: DragPayload) {
    for (const fid of payload.folderIds) {
      const check = canMoveFolder(ws.folders, fid, target);
      if (!check.ok) {
        await alert({ title: t("workspace.move_to"), message: t("workspace.move_invalid") });
        return;
      }
    }
    const ok = await run("move", async (s) => {
      if (payload.itemIds.length) await s.moveItems(payload.itemIds, target);
      for (const fid of payload.folderIds) await s.moveFolder(fid, target);
      return true;
    });
    if (ok) p.notify(tn("workspace.moved", payload.itemIds.length + payload.folderIds.length));
  }

  const trashFolderFromSidebar = (id: string) => handlers.trash({ itemIds: [], folderIds: [id] });

  // --- Fichiers -----------------------------------------------------------------
  const pickFiles = async () => {
    if (await p.onPickNative()) return;
    inputRef.current?.click();
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    // La poignée n'est lisible que SYNCHRONEMENT dans l'événement : on la demande maintenant.
    const first = handleFromDrop(e.dataTransfer);
    void first.then((handle) =>
      p.onOpenPicked(files.map((file, i) => ({ file, handle: i === 0 ? (handle ?? undefined) : undefined }))),
    );
  };

  const blankTemplate = TEMPLATES.find((t0) => t0.id === "blank") ?? TEMPLATES[0];
  const apps = [
    {
      key: "docs",
      name: t("kind.doc"),
      desc: t("home.app.docs"),
      icon: <FileText size={26} />,
      onClick: () => setPendingTemplate(blankTemplate),
    },
    {
      key: "sheets",
      name: t("kind.sheet"),
      desc: t("home.app.sheets"),
      icon: <FileSpreadsheet size={26} />,
      onClick: p.onNewSheet,
    },
    {
      key: "slides",
      name: t("kind.slides"),
      desc: t("home.app.slides"),
      icon: <Presentation size={26} />,
      onClick: p.onNewSlides,
    },
    { key: "pdf", name: t("kind.pdf"), desc: t("home.app.pdf"), icon: <FileType size={26} />, onClick: p.onNewPdf },
  ];

  const reminder = backupReminderDue(prefs, new Date(), live.length > 0) && ws.ready;
  const recents = recentItems(live, prefs.recentCount);

  // --- Rendu ---------------------------------------------------------------------
  const pathFolders = p.view === "library" && !activeTag ? folderPath(ws.folders, ws.currentFolderId) : null;
  const libraryTitle =
    p.view === "starred"
      ? t("shell.nav.starred")
      : p.view === "recent"
        ? t("shell.nav.recent")
        : activeTag
          ? `#${activeTag}`
          : t("shell.nav.library");
  const libraryEmpty =
    p.view === "starred"
      ? t("workspace.empty_starred")
      : p.view === "recent"
        ? t("workspace.empty_recent")
        : t("workspace.empty_library");

  const main = (() => {
    if (p.view === "trash")
      return (
        <TrashView
          items={ws.items}
          folders={ws.folders}
          now={new Date()}
          onRestore={async (sel) => {
            await run("restore", (s) => s.restore(sel));
            p.notify(t("workspace.trash.restored"));
          }}
          onDeleteForever={async (sel) => {
            if (
              !(await confirm({
                title: t("workspace.trash.confirm_delete_title"),
                message: t("workspace.trash.confirm_delete_body"),
                danger: true,
                confirmLabel: t("workspace.trash.delete_forever"),
              }))
            )
              return;
            await run("delete-forever", (s) => s.deleteForever(sel));
          }}
          onEmpty={async () => {
            if (
              !(await confirm({
                title: t("workspace.trash.confirm_empty_title"),
                message: t("workspace.trash.confirm_empty_body"),
                danger: true,
                confirmLabel: t("workspace.trash.empty_action"),
              }))
            )
              return;
            await run("trash-empty", (s) => s.emptyTrash());
            p.notify(t("workspace.trash.emptied"));
          }}
        />
      );
    if (p.view === "search")
      return (
        <SearchView
          items={ws.items}
          folders={ws.folders}
          search={p.search}
          initialQuery={p.searchQuery}
          replaceDeps={p.replaceDeps}
          onOpen={p.onOpenItem}
          onChanged={() => void ws.refresh()}
        />
      );
    if (p.view === "library" || p.view === "starred" || p.view === "recent")
      return (
        <Library
          title={libraryTitle}
          items={shown.items}
          folders={shown.folders}
          path={pathFolders}
          viewMode={viewMode}
          onViewMode={setViewMode}
          sort={sort}
          onSort={setSort}
          kindFilter={kindFilter}
          onKindFilter={setKindFilter}
          selection={selection}
          onSelection={setSelection}
          handlers={handlers}
          emptyHint={libraryEmpty}
        />
      );
    // --- Tableau de bord ---
    return (
      <>
        <section className="home__hero">
          <h1 className="home__title">{t("home.title")}</h1>
          <p className="home__subtitle">{t("home.subtitle")}</p>
          <div className="home__hero-badges">
            <span className="home__badge">
              <ShieldCheck size={15} /> {t("home.badge.proof")}
            </span>
            <span className="home__badge">
              <Lock size={15} /> {t("home.badge.encryption")}
            </span>
            <span className="home__badge">
              <PenLine size={15} /> {t("home.badge.signatures")}
            </span>
          </div>
        </section>

        {reminder && (
          <div className="alert alert--info recovery__banner" role="status">
            <span className="alert__icon">
              <DatabaseBackup size={16} />
            </span>
            <div className="alert__body">
              <div className="alert__title">{t("backup.reminder_title")}</div>
              <div className="alert__text">
                {prefs.lastBackupAt
                  ? t("backup.reminder_since", { date: fmt.date(prefs.lastBackupAt) })
                  : t("backup.reminder_never")}
              </div>
            </div>
            <button
              type="button"
              className="eb eb--sm eb--primary"
              onClick={() => p.onOpenSettings({ category: "workspace", section: "ws_backup" })}
            >
              {t("backup.export_now")}
            </button>
            <button
              type="button"
              className="eb eb--sm eb--ghost"
              onClick={() => setPrefs({ backupSnoozedUntil: new Date(Date.now() + 3 * 86400000).toISOString() })}
            >
              {t("backup.remind_later")}
            </button>
          </div>
        )}

        <RecoveryPanel
          drafts={classified}
          pdfDrafts={pdfLines}
          uncleanExit={p.uncleanExit && !bannerDismissed}
          previousStartedAt={p.previousStartedAt}
          showAll={showAllDrafts}
          onToggleAll={() => setShowAllDrafts((v) => !v)}
          onRecover={p.onRecoverDraft}
          onDownload={p.onDownloadDraft}
          onDelete={(id) => void removeDraft(id)}
          onClearAll={() => void clearAll()}
          onClearSaved={() => void clearSaved()}
          onReopenPdf={p.onReopenPdfDraft}
          onDismissBanner={() => setBannerDismissed(true)}
        />

        <section className="home__section">
          <h2 className="home__section-title">{t("home.create")}</h2>
          <div className="app-launcher">
            {apps.map((a) => (
              <button key={a.key} className={`app-tile app-tile--${a.key}`} onClick={a.onClick}>
                <span className="app-tile__icon">{a.icon}</span>
                <span className="app-tile__body">
                  <span className="app-tile__name">{a.name}</span>
                  <span className="app-tile__desc">{a.desc}</span>
                </span>
                <span className="app-tile__go">
                  <ArrowRight size={18} />
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="home__section">
          <div className="home__section-head">
            <h2 className="home__section-title">
              <Clock size={18} /> {t("shell.nav.recent")}
            </h2>
            {recents.length > 0 && (
              <button type="button" className="home__section-action" onClick={() => p.onView("recent")}>
                {t("home.see_all")}
              </button>
            )}
          </div>
          {!ws.ready ? (
            <p className="muted">{t("common.loading")}</p>
          ) : recents.length === 0 ? (
            <p className="muted">{t("home.recent_empty")}</p>
          ) : (
            <div className="library-grid">
              {recents.map((it) => (
                <div key={it.id} className="library-card">
                  <div className="library-card__top">
                    <button
                      type="button"
                      className="library-card__open"
                      disabled={it.locked}
                      onClick={() => p.onOpenItem(it)}
                    >
                      {it.locked ? <Lock size={18} /> : KIND_ICON[it.kind]}
                      <span className="library-card__title">{it.title}</span>
                    </button>
                    {it.starred && <Star size={14} aria-label={t("workspace.starred")} />}
                  </div>
                  <div className="library-card__meta">
                    <span className="badge badge--neutral">{t(KIND_KEY[it.kind])}</span>
                    <span className="library-card__date">
                      <Clock size={12} />{" "}
                      {fmt.relative(
                        it.lastOpenedAt && it.lastOpenedAt > it.modifiedAt ? it.lastOpenedAt : it.modifiedAt,
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="home__section">
          <button className="home__drive-cta" onClick={p.onOpenDriveCloud}>
            <span className="home__drive-cta__icon">
              <Cloud size={28} />
            </span>
            <span className="home__drive-cta__body">
              <span className="home__drive-cta__title">
                {t("home.drive.title")} <span className="home__pill">{t("home.new")}</span>
              </span>
              <span className="home__drive-cta__desc">{t("home.drive.desc")}</span>
            </span>
            <span className="home__drive-cta__meta">
              <Users size={16} /> {t("home.drive.meta")}
            </span>
            <span className="app-tile__go">
              <ArrowRight size={18} />
            </span>
          </button>
        </section>

        <section className="home__section">
          <button className="home__drive-cta home__drive-cta--detector" onClick={p.onOpenDetector}>
            <span className="home__drive-cta__icon">
              <ScanSearch size={28} />
            </span>
            <span className="home__drive-cta__body">
              <span className="home__drive-cta__title">
                {t("home.detector.title")} <span className="home__pill">{t("home.new")}</span>
              </span>
              <span className="home__drive-cta__desc">{t("home.detector.desc")}</span>
            </span>
            <span className="app-tile__go">
              <ArrowRight size={18} />
            </span>
          </button>
        </section>

        <section className="home__section">
          <h2 className="home__section-title">{t("home.open")}</h2>
          <div
            className={`dropzone ${drag ? "is-active" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={handleDrop}
            onClick={() => void pickFiles()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), void pickFiles())}
            role="button"
            tabIndex={0}
          >
            <UploadCloud size={32} />
            <div className="dropzone__title">{t("home.drop_title")}</div>
            <div className="dropzone__hint">{t("home.drop_hint")}</div>
            <input
              ref={inputRef}
              type="file"
              accept={`${IMPORT_ACCEPT},.pdf,.elium-workspace`}
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) p.onOpenPicked(files.map((file) => ({ file })));
                e.target.value = "";
              }}
            />
          </div>
        </section>

        <section className="home__section">
          <h2 className="home__section-title">{t("home.templates")}</h2>
          <div className="template-grid">
            {TEMPLATES.map((tpl) => (
              <button key={tpl.id} className="template-card" onClick={() => setPendingTemplate(tpl)}>
                <div className="template-card__label">{tpl.label}</div>
                <div className="template-card__desc">{tpl.description}</div>
              </button>
            ))}
          </div>
        </section>

        <VersionFooter />
      </>
    );
  })();

  return (
    <main className="home ws-shell">
      <header className="home__top">
        <div className="brand">
          <img src="/elium-logo.svg" alt="" className="brand__logo" width={30} height={30} />
          <span className="brand__name">Elium</span>
          <span className="home__pill">Workspace</span>
        </div>
        <form
          className="ws-topsearch"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const q = (new FormData(e.currentTarget).get("q") as string) ?? "";
            p.onSearchQuery(q);
            p.onView("search");
          }}
        >
          <Search size={16} aria-hidden />
          <input
            name="q"
            type="search"
            placeholder={t("home.search_placeholder")}
            aria-label={t("search.title")}
            defaultValue=""
          />
        </form>
        <div className="home__top-actions">
          <button
            className="icon-btn"
            onClick={p.onOpenPalette}
            title={t("home.palette")}
            aria-label={t("home.palette")}
          >
            <Command size={20} />
          </button>
          <button
            className="icon-btn"
            onClick={() => void pickFiles()}
            title={t("home.open_file")}
            aria-label={t("home.open_file")}
          >
            <UploadCloud size={20} />
          </button>
          <button
            className="icon-btn"
            onClick={p.onOpenDocumentation}
            title={t("home.docs")}
            aria-label={t("home.docs")}
          >
            <BookOpen size={20} />
          </button>
          <button
            className="icon-btn"
            onClick={() => p.onOpenSettings()}
            title={t("home.settings")}
            aria-label={t("home.settings")}
          >
            <Settings size={20} />
          </button>
        </div>
      </header>

      <div className="ws-shell__body">
        <Sidebar
          view={p.view}
          onView={(v) => {
            setActiveTag(null);
            p.onView(v);
          }}
          folders={ws.folders}
          currentFolderId={ws.currentFolderId}
          onOpenFolder={handlers.openFolder}
          onCreateFolder={(parent) => void createFolder(parent)}
          onRenameFolder={(id) => handlers.rename({ kind: "folder", id })}
          onTrashFolder={trashFolderFromSidebar}
          tags={tags}
          activeTag={activeTag}
          onSelectTag={(tag) => {
            setActiveTag(tag);
            p.onView("library");
          }}
          trashCount={trashCount}
          onDrop={(target, payload) => void moveTo(target, payload)}
        />
        <div className="ws-shell__main">{main}</div>
      </div>

      {pendingTemplate && (
        <SecurityLevelPicker
          onChoose={(profile) => {
            const tpl = pendingTemplate;
            setPendingTemplate(null);
            p.onCreate(tpl, profile);
          }}
          onCancel={() => setPendingTemplate(null)}
        />
      )}

      {mover && (
        <FolderPickerDialog
          folders={liveFolders}
          excluded={mover.folderIds}
          currentId={ws.currentFolderId}
          onCancel={() => setMover(null)}
          onPick={(target) => {
            const sel = mover;
            setMover(null);
            void moveTo(target, sel);
          }}
        />
      )}

      {tagger && (
        <TagsDialog
          count={tagger.length}
          initial={commonTags(ws.items, tagger)}
          suggestions={tags.map((x) => x.tag)}
          onCancel={() => setTagger(null)}
          onSave={async (add, remove) => {
            const ids = tagger;
            setTagger(null);
            await run("tags", async (s) => {
              for (const tag of add) await s.addTag(ids, tag);
              for (const tag of remove) await s.removeTag(ids, tag);
              return true;
            });
          }}
        />
      )}
    </main>
  );
}

/** Étiquettes que TOUS les éléments choisis portent déjà. */
function commonTags(items: WorkItem[], ids: string[]): string[] {
  const chosen = items.filter((i) => ids.includes(i.id));
  if (chosen.length === 0) return [];
  return chosen[0]!.tags.filter((tag) => chosen.every((i) => i.tags.includes(tag)));
}
