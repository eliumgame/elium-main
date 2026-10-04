/**
 * Barre latérale de l'espace de travail : navigation (Accueil, Mon espace,
 * Favoris, Récents, Corbeille, Recherche), arbre de dossiers (cibles de
 * glisser-déposer) et étiquettes.
 */
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Library,
  Pencil,
  Search,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { childFolders } from "../model";
import type { WorkFolder } from "../types";
import { DRAG_MIME, decodeDrag, type DragPayload } from "./selection";

export type ShellView = "home" | "library" | "starred" | "recent" | "trash" | "search";

export interface SidebarProps {
  view: ShellView;
  onView: (v: ShellView) => void;
  folders: WorkFolder[];
  currentFolderId: string | null;
  onOpenFolder: (id: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (id: string) => void;
  onTrashFolder: (id: string) => void;
  tags: { tag: string; count: number }[];
  activeTag: string | null;
  onSelectTag: (tag: string | null) => void;
  trashCount: number;
  /** Éléments/dossiers déposés sur un dossier (null = racine). */
  onDrop: (target: string | null, payload: DragPayload) => void;
}

export default function Sidebar(p: SidebarProps) {
  const { t, fmt } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<string | null | undefined>(undefined);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const dropProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(target);
    },
    onDragLeave: () => setOver((cur) => (cur === target ? undefined : cur)),
    onDrop: (e: React.DragEvent) => {
      const payload = decodeDrag(e.dataTransfer.getData(DRAG_MIME));
      setOver(undefined);
      if (!payload) return;
      e.preventDefault();
      p.onDrop(target, payload);
    },
  });

  const nav: { id: ShellView; icon: React.ReactNode; label: string; badge?: number }[] = [
    { id: "home", icon: <Home size={16} />, label: t("shell.nav.home") },
    { id: "library", icon: <Library size={16} />, label: t("shell.nav.library") },
    { id: "starred", icon: <Star size={16} />, label: t("shell.nav.starred") },
    { id: "recent", icon: <Clock size={16} />, label: t("shell.nav.recent") },
    { id: "search", icon: <Search size={16} />, label: t("shell.nav.search") },
    { id: "trash", icon: <Trash2 size={16} />, label: t("shell.nav.trash"), badge: p.trashCount },
  ];

  const renderFolders = (parentId: string | null, depth: number): React.ReactNode =>
    childFolders(p.folders, parentId).map((f) => {
      const kids = childFolders(p.folders, f.id);
      const open = expanded.has(f.id);
      const active = p.view === "library" && p.currentFolderId === f.id;
      return (
        <li key={f.id} role="none">
          <div
            className={`ws-tree__row ${active ? "is-active" : ""} ${over === f.id ? "is-over" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            {...dropProps(f.id)}
          >
            <button
              type="button"
              className="ws-tree__chev"
              aria-label={open ? t("workspace.folder.collapse") : t("workspace.folder.expand")}
              aria-expanded={kids.length ? open : undefined}
              disabled={kids.length === 0}
              onClick={() => toggle(f.id)}
            >
              {kids.length === 0 ? null : open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            <button
              type="button"
              className="ws-tree__name"
              aria-current={active ? "page" : undefined}
              onClick={() => {
                p.onOpenFolder(f.id);
                if (kids.length && !open) toggle(f.id);
              }}
            >
              {active || open ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span>{f.name}</span>
            </button>
            <span className="ws-tree__actions">
              <button
                type="button"
                className="icon-btn"
                title={t("workspace.folder.new_sub")}
                aria-label={t("workspace.folder.new_sub")}
                onClick={() => p.onCreateFolder(f.id)}
              >
                <FolderPlus size={13} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={t("common.rename")}
                aria-label={`${t("common.rename")} ${f.name}`}
                onClick={() => p.onRenameFolder(f.id)}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--danger"
                title={t("workspace.trash.move")}
                aria-label={`${t("workspace.trash.move")} ${f.name}`}
                onClick={() => p.onTrashFolder(f.id)}
              >
                <Trash2 size={13} />
              </button>
            </span>
          </div>
          {kids.length > 0 && open && (
            <ul role="group" className="ws-tree__children">
              {renderFolders(f.id, depth + 1)}
            </ul>
          )}
        </li>
      );
    });

  return (
    <nav className="ws-side" aria-label={t("shell.nav.label")}>
      <ul className="ws-side__nav">
        {nav.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              className={`ws-side__item ${p.view === n.id ? "is-active" : ""} ${n.id === "library" && over === null ? "is-over" : ""}`}
              aria-current={p.view === n.id ? "page" : undefined}
              onClick={() => {
                if (n.id === "library") p.onOpenFolder(null);
                else p.onView(n.id);
              }}
              {...(n.id === "library" ? dropProps(null) : {})}
            >
              {n.icon}
              <span>{n.label}</span>
              {n.badge ? <span className="ws-side__badge">{fmt.number(n.badge)}</span> : null}
            </button>
          </li>
        ))}
      </ul>

      <div className="ws-side__head">
        <span>{t("workspace.folders")}</span>
        <button
          type="button"
          className="icon-btn"
          title={t("workspace.folder.new")}
          aria-label={t("workspace.folder.new")}
          onClick={() => p.onCreateFolder(p.view === "library" ? p.currentFolderId : null)}
        >
          <FolderPlus size={15} />
        </button>
      </div>
      <ul className="ws-tree" role="tree" aria-label={t("workspace.folders")}>
        {p.folders.some((f) => !f.trashedAt) ? (
          renderFolders(null, 0)
        ) : (
          <li className="ws-side__empty">{t("workspace.folders_empty")}</li>
        )}
      </ul>

      {p.tags.length > 0 && (
        <>
          <div className="ws-side__head">
            <span>{t("workspace.tags")}</span>
          </div>
          <ul className="ws-tags">
            {p.tags.map(({ tag, count }) => (
              <li key={tag}>
                <button
                  type="button"
                  className={`ws-side__item ws-side__item--tag ${p.view === "library" && p.activeTag === tag ? "is-active" : ""}`}
                  onClick={() => p.onSelectTag(p.activeTag === tag ? null : tag)}
                >
                  <Tag size={14} />
                  <span>{tag}</span>
                  <span className="ws-side__badge">{fmt.number(count)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
