/**
 * Share dialog: grant a member access by e-mail + role (re-wraps the node key
 * to their public key), list & revoke current access, and mint external links
 * (the decryption secret stays in the URL fragment). Purely orchestration —
 * the crypto is in ops.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { X, Share2, Link2, Trash2, Copy, UserPlus, Users2 } from "lucide-react";
import { useDrive } from "../session";
import { shareWithUser, shareWithGroup, createShareLink, type DriveEntry, type OpsCtx } from "../ops";
import { revokeShareWithRotation } from "../rotate";
import { ApiError } from "../api";

interface TeamOption { id: string; name: string; groupPublicHex: string; }

interface ShareRow {
  id: string;
  principalType: string;
  principalId: string;
  roleId: string;
  roleName: string;
  name: string;
}

export default function ShareDialog({ ctx, entry, onClose }: { ctx: OpsCtx; entry: DriveEntry; onClose: () => void }) {
  const d = useDrive();
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [linkRoleId, setLinkRoleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [teamId, setTeamId] = useState("");
  const [teamRoleId, setTeamRoleId] = useState("");

  const defaultRole = d.roleIdByKey["editor"] ?? d.roles[0]?.id ?? "";
  const viewerRole = d.roleIdByKey["viewer"] ?? defaultRole;

  const reload = useCallback(async () => {
    try {
      const { shares: s } = await ctx.api.listShares(entry.id);
      setShares((s as ShareRow[]) ?? []);
    } catch {
      setShares([]);
    }
  }, [ctx.api, entry.id]);

  useEffect(() => {
    setRoleId(defaultRole);
    setLinkRoleId(viewerRole);
    setTeamRoleId(defaultRole);
    void reload();
    ctx.api.listGroups(ctx.orgId)
      .then(({ groups }) => setTeams((groups as TeamOption[]) ?? []))
      .catch(() => setTeams([]));
  }, [reload, defaultRole, viewerRole, ctx.api, ctx.orgId]);

  const shareTeam = async () => {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;
    setErr(null);
    setBusy(true);
    try {
      await shareWithGroup(ctx, entry, team.id, team.groupPublicHex, teamRoleId);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Partage impossible.");
    } finally {
      setBusy(false);
    }
  };

  const addShare = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const { user } = await ctx.api.lookupUser({ email: email.trim() });
      await shareWithUser(ctx, entry, user, roleId);
      setEmail("");
      await reload();
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.status === 404 ? "Aucun utilisateur avec cet e-mail." : e2 instanceof Error ? e2.message : "Partage impossible.");
    } finally {
      setBusy(false);
    }
  };

  // Revocation = drop the authorization (deep on folders) THEN rotate the
  // keys of the whole subtree, so a key the revoked principal may have cached
  // no longer opens anything. Also revokes the node's external links.
  const revoke = async (row: ShareRow) => {
    setErr(null);
    setBusy(true);
    setRotating("Révocation…");
    try {
      const stats = await revokeShareWithRotation(ctx, entry, row.id, (label) => setRotating(`Rotation des clés : ${label}`));
      setInfo(
        `Accès retiré. Clés régénérées sur ${stats.rotated} élément${stats.rotated > 1 ? "s" : ""}` +
          (stats.revokedLinks ? ` — ${stats.revokedLinks} lien(s) externe(s) révoqué(s), à recréer si besoin.` : ".") +
          (stats.skipped ? ` ${stats.skipped} élément(s) non déchiffrable(s) par vous ont conservé leur clé.` : ""),
      );
      await reload();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Révocation impossible.");
    } finally {
      setRotating(null);
      setBusy(false);
    }
  };

  const makeLink = async () => {
    setErr(null);
    setBusy(true);
    try {
      const { token, secret, publicHex } = await createShareLink(ctx, entry, linkRoleId);
      setLinkUrl(`${location.origin}/?link=${token}#k=${secret}.${publicHex}`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Création du lien impossible.");
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => { void navigator.clipboard?.writeText(text); };

  return (
    <div className="dc-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dc-modal" role="dialog" aria-modal="true">
        <header className="dc-modal__head">
          <h2><Share2 size={18} /> Partager « {entry.name} »</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </header>

        <form className="dc-share-add" onSubmit={addShare}>
          <input className="input" type="email" placeholder="E-mail du membre" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <select className="tool-select" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {d.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button className="eb eb--sm eb--primary" disabled={busy || !email.trim()}><UserPlus size={14} /> Partager</button>
        </form>
        {err && <p className="dc-error">{err}</p>}
        {rotating && <p className="muted" role="status" aria-busy="true">{rotating}</p>}
        {info && !rotating && <p className="muted" role="status">{info}</p>}

        {teams.length > 0 && (
          <div className="dc-share-team">
            <Users2 size={16} className="dc-invite__ic" />
            <select className="tool-select" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Partager avec une équipe…</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select className="tool-select" value={teamRoleId} onChange={(e) => setTeamRoleId(e.target.value)}>
              {d.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button className="eb eb--sm eb--outline" disabled={busy || !teamId} onClick={() => void shareTeam()}>Partager</button>
          </div>
        )}

        <div className="dc-share-list">
          <h3 className="dc-share-list__title">Accès actuels</h3>
          {shares.length === 0 ? (
            <p className="muted">Aucun partage direct. Le propriétaire et le recouvrement d'organisation ont toujours accès.</p>
          ) : (
            shares.map((s) => (
              <div key={s.id} className="dc-share-row">
                <span className="dc-share-row__name">{s.name}</span>
                <span className="badge badge--neutral">{s.roleName}</span>
                <span className="dc-share-row__type">{s.principalType === "org" ? "recouvrement" : s.principalType}</span>
                {s.principalType !== "org" && (
                  <button className="icon-btn icon-btn--danger" title="Retirer l'accès (rotation des clés)" aria-label={`Retirer l'accès de ${s.name}`} disabled={busy} onClick={() => void revoke(s)}><Trash2 size={14} /></button>
                )}
              </div>
            ))
          )}
        </div>

        <div className="dc-share-link">
          <h3 className="dc-share-list__title"><Link2 size={15} /> Lien externe</h3>
          <div className="dc-share-link__row">
            <select className="tool-select" value={linkRoleId} onChange={(e) => setLinkRoleId(e.target.value)}>
              {d.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button className="eb eb--sm eb--outline" onClick={() => void makeLink()} disabled={busy}><Link2 size={14} /> Créer un lien</button>
          </div>
          {linkUrl && (
            <div className="dc-share-link__out">
              <input className="input" readOnly value={linkUrl} onFocus={(e) => e.currentTarget.select()} />
              <button className="icon-btn" title="Copier" onClick={() => copy(linkUrl)}><Copy size={15} /></button>
            </div>
          )}
          <p className="muted dc-share-link__note">Le secret de déchiffrement reste dans le fragment <code>#</code> du lien — le serveur ne le voit jamais.</p>
        </div>
      </div>
    </div>
  );
}
