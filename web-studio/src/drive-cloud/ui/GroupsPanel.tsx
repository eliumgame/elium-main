/**
 * Teams / groups panel. A team is a cryptographic principal (its own keypair):
 * a manager creates a team, adds employees (the team key is re-wrapped to each),
 * and can then share files with the whole team at once (see ShareDialog).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Users2, Plus, Trash2, UserPlus, X, ShieldCheck } from "lucide-react";
import { useDrive } from "../session";
import { useDialogs } from "../../ui/dialogs";
import { createTeam, addTeamMember, type OpsCtx } from "../ops";
import type { PublicUser } from "../types";
import type { WrappedKey } from "../node-crypto";
import { ApiError } from "../api";

interface GroupItem { id: string; name: string; description: string; color: string; groupPublicHex: string; memberCount: number; }
interface GroupMember { userId: string; email: string; displayName: string; p256PublicHex: string; isManager: boolean; addedAt: string; }

const COLORS = ["#0ea5e9", "#16a34a", "#7c3aed", "#db2777", "#ca8a04", "#1d4ed8", "#dc2626", "#0d9488"];

export default function GroupsPanel() {
  const d = useDrive();
  const dialogs = useDialogs();
  const orgId = d.currentOrg?.id ?? "";
  const canManage = d.currentOrg?.roleKey === "owner" || d.currentOrg?.roleKey === "admin" || d.currentOrg?.roleKey === "manager";

  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [myWrapped, setMyWrapped] = useState<WrappedKey | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // create-form state
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]!);
  const [emails, setEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");

  const ctx = useMemo<OpsCtx | null>(() => {
    if (!d.keys || !d.user || !d.currentOrg) return null;
    return { api: d.api, keys: d.keys, userId: d.user.id, orgId: d.currentOrg.id, orgPublicHex: d.currentOrg.orgPublicHex, roleIdByKey: d.roleIdByKey };
  }, [d.api, d.keys, d.user, d.currentOrg, d.roleIdByKey]);

  const reloadGroups = useCallback(async () => {
    if (!orgId) return;
    try {
      const { groups: g } = await d.api.listGroups(orgId);
      setGroups((g as GroupItem[]) ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) setErr(e instanceof Error ? e.message : "Erreur.");
      setGroups([]);
    }
  }, [d.api, orgId]);

  useEffect(() => { void reloadGroups(); }, [reloadGroups]);

  const openGroup = useCallback(async (id: string) => {
    setSelectedId(id);
    setCreating(false);
    try {
      const res = (await d.api.getGroup(orgId, id)) as { members: GroupMember[]; myWrappedGroupPrivate: WrappedKey | null };
      setMembers(res.members ?? []);
      setMyWrapped(res.myWrappedGroupPrivate ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erreur.");
    }
  }, [d.api, orgId]);

  const addEmail = () => {
    const e = emailInput.trim().toLowerCase();
    if (e && !emails.includes(e)) setEmails([...emails, e]);
    setEmailInput("");
  };

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true); setErr(null);
    try {
      const users: PublicUser[] = [];
      for (const email of emails) {
        try {
          const { user } = await d.api.lookupUser({ email });
          users.push(user);
        } catch {
          throw new Error(`Aucun utilisateur pour « ${email} ».`);
        }
      }
      await createTeam(ctx, name.trim(), "", color, users);
      setName(""); setEmails([]); setCreating(false);
      await reloadGroups();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Création impossible.");
    } finally { setBusy(false); }
  };

  const addMember = async () => {
    if (!ctx || !selectedId) return;
    const email = await dialogs.prompt({ title: "Ajouter un membre", label: "E-mail du membre" });
    if (!email) return;
    if (!myWrapped) { await dialogs.alert({ title: "Impossible", message: "Vous ne faites pas partie de cette équipe (clé indisponible)." }); return; }
    try {
      const { user } = await d.api.lookupUser({ email: email.trim() });
      await addTeamMember(ctx, selectedId, myWrapped, user);
      await openGroup(selectedId);
      await reloadGroups();
    } catch (e) {
      await dialogs.alert({ title: "Ajout impossible", message: e instanceof ApiError && e.status === 404 ? "Aucun utilisateur avec cet e-mail." : e instanceof Error ? e.message : "Erreur." });
    }
  };

  const removeMember = async (m: GroupMember) => {
    if (!selectedId) return;
    if (!(await dialogs.confirm({ title: "Retirer du groupe", message: `Retirer ${m.displayName || m.email} ?`, confirmLabel: "Retirer" }))) return;
    await d.api.removeGroupMember(orgId, selectedId, m.userId).catch(() => {});
    await openGroup(selectedId);
    await reloadGroups();
  };

  const deleteGroup = async (g: GroupItem) => {
    if (!(await dialogs.confirm({ title: "Supprimer l'équipe", message: `Supprimer « ${g.name} » ?`, danger: true, confirmLabel: "Supprimer" }))) return;
    await d.api.deleteGroup(orgId, g.id).catch(() => {});
    if (selectedId === g.id) { setSelectedId(null); setMembers([]); }
    await reloadGroups();
  };

  const selected = groups.find((g) => g.id === selectedId) ?? null;

  return (
    <div className="dc-roles">
      <aside className="dc-roles__list">
        <div className="dc-roles__list-head">
          <span>Équipes</span>
          {canManage && <button className="icon-btn" title="Nouvelle équipe" onClick={() => { setCreating(true); setSelectedId(null); }}><Plus size={16} /></button>}
        </div>
        {groups.length === 0 && <p className="muted dc-pad">Aucune équipe pour l'instant.</p>}
        {groups.map((g) => (
          <button key={g.id} className={`dc-role-item ${g.id === selectedId ? "is-active" : ""}`} onClick={() => void openGroup(g.id)}>
            <span className="dc-role-dot" style={{ background: g.color }} />
            <span className="dc-role-item__name">{g.name}</span>
            <span className="badge badge--neutral">{g.memberCount}</span>
          </button>
        ))}
      </aside>

      <section className="dc-roles__editor">
        {creating ? (
          <form className="dc-team-create" onSubmit={submitCreate}>
            <h3><Users2 size={18} /> Nouvelle équipe</h3>
            <label className="field"><span className="field__label">Nom de l'équipe</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing" required /></label>
            <div className="field">
              <span className="field__label">Couleur</span>
              <div className="dc-role-colors">
                {COLORS.map((c) => <button type="button" key={c} className={`dc-role-swatch ${color === c ? "is-active" : ""}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
              </div>
            </div>
            <div className="field">
              <span className="field__label">Membres (e-mails)</span>
              <div className="dc-chip-input">
                {emails.map((e) => <span key={e} className="dc-emailchip">{e}<button type="button" onClick={() => setEmails(emails.filter((x) => x !== e))}><X size={12} /></button></span>)}
                <input value={emailInput} onChange={(e) => setEmailInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }} placeholder="ajouter@exemple.fr ↵" type="email" />
              </div>
            </div>
            {err && <p className="dc-error">{err}</p>}
            <div className="dc-roles__editor-actions">
              <button className="eb eb--sm eb--primary" disabled={busy || !name.trim()}><Plus size={14} /> Créer l'équipe</button>
              <button type="button" className="eb eb--sm eb--ghost" onClick={() => setCreating(false)}>Annuler</button>
            </div>
          </form>
        ) : !selected ? (
          <div className="dc-empty-list"><Users2 size={30} /><p>Sélectionnez une équipe{canManage ? " ou créez-en une" : ""}.</p></div>
        ) : (
          <>
            <div className="dc-roles__editor-head">
              <div className="dc-role-meta">
                <h3 className="dc-role-name" style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="dc-role-dot" style={{ background: selected.color }} /> {selected.name}</h3>
                <p className="muted">{members.length} membre(s) · partage possible avec toute l'équipe</p>
              </div>
              <div className="dc-roles__editor-actions">
                {canManage && <button className="eb eb--sm eb--outline" onClick={() => void addMember()}><UserPlus size={14} /> Ajouter</button>}
                {canManage && <button className="eb eb--sm eb--danger" onClick={() => void deleteGroup(selected)}><Trash2 size={14} /> Supprimer</button>}
              </div>
            </div>
            {err && <p className="dc-error">{err}</p>}
            <div className="dc-team-members">
              {members.map((m) => (
                <div key={m.userId} className="dc-share-row">
                  <span className="dc-avatar" style={{ width: 30, height: 30, fontSize: 12 }}>{(m.displayName || m.email).slice(0, 1).toUpperCase()}</span>
                  <span className="dc-share-row__name">{m.displayName || m.email}<br /><span className="dc-row__muted">{m.email}</span></span>
                  {m.isManager && <span className="badge badge--info"><ShieldCheck size={11} /> Gérant</span>}
                  {canManage && !m.isManager && <button className="icon-btn icon-btn--danger" title="Retirer" onClick={() => void removeMember(m)}><Trash2 size={14} /></button>}
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
