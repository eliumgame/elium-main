/** Trash: all trashed nodes of the org, with restore or permanent delete. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Folder, File as FileIcon, Trash2, RotateCcw, RefreshCw } from "lucide-react";
import { useDrive } from "../session";
import { useDialogs } from "../../ui/dialogs";
import { listTrash, type DriveEntry, type OpsCtx } from "../ops";
import { ApiError } from "../api";

export default function TrashPanel() {
  const d = useDrive();
  const dialogs = useDialogs();
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);

  const ctx = useMemo<OpsCtx | null>(() => {
    if (!d.keys || !d.user || !d.currentOrg) return null;
    return {
      api: d.api,
      keys: d.keys,
      userId: d.user.id,
      orgId: d.currentOrg.id,
      orgPublicHex: d.currentOrg.orgPublicHex,
      roleIdByKey: d.roleIdByKey,
    };
  }, [d.api, d.keys, d.user, d.currentOrg, d.roleIdByKey]);

  const reload = useCallback(async () => {
    if (!ctx) return;
    setLoading(true);
    try {
      setEntries(await listTrash(ctx));
      setDenied(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setDenied(true);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // `restoreNode`/`purgeNode` used to fail silently (`.catch(() => {})`) — an
  // admin clicking "Restaurer" on a node they no longer have rights to (e.g.
  // its key was rotated away) saw nothing happen, with no clue why.
  const fail = async (title: string, e: unknown) => {
    await dialogs.alert({ title, message: e instanceof Error ? e.message : "Erreur." });
  };

  const restore = async (e: DriveEntry) => {
    try {
      await d.api.restoreNode(e.id);
    } catch (err) {
      await fail("Restauration impossible", err);
    }
    await reload();
  };
  const purge = async (e: DriveEntry) => {
    if (
      !(await dialogs.confirm({
        title: "Supprimer définitivement",
        message: `Supprimer définitivement « ${e.name} » ? Cette action est irréversible.`,
        danger: true,
        confirmLabel: "Supprimer définitivement",
      }))
    )
      return;
    try {
      await d.api.purgeNode(e.id);
    } catch (err) {
      await fail("Suppression impossible", err);
    }
    await reload();
  };

  if (denied)
    return (
      <div className="elx-empty">
        <Trash2 size={30} />
        <p>Vous n'avez pas accès à la corbeille de cette organisation.</p>
      </div>
    );

  return (
    <div className="dc-browser">
      <div className="dc-toolbar">
        <span className="muted">{entries.length} élément(s) dans la corbeille</span>
        <div className="dc-toolbar__spacer" />
        <button className="elx-icon" title="Actualiser" onClick={() => void reload()}>
          <RefreshCw size={15} />
        </button>
      </div>
      {loading ? (
        <p className="muted dc-pad">Chargement…</p>
      ) : entries.length === 0 ? (
        <div className="elx-empty">
          <Trash2 size={34} />
          <p>La corbeille est vide.</p>
        </div>
      ) : (
        <table className="dcx-table">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Mis à la corbeille</th>
              <th className="dcx-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="dcx-row" style={{ cursor: "default" }}>
                <td className="dcx-row__name">
                  {e.kind === "folder" ? <Folder size={18} className="dc-ic--folder" /> : <FileIcon size={18} />}
                  <span>{e.name}</span>
                </td>
                <td className="dcx-row__muted">{e.trashedAt ? new Date(e.trashedAt).toLocaleString("fr-FR") : "—"}</td>
                <td className="dcx-row__actions">
                  <button className="elx-icon" title="Restaurer" onClick={() => void restore(e)}>
                    <RotateCcw size={15} />
                  </button>
                  <button
                    className="elx-icon elx-icon--danger"
                    title="Supprimer définitivement"
                    onClick={() => void purge(e)}
                  >
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
