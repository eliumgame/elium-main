/**
 * Roles & permissions editor — the granular, modifiable RBAC surface. Lists the
 * org's roles (system clones + custom), and lets an admin build a custom role by
 * ticking any subset of the permission catalog, grouped by domain. System roles
 * are read-only (clone to edit).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldHalf, Plus, Save, Trash2, Copy, Lock } from "lucide-react";
import { useDrive } from "../session";
import { useDialogs } from "../../ui/dialogs";
import type { PermissionDef, RoleDef } from "../types";

const DOMAIN_LABEL: Record<string, string> = {
  content: "Contenu",
  share: "Partage",
  members: "Membres",
  roles: "Rôles",
  org: "Organisation",
  security: "Sécurité",
};

const COLORS = ["#1d4ed8", "#0ea5e9", "#16a34a", "#ca8a04", "#dc2626", "#7c3aed", "#db2777", "#64748b"];

export default function RolesPanel() {
  const d = useDrive();
  const dialogs = useDialogs();
  const [catalog, setCatalog] = useState<PermissionDef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; description: string; color: string; perms: Set<string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const orgId = d.currentOrg?.id ?? "";
  const canManage = d.currentOrg?.roleKey === "owner" || d.currentOrg?.roleKey === "admin";

  useEffect(() => {
    d.api.permissionCatalog().then((res) => {
      const list = Array.isArray(res) ? res : res.permissions;
      setCatalog(list ?? []);
    }).catch(() => setCatalog([]));
  }, [d.api]);

  const selected = useMemo(() => d.roles.find((r) => r.id === selectedId) ?? null, [d.roles, selectedId]);

  useEffect(() => {
    if (!selectedId && d.roles.length) setSelectedId(d.roles[0]!.id);
  }, [d.roles, selectedId]);

  useEffect(() => {
    if (selected) setDraft({ name: selected.name, description: selected.description, color: selected.color, perms: new Set(selected.permissions) });
    else setDraft(null);
  }, [selected]);

  const grouped = useMemo(() => {
    const g: Record<string, PermissionDef[]> = {};
    for (const p of catalog) (g[p.domain] ??= []).push(p);
    return g;
  }, [catalog]);

  const reloadRoles = useCallback(async () => { if (orgId) await d.selectOrg(orgId); }, [d, orgId]);

  const editable = !!selected && !selected.isSystem && canManage && !!draft;

  const toggle = (key: string) => {
    if (!editable || !draft) return;
    const perms = new Set(draft.perms);
    if (perms.has(key)) perms.delete(key); else perms.add(key);
    setDraft({ ...draft, perms });
  };

  const save = async () => {
    if (!selected || !draft) return;
    setBusy(true); setErr(null);
    try {
      await d.api.updateRole(orgId, selected.id, {
        name: draft.name, description: draft.description, color: draft.color, permissions: [...draft.perms],
      });
      await reloadRoles();
    } catch (e) { setErr(e instanceof Error ? e.message : "Enregistrement impossible."); }
    finally { setBusy(false); }
  };

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const { role } = await d.api.createRole(orgId, { name: "Nouveau rôle", permissions: ["node.view", "node.download"] });
      await reloadRoles();
      setSelectedId((role as RoleDef).id);
    } catch (e) { setErr(e instanceof Error ? e.message : "Création impossible."); }
    finally { setBusy(false); }
  };

  const clone = async () => {
    if (!selected) return;
    setBusy(true); setErr(null);
    try {
      const { role } = await d.api.cloneRole(orgId, selected.id);
      await reloadRoles();
      setSelectedId((role as RoleDef).id);
    } catch (e) { setErr(e instanceof Error ? e.message : "Clonage impossible."); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!selected) return;
    if (!(await dialogs.confirm({ title: "Supprimer le rôle", message: `Supprimer « ${selected.name} » ?`, danger: true, confirmLabel: "Supprimer" }))) return;
    setBusy(true); setErr(null);
    try {
      await d.api.deleteRole(orgId, selected.id);
      setSelectedId(null);
      await reloadRoles();
    } catch (e) { setErr(e instanceof Error ? e.message : "Suppression impossible (rôle encore utilisé ?)."); }
    finally { setBusy(false); }
  };

  return (
    <div className="dc-roles">
      <aside className="dc-roles__list">
        <div className="dc-roles__list-head">
          <span>Rôles</span>
          {canManage && <button className="icon-btn" title="Nouveau rôle" onClick={() => void create()}><Plus size={16} /></button>}
        </div>
        {d.roles.map((r) => (
          <button key={r.id} className={`dc-role-item ${r.id === selectedId ? "is-active" : ""}`} onClick={() => setSelectedId(r.id)}>
            <span className="dc-role-dot" style={{ background: r.color }} />
            <span className="dc-role-item__name">{r.name}</span>
            {r.isSystem && <Lock size={12} className="dc-role-item__sys" />}
          </button>
        ))}
      </aside>

      <section className="dc-roles__editor">
        {!draft || !selected ? (
          <div className="dc-empty-list"><ShieldHalf size={30} /><p>Sélectionnez un rôle.</p></div>
        ) : (
          <>
            <div className="dc-roles__editor-head">
              <div className="dc-role-meta">
                <input className="input dc-role-name" value={draft.name} disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                <input className="input" placeholder="Description" value={draft.description} disabled={!editable} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                <div className="dc-role-colors">
                  {COLORS.map((c) => (
                    <button key={c} className={`dc-role-swatch ${draft.color === c ? "is-active" : ""}`} style={{ background: c }} disabled={!editable} onClick={() => setDraft({ ...draft, color: c })} aria-label={c} />
                  ))}
                </div>
              </div>
              <div className="dc-roles__editor-actions">
                {selected.isSystem ? (
                  <span className="badge badge--info"><Lock size={12} /> Rôle système</span>
                ) : canManage ? (
                  <>
                    <button className="eb eb--sm eb--primary" onClick={() => void save()} disabled={busy}><Save size={14} /> Enregistrer</button>
                    <button className="eb eb--sm eb--danger" onClick={() => void remove()} disabled={busy}><Trash2 size={14} /> Supprimer</button>
                  </>
                ) : null}
                {canManage && <button className="eb eb--sm eb--outline" onClick={() => void clone()} disabled={busy}><Copy size={14} /> Cloner</button>}
              </div>
            </div>
            {err && <p className="dc-error">{err}</p>}
            <div className="dc-perm-count">{draft.perms.size} permission(s) sur {catalog.length}</div>

            <div className="dc-perm-grid">
              {Object.entries(grouped).map(([domain, perms]) => (
                <fieldset key={domain} className="dc-perm-group">
                  <legend>{DOMAIN_LABEL[domain] ?? domain}</legend>
                  {perms.map((p) => (
                    <label key={p.key} className={`dc-perm ${draft.perms.has(p.key) ? "is-on" : ""} ${editable ? "" : "is-locked"}`}>
                      <input type="checkbox" checked={draft.perms.has(p.key)} disabled={!editable} onChange={() => toggle(p.key)} />
                      <span className="dc-perm__label">{p.label}</span>
                      <code className="dc-perm__key">{p.key}</code>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
