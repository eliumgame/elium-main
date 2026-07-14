/** Version history for a file: list, download or restore a previous version. */
import { useCallback, useEffect, useState } from "react";
import { X, History, Download, RotateCcw } from "lucide-react";
import { useDialogs } from "../../ui/dialogs";
import { downloadVersion, triggerDownload, type DriveEntry, type OpsCtx } from "../ops";

interface Version { id: string; versionNo: number; sizeBytes: number; createdByEmail?: string | null; createdAt: string; }

function humanSize(n: number): string {
  if (!n) return "—";
  const u = ["o", "Ko", "Mo", "Go"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export default function VersionsDialog({ ctx, entry, onClose }: { ctx: OpsCtx; entry: DriveEntry; onClose: () => void }) {
  const dialogs = useDialogs();
  const [versions, setVersions] = useState<Version[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const { versions: v } = await ctx.api.listVersions(entry.id);
    setVersions((v as Version[]) ?? []);
  }, [ctx.api, entry.id]);

  useEffect(() => { void reload(); }, [reload]);

  const download = async (ver: Version) => {
    try {
      const { bytes, name } = await downloadVersion(ctx, entry, ver.id);
      triggerDownload(bytes, `${name}.v${ver.versionNo}`);
    } catch (e) {
      await dialogs.alert({ title: "Téléchargement impossible", message: e instanceof Error ? e.message : "Erreur." });
    }
  };
  const restore = async (ver: Version) => {
    if (!(await dialogs.confirm({ title: "Restaurer la version", message: `Restaurer la version ${ver.versionNo} comme version actuelle ?`, confirmLabel: "Restaurer" }))) return;
    setBusy(true);
    try {
      await ctx.api.restoreVersion(entry.id, ver.id);
      await reload();
    } finally { setBusy(false); }
  };

  return (
    <div className="dc-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dc-modal">
        <header className="dc-modal__head">
          <h2><History size={18} /> Historique — « {entry.name} »</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </header>
        {versions.length === 0 ? (
          <p className="muted">Aucune version enregistrée.</p>
        ) : (
          <table className="dc-table">
            <thead><tr><th>Version</th><th>Taille</th><th>Date</th><th className="dc-table__actions">Actions</th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} className="dc-row">
                  <td><b>v{v.versionNo}</b>{v.createdByEmail ? <span className="dc-row__muted"> · {v.createdByEmail}</span> : null}</td>
                  <td className="dc-row__muted">{humanSize(v.sizeBytes)}</td>
                  <td className="dc-row__muted">{new Date(v.createdAt).toLocaleString("fr-FR")}</td>
                  <td className="dc-row__actions">
                    <button className="icon-btn" title="Télécharger cette version" onClick={() => void download(v)}><Download size={15} /></button>
                    <button className="icon-btn" title="Restaurer cette version" disabled={busy} onClick={() => void restore(v)}><RotateCcw size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
