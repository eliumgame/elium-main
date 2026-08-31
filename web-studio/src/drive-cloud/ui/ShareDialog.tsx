/**
 * Share dialog: grant a member access by e-mail + role (re-wraps the node key
 * to their public key), list & revoke current access, and mint external links
 * (the decryption secret stays in the URL fragment). Purely orchestration —
 * the crypto is in ops.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { X, Share2, Link2, Trash2, Copy, UserPlus, Users2, PenLine } from "lucide-react";
import { useDrive } from "../session";
import { shareWithUser, shareWithGroup, createShareLink, type DriveEntry, type OpsCtx } from "../ops";
import { revokeShareWithRotation } from "../rotate";
import { ApiError } from "../api";

interface TeamOption {
  id: string;
  name: string;
  groupPublicHex: string;
}

interface ShareRow {
  id: string;
  principalType: string;
  principalId: string;
  roleId: string;
  roleName: string;
  name: string;
}

interface LinkRow {
  id: string;
  hasPassword: boolean;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdAt: string;
  /** Minted by "Demander une signature" (SignRequestDialog) rather than here. */
  canSign: boolean;
  partyLabel: string | null;
  partyStatus: string | null;
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
  const [linkExpiry, setLinkExpiry] = useState(""); // "" | "1" | "7" | "30" (jours)
  const [linkMaxDl, setLinkMaxDl] = useState(""); // "" = illimité
  const [linkPassword, setLinkPassword] = useState(""); // "" = pas de mot de passe
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [teamId, setTeamId] = useState("");
  const [teamRoleId, setTeamRoleId] = useState("");
  const [links, setLinks] = useState<LinkRow[]>([]);

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

  const reloadLinks = useCallback(async () => {
    try {
      const { links: l } = await ctx.api.listLinks(entry.id);
      setLinks((l as LinkRow[]) ?? []);
    } catch {
      setLinks([]);
    }
  }, [ctx.api, entry.id]);

  useEffect(() => {
    setRoleId(defaultRole);
    setLinkRoleId(viewerRole);
    setTeamRoleId(defaultRole);
    void reload();
    void reloadLinks();
    ctx.api
      .listGroups(ctx.orgId)
      .then(({ groups }) => setTeams((groups as TeamOption[]) ?? []))
      .catch(() => setTeams([]));
  }, [reload, reloadLinks, defaultRole, viewerRole, ctx.api, ctx.orgId]);

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
      setErr(
        e2 instanceof ApiError && e2.status === 404
          ? "Aucun utilisateur avec cet e-mail."
          : e2 instanceof Error
            ? e2.message
            : "Partage impossible.",
      );
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
      const stats = await revokeShareWithRotation(ctx, entry, row.id, (label) =>
        setRotating(`Rotation des clés : ${label}`),
      );
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
      const pwd = linkPassword.trim();
      const opts: { expiresAt?: string; maxDownloads?: number; hasPassword?: boolean } = {};
      if (linkExpiry) opts.expiresAt = new Date(Date.now() + Number(linkExpiry) * 86400_000).toISOString();
      const dl = Number(linkMaxDl);
      if (linkMaxDl && Number.isFinite(dl) && dl > 0) opts.maxDownloads = Math.floor(dl);
      if (pwd) opts.hasPassword = true;
      const { token, secret, publicHex } = await createShareLink(ctx, entry, linkRoleId, opts);
      if (pwd) {
        // Le secret est chiffré sous le mot de passe : le fragment ne porte que
        // le blob chiffré (jamais le secret en clair). Marqueur `e=` (encrypted).
        const { protectLinkSecret } = await import("../link-password");
        const blob = await protectLinkSecret(pwd, secret);
        setLinkUrl(`${location.origin}/?link=${token}#e=${publicHex}.${blob}`);
      } else {
        setLinkUrl(`${location.origin}/?link=${token}#k=${secret}.${publicHex}`);
      }
      await reloadLinks();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Création du lien impossible.");
    } finally {
      setBusy(false);
    }
  };

  // Revocation d'un lien individuel : ne touche qu'à ce lien (pas de rotation
  // de clés) — les autres liens actifs et les partages restent inchangés.
  const doRevokeLink = async (linkId: string) => {
    setErr(null);
    setBusy(true);
    try {
      await ctx.api.revokeLink(entry.id, linkId);
      setInfo("Lien révoqué.");
      await reloadLinks();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Révocation du lien impossible.");
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

  return (
    <div
      className="dcx-modal-overlay elx"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dcx-modal dcx-modal--wide" role="dialog" aria-modal="true">
        <header className="dcx-modal__head">
          <h2>
            <Share2 size={18} /> Partager « {entry.name} »
          </h2>
          <button className="elx-icon" onClick={onClose} aria-label="Fermer">
            <X size={18} />
          </button>
        </header>

        <form className="dcx-inline" onSubmit={addShare}>
          <input
            className="elx-input"
            type="email"
            placeholder="E-mail du membre"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <select className="elx-select--surface" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {d.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="elx-mini elx-mini--primary" disabled={busy || !email.trim()}>
            <UserPlus size={14} /> Partager
          </button>
        </form>
        {err && <p className="elx-form__error">{err}</p>}
        {rotating && (
          <p className="muted" role="status" aria-busy="true">
            {rotating}
          </p>
        )}
        {info && !rotating && (
          <p className="muted" role="status">
            {info}
          </p>
        )}

        {teams.length > 0 && (
          <div className="dcx-inline">
            <Users2 size={16} style={{ color: "var(--x-mute)", flex: "none" }} />
            <select className="elx-select--surface" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Partager avec une équipe…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select className="elx-select--surface" value={teamRoleId} onChange={(e) => setTeamRoleId(e.target.value)}>
              {d.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button className="elx-mini" disabled={busy || !teamId} onClick={() => void shareTeam()}>
              Partager
            </button>
          </div>
        )}

        <div className="dcx-modal__section">
          <h3 className="dcx-modal__section-title">Accès actuels</h3>
          {shares.length === 0 ? (
            <p className="elx-empty">
              Aucun partage direct. Le propriétaire et le recouvrement d'organisation ont toujours accès.
            </p>
          ) : (
            shares.map((s) => (
              <div key={s.id} className="elx-row">
                <span className="elx-row__label">{s.name}</span>
                <span className="elx-chip">{s.roleName}</span>
                <span className="elx-row__meta">{s.principalType === "org" ? "recouvrement" : s.principalType}</span>
                {s.principalType !== "org" && (
                  <button
                    className="elx-icon elx-icon--danger"
                    title="Retirer l'accès (rotation des clés)"
                    aria-label={`Retirer l'accès de ${s.name}`}
                    disabled={busy}
                    onClick={() => void revoke(s)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <div className="dcx-modal__section">
          <h3 className="dcx-modal__section-title">
            <Link2 size={13} /> Lien externe
          </h3>
          <div className="dcx-fieldrow">
            <label className="dcx-field">
              <span>Rôle</span>
              <select
                className="elx-select--surface"
                value={linkRoleId}
                onChange={(e) => setLinkRoleId(e.target.value)}
              >
                {d.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="dcx-field">
              <span>Expiration</span>
              <select
                className="elx-select--surface"
                value={linkExpiry}
                onChange={(e) => setLinkExpiry(e.target.value)}
              >
                <option value="">Jamais</option>
                <option value="1">1 jour</option>
                <option value="7">7 jours</option>
                <option value="30">30 jours</option>
              </select>
            </label>
            <label className="dcx-field">
              <span>Téléchargements max</span>
              <input
                className="elx-input"
                style={{ width: 92 }}
                type="number"
                min={1}
                placeholder="∞"
                value={linkMaxDl}
                onChange={(e) => setLinkMaxDl(e.target.value)}
              />
            </label>
            <label className="dcx-field">
              <span>Mot de passe</span>
              <input
                className="elx-input"
                style={{ width: 140 }}
                type="text"
                placeholder="facultatif"
                value={linkPassword}
                onChange={(e) => setLinkPassword(e.target.value)}
                autoComplete="off"
              />
            </label>
            <button className="elx-mini" style={{ marginLeft: "auto" }} onClick={() => void makeLink()} disabled={busy}>
              <Link2 size={14} /> Créer un lien
            </button>
          </div>
          {linkUrl && (
            <div className="dcx-inline" style={{ marginTop: 8, marginBottom: 0 }}>
              <input className="elx-input" readOnly value={linkUrl} onFocus={(e) => e.currentTarget.select()} />
              <button className="elx-icon" title="Copier" onClick={() => copy(linkUrl)}>
                <Copy size={15} />
              </button>
            </div>
          )}
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            Le secret de déchiffrement reste dans le fragment <code>#</code> du lien — le serveur ne le voit jamais.
          </p>

          <div style={{ marginTop: 16 }}>
            <h4 className="dcx-modal__section-title">Liens actifs</h4>
            {links.length === 0 ? (
              <p className="elx-empty">Aucun lien externe actif pour cet élément.</p>
            ) : (
              links.map((l) => (
                <div key={l.id} className="elx-row">
                  <span className="elx-row__label">Créé le {new Date(l.createdAt).toLocaleDateString("fr-FR")}</span>
                  {l.canSign && (
                    <span className="elx-chip" title="Créé par « Demander une signature »">
                      <PenLine size={11} /> Signature — {l.partyLabel || "signataire"}
                      {l.partyStatus === "signed" ? " (signé)" : l.partyStatus === "declined" ? " (refusé)" : ""}
                    </span>
                  )}
                  {l.expiresAt && (
                    <span className="elx-chip">Expire le {new Date(l.expiresAt).toLocaleDateString("fr-FR")}</span>
                  )}
                  {l.maxDownloads != null && (
                    <span className="elx-chip">
                      {l.downloadCount}/{l.maxDownloads} téléchargement{l.maxDownloads > 1 ? "s" : ""}
                    </span>
                  )}
                  {l.hasPassword && <span className="elx-chip">Protégé par mot de passe</span>}
                  <button
                    className="elx-icon elx-icon--danger"
                    title="Révoquer ce lien"
                    aria-label={`Révoquer le lien créé le ${new Date(l.createdAt).toLocaleDateString("fr-FR")}`}
                    disabled={busy}
                    onClick={() => void doRevokeLink(l.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
