/**
 * Members panel: view members, invite by e-mail with a role, change roles, and
 * remove members. Invitation yields a token link the admin shares out of band;
 * granting a new member cryptographic access to existing files is a separate
 * share/recovery step (documented in the architecture).
 */
import { useCallback, useEffect, useState } from "react";
import { Users, UserPlus, Copy, Trash2, Mail } from "lucide-react";
import { useDrive } from "../session";
import { useDialogs } from "../../ui/dialogs";
import { ApiError } from "../api";

interface Member {
  userId: string;
  email: string;
  displayName: string;
  roleId: string;
  roleKey: string;
  status: string;
  joinedAt: string;
}

export default function MembersPanel() {
  const d = useDrive();
  const dialogs = useDialogs();
  const orgId = d.currentOrg?.id ?? "";
  const [members, setMembers] = useState<Member[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const canManage = d.currentOrg?.roleKey === "owner" || d.currentOrg?.roleKey === "admin" || d.currentOrg?.roleKey === "manager";
  const defaultRole = d.roleIdByKey["editor"] ?? d.roles[0]?.id ?? "";

  const reload = useCallback(async () => {
    if (!orgId) return;
    setErr(null);
    try {
      const { members: m } = await d.api.listMembers(orgId);
      setMembers((m as Member[]) ?? []);
      setDenied(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setDenied(true);
      else setErr(e instanceof Error ? e.message : "Chargement impossible.");
    }
  }, [d.api, orgId]);

  useEffect(() => { setInviteRole(defaultRole); void reload(); }, [reload, defaultRole]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setBusy(true); setInviteLink(null);
    try {
      const { token } = await d.api.invite(orgId, { email: inviteEmail.trim(), roleId: inviteRole });
      setInviteLink(`${location.origin}/?invite=${token}`);
      setInviteEmail("");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Invitation impossible.");
    } finally { setBusy(false); }
  };

  const changeRole = async (m: Member, roleId: string) => {
    try {
      await d.api.setMemberRole(orgId, m.userId, roleId);
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : "Changement de rôle impossible."); }
  };

  const remove = async (m: Member) => {
    if (!(await dialogs.confirm({ title: "Retirer le membre", message: `Retirer ${m.displayName || m.email} de l'organisation ?`, danger: true, confirmLabel: "Retirer" }))) return;
    try {
      await d.api.removeMember(orgId, m.userId);
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : "Retrait impossible."); }
  };

  if (denied) {
    return <div className="dc-empty-list"><Users size={30} /><p>Vous n'avez pas la permission de voir les membres de cette organisation.</p></div>;
  }

  return (
    <div className="dc-members">
      {canManage && (
        <form className="dc-invite" onSubmit={invite}>
          <Mail size={16} className="dc-invite__ic" />
          <input className="input" type="email" placeholder="E-mail à inviter" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
          <select className="tool-select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
            {d.roles.filter((r) => r.key !== "guest").map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button className="eb eb--sm eb--primary" disabled={busy || !inviteEmail.trim()}><UserPlus size={14} /> Inviter</button>
        </form>
      )}
      {inviteLink && (
        <div className="dc-share-link__out">
          <input className="input" readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} />
          <button className="icon-btn" title="Copier le lien d'invitation" onClick={() => void navigator.clipboard?.writeText(inviteLink)}><Copy size={15} /></button>
        </div>
      )}
      {err && <p className="dc-error">{err}</p>}

      <table className="dc-table">
        <thead><tr><th>Membre</th><th>Rôle</th><th>Statut</th><th className="dc-table__actions">Actions</th></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId} className="dc-row">
              <td className="dc-row__name">
                <span className="dc-avatar">{(m.displayName || m.email).slice(0, 1).toUpperCase()}</span>
                <span><b>{m.displayName || "—"}</b><br /><span className="dc-row__muted">{m.email}</span></span>
              </td>
              <td>
                {canManage && d.currentOrg?.roleKey !== "manager" ? (
                  <select className="tool-select" value={m.roleId} onChange={(e) => void changeRole(m, e.target.value)}>
                    {d.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                ) : (
                  <span className="badge badge--neutral">{m.roleKey}</span>
                )}
              </td>
              <td className="dc-row__muted">{m.status}</td>
              <td className="dc-row__actions">
                {canManage && <button className="icon-btn icon-btn--danger" title="Retirer" onClick={() => void remove(m)}><Trash2 size={15} /></button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
