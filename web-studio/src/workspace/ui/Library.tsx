/**
 * Bibliothèque de l'espace de travail : dossiers et éléments en grille ou en
 * liste, sélection multiple (clic, Ctrl/Maj, cases à cocher), glisser-déposer
 * vers les dossiers, actions par élément et sur la sélection.
 */
import { useMemo } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  FileSpreadsheet,
  FileText,
  FileType,
  LayoutGrid,
  List,
  Lock,
  MoreHorizontal,
  Pencil,
  Presentation,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import Menu, { type MenuItem } from "../../ui/Menu";
import { PROFILES } from "../../format/profiles";
import { useI18n, type MessageKey } from "../../i18n";
import { sortItems, type SortKey } from "../model";
import { ITEM_KINDS, type ItemKind, type WorkFolder, type WorkItem } from "../types";
import {
  DRAG_MIME,
  clickSelect,
  decodeDrag,
  dragPayload,
  encodeDrag,
  selectAll,
  toggleSelect,
  type DragPayload,
  type SelectionState,
} from "./selection";

export type ViewMode = "grid" | "list";
export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

export interface LibraryHandlers {
  open: (item: WorkItem) => void;
  openFolder: (id: string | null) => void;
  rename: (target: { kind: "item" | "folder"; id: string }) => void;
  duplicate: (itemIds: string[]) => void;
  move: (sel: { itemIds: string[]; folderIds: string[] }) => void;
  tag: (itemIds: string[]) => void;
  star: (itemIds: string[], value: boolean) => void;
  trash: (sel: { itemIds: string[]; folderIds: string[] }) => void;
  createFolder: () => void;
  drop: (target: string | null, payload: DragPayload) => void;
}

export interface LibraryProps {
  title: string;
  items: WorkItem[];
  /** Sous-dossiers à afficher (vide hors vue « dossier »). */
  folders: WorkFolder[];
  /** Fil d'Ariane (dossiers de la racine au dossier courant) ; null = vue sans dossiers. */
  path: WorkFolder[] | null;
  viewMode: ViewMode;
  onViewMode: (m: ViewMode) => void;
  sort: SortState;
  onSort: (s: SortState) => void;
  kindFilter: ItemKind[];
  onKindFilter: (k: ItemKind[]) => void;
  selection: SelectionState;
  onSelection: (s: SelectionState) => void;
  handlers: LibraryHandlers;
  emptyHint?: string;
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
const SORT_KEYS: { key: SortKey; label: MessageKey }[] = [
  { key: "modifiedAt", label: "workspace.sort.modified" },
  { key: "title", label: "workspace.sort.title" },
  { key: "createdAt", label: "workspace.sort.created" },
  { key: "size", label: "workspace.sort.size" },
  { key: "kind", label: "workspace.sort.kind" },
];

const itemSel = (id: string) => `i:${id}`;
const folderSel = (id: string) => `f:${id}`;

/** Sépare une sélection préfixée en identifiants d'éléments et de dossiers. */
export function splitSelection(sel: SelectionState): { itemIds: string[]; folderIds: string[] } {
  return {
    itemIds: sel.selected.filter((s) => s.startsWith("i:")).map((s) => s.slice(2)),
    folderIds: sel.selected.filter((s) => s.startsWith("f:")).map((s) => s.slice(2)),
  };
}

export default function Library(p: LibraryProps) {
  const { t, tn, fmt } = useI18n();
  const sorted = useMemo(
    () =>
      sortItems(
        p.items.filter((i) => p.kindFilter.length === 0 || p.kindFilter.includes(i.kind)),
        p.sort.key,
        p.sort.dir,
      ),
    [p.items, p.kindFilter, p.sort],
  );
  const order = useMemo(
    () => [...p.folders.map((f) => folderSel(f.id)), ...sorted.map((i) => itemSel(i.id))],
    [p.folders, sorted],
  );
  const sel = splitSelection(p.selection);
  const selected = new Set(p.selection.selected);

  const onClickEntry = (e: React.MouseEvent, id: string) =>
    p.onSelection(clickSelect(p.selection, id, order, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));

  const dragStart = (e: React.DragEvent, kind: "item" | "folder", id: string) => {
    const payload = dragPayload({ items: sel.itemIds, folders: sel.folderIds }, { kind, id });
    e.dataTransfer.setData(DRAG_MIME, encodeDrag(payload));
    e.dataTransfer.effectAllowed = "move";
  };

  const dropOnFolder = (e: React.DragEvent, folderId: string) => {
    const payload = decodeDrag(e.dataTransfer.getData(DRAG_MIME));
    if (!payload) return;
    e.preventDefault();
    e.stopPropagation();
    p.handlers.drop(folderId, payload);
  };
  const allowDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const itemMenu = (it: WorkItem): MenuItem[] => [
    { id: "open", label: t("common.open"), onSelect: () => p.handlers.open(it), disabled: !!it.locked },
    {
      id: "rename",
      label: t("common.rename"),
      icon: <Pencil size={14} />,
      onSelect: () => p.handlers.rename({ kind: "item", id: it.id }),
      disabled: !!it.locked,
      separator: true,
    },
    {
      id: "dup",
      label: t("common.duplicate"),
      icon: <Copy size={14} />,
      onSelect: () => p.handlers.duplicate([it.id]),
      disabled: !!it.locked,
    },
    {
      id: "move",
      label: t("workspace.move_to"),
      icon: <FolderInput size={14} />,
      onSelect: () => p.handlers.move({ itemIds: [it.id], folderIds: [] }),
    },
    {
      id: "tag",
      label: t("workspace.tags_edit"),
      icon: <Tag size={14} />,
      onSelect: () => p.handlers.tag([it.id]),
      disabled: !!it.locked,
    },
    {
      id: "star",
      label: it.starred ? t("workspace.unstar") : t("workspace.star"),
      icon: <Star size={14} />,
      onSelect: () => p.handlers.star([it.id], !it.starred),
    },
    {
      id: "trash",
      label: t("workspace.trash.move"),
      icon: <Trash2 size={14} />,
      danger: true,
      separator: true,
      onSelect: () => p.handlers.trash({ itemIds: [it.id], folderIds: [] }),
    },
  ];
  const folderMenu = (f: WorkFolder): MenuItem[] => [
    { id: "open", label: t("common.open"), onSelect: () => p.handlers.openFolder(f.id) },
    {
      id: "rename",
      label: t("common.rename"),
      icon: <Pencil size={14} />,
      onSelect: () => p.handlers.rename({ kind: "folder", id: f.id }),
      separator: true,
    },
    {
      id: "move",
      label: t("workspace.move_to"),
      icon: <FolderInput size={14} />,
      onSelect: () => p.handlers.move({ itemIds: [], folderIds: [f.id] }),
    },
    {
      id: "trash",
      label: t("workspace.trash.move"),
      icon: <Trash2 size={14} />,
      danger: true,
      separator: true,
      onSelect: () => p.handlers.trash({ itemIds: [], folderIds: [f.id] }),
    },
  ];

  const onKey = (e: React.KeyboardEvent, id: string, open: () => void, kind: "item" | "folder", rawId: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      open();
    } else if (e.key === " ") {
      e.preventDefault();
      p.onSelection(toggleSelect(p.selection, id));
    } else if (e.key === "Delete") {
      e.preventDefault();
      const target = selected.has(id)
        ? sel
        : kind === "item"
          ? { itemIds: [rawId], folderIds: [] }
          : { itemIds: [], folderIds: [rawId] };
      p.handlers.trash(target);
    } else if (e.key === "F2") {
      e.preventDefault();
      p.handlers.rename({ kind, id: rawId });
    }
  };

  const badges = (it: WorkItem) => (
    <>
      {it.locked ? (
        <span className="badge badge--warning" title={t("workspace.locked_hint")}>
          <Lock size={11} /> {t("workspace.locked")}
        </span>
      ) : it.kind === "doc" && it.profile ? (
        <span className="badge badge--neutral">
          {PROFILES[it.profile as keyof typeof PROFILES]?.badge ?? it.profile}
        </span>
      ) : null}
      {it.tags.slice(0, 3).map((tag) => (
        <span key={tag} className="ws-chip">
          {tag}
        </span>
      ))}
    </>
  );

  const total = p.folders.length + sorted.length;
  const selectedCount = p.selection.selected.length;

  return (
    <section className="ws-lib" aria-label={p.title}>
      <header className="ws-lib__head">
        {p.path ? (
          <nav className="ws-crumbs" aria-label={t("workspace.breadcrumb")}>
            <button
              type="button"
              className="ws-crumbs__btn"
              onClick={() => p.handlers.openFolder(null)}
              onDragOver={allowDrop}
              onDrop={(e) => {
                const payload = decodeDrag(e.dataTransfer.getData(DRAG_MIME));
                if (payload) {
                  e.preventDefault();
                  p.handlers.drop(null, payload);
                }
              }}
            >
              {t("shell.nav.library")}
            </button>
            {p.path.map((f, i) => (
              <span key={f.id} className="ws-crumbs__seg">
                <ChevronRight size={14} aria-hidden />
                <button
                  type="button"
                  className="ws-crumbs__btn"
                  aria-current={i === p.path!.length - 1 ? "page" : undefined}
                  onClick={() => p.handlers.openFolder(f.id)}
                  onDragOver={allowDrop}
                  onDrop={(e) => dropOnFolder(e, f.id)}
                >
                  {f.name}
                </button>
              </span>
            ))}
          </nav>
        ) : (
          <h2 className="ws-lib__title">{p.title}</h2>
        )}
        <div className="ws-lib__tools">
          {p.path && (
            <button type="button" className="eb eb--sm eb--outline" onClick={p.handlers.createFolder}>
              <FolderPlus size={14} /> {t("workspace.folder.new")}
            </button>
          )}
          <label className="ws-lib__sort">
            <span className="sr-only">{t("workspace.sort.label")}</span>
            <select
              value={p.sort.key}
              onChange={(e) => p.onSort({ ...p.sort, key: e.target.value as SortKey })}
              aria-label={t("workspace.sort.label")}
            >
              {SORT_KEYS.map((s) => (
                <option key={s.key} value={s.key}>
                  {t(s.label)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="icon-btn"
            title={p.sort.dir === "asc" ? t("workspace.sort.asc") : t("workspace.sort.desc")}
            aria-label={p.sort.dir === "asc" ? t("workspace.sort.asc") : t("workspace.sort.desc")}
            onClick={() => p.onSort({ ...p.sort, dir: p.sort.dir === "asc" ? "desc" : "asc" })}
          >
            {p.sort.dir === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
          </button>
          <div className="ws-seg" role="group" aria-label={t("workspace.view.label")}>
            <button
              type="button"
              className={`icon-btn ${p.viewMode === "grid" ? "is-active" : ""}`}
              aria-pressed={p.viewMode === "grid"}
              title={t("workspace.view.grid")}
              aria-label={t("workspace.view.grid")}
              onClick={() => p.onViewMode("grid")}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              type="button"
              className={`icon-btn ${p.viewMode === "list" ? "is-active" : ""}`}
              aria-pressed={p.viewMode === "list"}
              title={t("workspace.view.list")}
              aria-label={t("workspace.view.list")}
              onClick={() => p.onViewMode("list")}
            >
              <List size={16} />
            </button>
          </div>
        </div>
      </header>

      <div className="ws-kinds" role="group" aria-label={t("workspace.filter.kind")}>
        {ITEM_KINDS.map((k) => {
          const on = p.kindFilter.includes(k);
          return (
            <button
              key={k}
              type="button"
              className={`ws-kinds__chip ${on ? "is-active" : ""}`}
              aria-pressed={on}
              onClick={() => p.onKindFilter(on ? p.kindFilter.filter((x) => x !== k) : [...p.kindFilter, k])}
            >
              {KIND_ICON[k]} {t(KIND_KEY[k])}
            </button>
          );
        })}
        {p.kindFilter.length > 0 && (
          <button type="button" className="ws-kinds__clear" onClick={() => p.onKindFilter([])}>
            <X size={12} /> {t("workspace.filter.clear")}
          </button>
        )}
      </div>

      {selectedCount > 0 && (
        <div className="ws-selbar" role="toolbar" aria-label={t("workspace.selection.label")}>
          <strong>{tn("workspace.selection.count", selectedCount)}</strong>
          <button type="button" className="eb eb--sm eb--ghost" onClick={() => p.onSelection(selectAll(order))}>
            {t("workspace.selection.all")}
          </button>
          <span className="ws-selbar__sep" />
          <button type="button" className="eb eb--sm eb--outline" onClick={() => p.handlers.move(sel)}>
            <FolderInput size={14} /> {t("workspace.move_to")}
          </button>
          {sel.itemIds.length > 0 && (
            <>
              <button type="button" className="eb eb--sm eb--outline" onClick={() => p.handlers.tag(sel.itemIds)}>
                <Tag size={14} /> {t("workspace.tags_edit")}
              </button>
              <button
                type="button"
                className="eb eb--sm eb--outline"
                onClick={() => p.handlers.star(sel.itemIds, true)}
              >
                <Star size={14} /> {t("workspace.star")}
              </button>
              <button type="button" className="eb eb--sm eb--outline" onClick={() => p.handlers.duplicate(sel.itemIds)}>
                <Copy size={14} /> {t("common.duplicate")}
              </button>
            </>
          )}
          <button type="button" className="eb eb--sm eb--danger" onClick={() => p.handlers.trash(sel)}>
            <Trash2 size={14} /> {t("workspace.trash.move")}
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t("workspace.selection.clear")}
            aria-label={t("workspace.selection.clear")}
            onClick={() => p.onSelection({ selected: [], anchor: null })}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {total === 0 ? (
        <div className="ws-empty">
          <Folder size={32} aria-hidden />
          <p>{p.emptyHint ?? t("workspace.empty")}</p>
        </div>
      ) : p.viewMode === "grid" ? (
        <div
          className="ws-grid"
          onClick={(e) => e.target === e.currentTarget && p.onSelection({ selected: [], anchor: null })}
        >
          {p.folders.map((f) => {
            const id = folderSel(f.id);
            return (
              <div
                key={id}
                className={`ws-card ws-card--folder ${selected.has(id) ? "is-selected" : ""}`}
                draggable
                onDragStart={(e) => dragStart(e, "folder", f.id)}
                onDragOver={allowDrop}
                onDrop={(e) => dropOnFolder(e, f.id)}
                onClick={(e) => onClickEntry(e, id)}
                onDoubleClick={() => p.handlers.openFolder(f.id)}
              >
                <input
                  type="checkbox"
                  className="ws-card__check"
                  checked={selected.has(id)}
                  aria-label={`${t("workspace.select")} ${f.name}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => p.onSelection(toggleSelect(p.selection, id))}
                />
                <button
                  type="button"
                  className="ws-card__main"
                  onKeyDown={(e) => onKey(e, id, () => p.handlers.openFolder(f.id), "folder", f.id)}
                >
                  <Folder size={22} />
                  <span className="ws-card__title">{f.name}</span>
                </button>
                <Menu
                  label={`${t("workspace.actions")} ${f.name}`}
                  trigger={<MoreHorizontal size={16} />}
                  items={folderMenu(f)}
                  className="ws-card__menu"
                />
              </div>
            );
          })}
          {sorted.map((it) => {
            const id = itemSel(it.id);
            return (
              <div
                key={id}
                className={`ws-card ws-card--${it.kind} ${selected.has(id) ? "is-selected" : ""}`}
                draggable
                onDragStart={(e) => dragStart(e, "item", it.id)}
                onClick={(e) => onClickEntry(e, id)}
                onDoubleClick={() => !it.locked && p.handlers.open(it)}
              >
                <input
                  type="checkbox"
                  className="ws-card__check"
                  checked={selected.has(id)}
                  aria-label={`${t("workspace.select")} ${it.title}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => p.onSelection(toggleSelect(p.selection, id))}
                />
                <button
                  type="button"
                  className="ws-card__main"
                  onKeyDown={(e) => onKey(e, id, () => !it.locked && p.handlers.open(it), "item", it.id)}
                >
                  <span className="ws-card__icon">{it.locked ? <Lock size={20} /> : KIND_ICON[it.kind]}</span>
                  <span className="ws-card__title">{it.title}</span>
                </button>
                {it.starred && <Star size={14} className="ws-card__star" aria-label={t("workspace.starred")} />}
                <Menu
                  label={`${t("workspace.actions")} ${it.title}`}
                  trigger={<MoreHorizontal size={16} />}
                  items={itemMenu(it)}
                  className="ws-card__menu"
                />
                <div className="ws-card__meta">{badges(it)}</div>
                <div className="ws-card__sub">
                  <span>{t(KIND_KEY[it.kind])}</span>
                  <span title={fmt.dateTime(it.modifiedAt)}>{fmt.date(it.modifiedAt)}</span>
                  <span>{fmt.bytes(it.size)}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <table className="ws-table">
          <thead>
            <tr>
              <th className="ws-table__check" aria-label={t("workspace.select")} />
              <th>{t("workspace.col.name")}</th>
              <th>{t("workspace.col.kind")}</th>
              <th>{t("workspace.col.modified")}</th>
              <th>{t("workspace.col.size")}</th>
              <th>{t("workspace.col.tags")}</th>
              <th aria-label={t("workspace.actions")} />
            </tr>
          </thead>
          <tbody>
            {p.folders.map((f) => {
              const id = folderSel(f.id);
              return (
                <tr
                  key={id}
                  className={selected.has(id) ? "is-selected" : ""}
                  draggable
                  onDragStart={(e) => dragStart(e, "folder", f.id)}
                  onDragOver={allowDrop}
                  onDrop={(e) => dropOnFolder(e, f.id)}
                  onClick={(e) => onClickEntry(e, id)}
                  onDoubleClick={() => p.handlers.openFolder(f.id)}
                >
                  <td className="ws-table__check">
                    <input
                      type="checkbox"
                      checked={selected.has(id)}
                      aria-label={`${t("workspace.select")} ${f.name}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => p.onSelection(toggleSelect(p.selection, id))}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ws-table__name"
                      onKeyDown={(e) => onKey(e, id, () => p.handlers.openFolder(f.id), "folder", f.id)}
                      onClick={(e) => {
                        e.stopPropagation();
                        p.handlers.openFolder(f.id);
                      }}
                    >
                      <Folder size={16} /> {f.name}
                    </button>
                  </td>
                  <td>{t("workspace.folder.kind")}</td>
                  <td />
                  <td />
                  <td />
                  <td>
                    <Menu
                      label={`${t("workspace.actions")} ${f.name}`}
                      trigger={<MoreHorizontal size={16} />}
                      items={folderMenu(f)}
                    />
                  </td>
                </tr>
              );
            })}
            {sorted.map((it) => {
              const id = itemSel(it.id);
              return (
                <tr
                  key={id}
                  className={selected.has(id) ? "is-selected" : ""}
                  draggable
                  onDragStart={(e) => dragStart(e, "item", it.id)}
                  onClick={(e) => onClickEntry(e, id)}
                  onDoubleClick={() => !it.locked && p.handlers.open(it)}
                >
                  <td className="ws-table__check">
                    <input
                      type="checkbox"
                      checked={selected.has(id)}
                      aria-label={`${t("workspace.select")} ${it.title}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => p.onSelection(toggleSelect(p.selection, id))}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ws-table__name"
                      onKeyDown={(e) => onKey(e, id, () => !it.locked && p.handlers.open(it), "item", it.id)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!it.locked) p.handlers.open(it);
                      }}
                    >
                      {it.locked ? <Lock size={16} /> : KIND_ICON[it.kind]} {it.title}
                      {it.starred && <Star size={13} className="ws-table__star" aria-label={t("workspace.starred")} />}
                    </button>
                  </td>
                  <td>{t(KIND_KEY[it.kind])}</td>
                  <td title={fmt.dateTime(it.modifiedAt)}>{fmt.date(it.modifiedAt)}</td>
                  <td>{fmt.bytes(it.size)}</td>
                  <td>{badges(it)}</td>
                  <td>
                    <Menu
                      label={`${t("workspace.actions")} ${it.title}`}
                      trigger={<MoreHorizontal size={16} />}
                      items={itemMenu(it)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
