/**
 * Corbeille : éléments et dossiers supprimés, jours restants avant suppression
 * définitive (30 jours), restauration, suppression définitive et vidage.
 */
import { FileSpreadsheet, FileText, FileType, Folder, Presentation, RotateCcw, Trash2 } from "lucide-react";
import { useI18n, type MessageKey } from "../../i18n";
import { daysLeftInTrash, trashRoots } from "../model";
import { TRASH_RETENTION_DAYS, type ItemKind, type WorkFolder, type WorkItem } from "../types";

const ICON: Record<ItemKind, React.ReactNode> = {
  doc: <FileText size={18} />,
  sheet: <FileSpreadsheet size={18} />,
  slides: <Presentation size={18} />,
  pdf: <FileType size={18} />,
};
const KIND_KEY: Record<ItemKind, MessageKey> = {
  doc: "kind.doc",
  sheet: "kind.sheet",
  slides: "kind.slides",
  pdf: "kind.pdf",
};

export default function TrashView({
  items,
  folders,
  now,
  onRestore,
  onDeleteForever,
  onEmpty,
}: {
  items: WorkItem[];
  folders: WorkFolder[];
  now: Date;
  onRestore: (sel: { itemIds: string[]; folderIds: string[] }) => void;
  onDeleteForever: (sel: { itemIds: string[]; folderIds: string[] }) => void;
  onEmpty: () => void;
}) {
  const { t, tn, fmt } = useI18n();
  const roots = trashRoots(items, folders);
  const total = roots.items.length + roots.folders.length;
  const days = (iso: string) => tn("workspace.trash.days_left", daysLeftInTrash(iso, now));

  return (
    <section className="ws-lib" aria-label={t("shell.nav.trash")}>
      <header className="ws-lib__head">
        <h2 className="ws-lib__title">{t("shell.nav.trash")}</h2>
        <div className="ws-lib__tools">
          <button type="button" className="eb eb--sm eb--danger" disabled={total === 0} onClick={onEmpty}>
            <Trash2 size={14} /> {t("workspace.trash.empty_action")}
          </button>
        </div>
      </header>
      <p className="muted">{tn("workspace.trash.retention", TRASH_RETENTION_DAYS)}</p>
      {total === 0 ? (
        <div className="ws-empty">
          <Trash2 size={32} aria-hidden />
          <p>{t("workspace.trash.empty")}</p>
        </div>
      ) : (
        <table className="ws-table">
          <thead>
            <tr>
              <th>{t("workspace.col.name")}</th>
              <th>{t("workspace.col.kind")}</th>
              <th>{t("workspace.trash.deleted_on")}</th>
              <th>{t("workspace.trash.remaining")}</th>
              <th aria-label={t("workspace.actions")} />
            </tr>
          </thead>
          <tbody>
            {roots.folders.map((f) => (
              <tr key={`f:${f.id}`}>
                <td>
                  <span className="ws-table__name">
                    <Folder size={18} /> {f.name}
                  </span>
                </td>
                <td>{t("workspace.folder.kind")}</td>
                <td title={fmt.dateTime(f.trashedAt!)}>{fmt.date(f.trashedAt!)}</td>
                <td>{days(f.trashedAt!)}</td>
                <td className="ws-table__acts">
                  <button
                    type="button"
                    className="eb eb--sm eb--outline"
                    onClick={() => onRestore({ itemIds: [], folderIds: [f.id] })}
                  >
                    <RotateCcw size={14} /> {t("common.restore")}
                  </button>
                  <button
                    type="button"
                    className="eb eb--sm eb--ghost"
                    onClick={() => onDeleteForever({ itemIds: [], folderIds: [f.id] })}
                  >
                    <Trash2 size={14} /> {t("workspace.trash.delete_forever")}
                  </button>
                </td>
              </tr>
            ))}
            {roots.items.map((it) => (
              <tr key={`i:${it.id}`}>
                <td>
                  <span className="ws-table__name">
                    {ICON[it.kind]} {it.title}
                  </span>
                </td>
                <td>{t(KIND_KEY[it.kind])}</td>
                <td title={fmt.dateTime(it.trashedAt!)}>{fmt.date(it.trashedAt!)}</td>
                <td>{days(it.trashedAt!)}</td>
                <td className="ws-table__acts">
                  <button
                    type="button"
                    className="eb eb--sm eb--outline"
                    onClick={() => onRestore({ itemIds: [it.id], folderIds: [] })}
                  >
                    <RotateCcw size={14} /> {t("common.restore")}
                  </button>
                  <button
                    type="button"
                    className="eb eb--sm eb--ghost"
                    onClick={() => onDeleteForever({ itemIds: [it.id], folderIds: [] })}
                  >
                    <Trash2 size={14} /> {t("workspace.trash.delete_forever")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
