/** Audit log: a paginated, permission-gated view of the org's activity. */
import { useCallback, useEffect, useState } from "react";
import { ScrollText, RefreshCw } from "lucide-react";
import { useDrive } from "../session";
import { ApiError } from "../api";

interface Entry {
  id: number;
  actorEmail: string | null;
  actorDisplayName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  createdAt: string;
}

export default function AuditPanel() {
  const d = useDrive();
  const orgId = d.currentOrg?.id ?? "";
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (beforeId?: number) => {
    if (!orgId) return;
    setLoading(true);
    try {
      const res = await d.api.listAudit(orgId, beforeId ? { beforeId } : {});
      const list = (res.entries as Entry[]) ?? [];
      setEntries((cur) => (beforeId ? [...cur, ...list] : list));
      setNextBeforeId(res.nextBeforeId ?? null);
      setDenied(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setDenied(true);
    } finally {
      setLoading(false);
    }
  }, [d.api, orgId]);

  useEffect(() => { void load(); }, [load]);

  if (denied) return <div className="dc-empty-list"><ScrollText size={30} /><p>Vous n'avez pas la permission de consulter le journal d'audit.</p></div>;

  return (
    <div className="dc-browser">
      <div className="dc-toolbar">
        <span className="muted">Journal d'activité de l'organisation</span>
        <div className="dc-toolbar__spacer" />
        <button className="icon-btn" title="Actualiser" onClick={() => void load()}><RefreshCw size={15} /></button>
      </div>
      {entries.length === 0 ? (
        <div className="dc-empty-list"><ScrollText size={34} /><p>Aucune activité enregistrée.</p></div>
      ) : (
        <table className="dc-table">
          <thead><tr><th>Date</th><th>Acteur</th><th>Action</th><th>Ressource</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="dc-row">
                <td className="dc-row__muted">{new Date(e.createdAt).toLocaleString("fr-FR")}</td>
                <td>{e.actorDisplayName || e.actorEmail || "—"}</td>
                <td><code className="dc-perm__key">{e.action}</code></td>
                <td className="dc-row__muted">{e.resourceType || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {nextBeforeId && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button className="eb eb--sm eb--outline" disabled={loading} onClick={() => void load(nextBeforeId)}>Charger plus</button>
        </div>
      )}
    </div>
  );
}
