/**
 * Portail du propriétaire — réglages du déploiement SANS toucher au code :
 * inscription, rôle par défaut, quotas, sauvegarde obligatoire, rétention,
 * politique de sécurité et gestion des utilisateurs. Tout est stocké côté
 * serveur (/api/site/admin/*) et réservé au propriétaire du Drive ; on RÉUTILISE
 * les panneaux existants (invitations = MembersPanel, récupération =
 * RecoveryPanel, SSO/SCIM = SsoScimPanel) au lieu de les reconstruire.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyRound,
  UserPlus,
  Users,
  HardDrive,
  ShieldCheck,
  Save,
  Ban,
  RotateCcw,
  LogOut,
  LifeBuoy,
  Fingerprint,
  Mail,
  Crown,
} from "lucide-react";
import { useDrive } from "../session";
import type { SiteAdminSettings, SiteSettings, SiteUser, SignupMode } from "../api";
import MembersPanel from "./MembersPanel";

export type PortalLink = "recovery" | "sso" | "roles" | "audit";
type Section = "access" | "users" | "storage" | "security" | "invites";

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: "access", label: "Inscription & accès", icon: <KeyRound size={16} /> },
  { key: "users", label: "Utilisateurs", icon: <Users size={16} /> },
  { key: "storage", label: "Stockage & sauvegarde", icon: <HardDrive size={16} /> },
  { key: "security", label: "Sécurité", icon: <ShieldCheck size={16} /> },
  { key: "invites", label: "Invitations", icon: <Mail size={16} /> },
];

const UNITS = [
  { label: "Mo", factor: 1024 ** 2 },
  { label: "Go", factor: 1024 ** 3 },
  { label: "To", factor: 1024 ** 4 },
] as const;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function splitBytes(value: number | null): { n: string; u: number } {
  if (value == null) return { n: "", u: 1 };
  for (let i = UNITS.length - 1; i >= 0; i--) {
    if (value >= UNITS[i]!.factor && value % UNITS[i]!.factor === 0) return { n: String(value / UNITS[i]!.factor), u: i };
  }
  return { n: String(Math.round((value / UNITS[0]!.factor) * 100) / 100), u: 0 };
}

/** Saisie d'un volume : nombre + unité ; vide = illimité (null). */
export function BytesField({
  value,
  onChange,
  label,
  hint,
  testId,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  hint?: string;
  testId?: string;
}) {
  const [num, setNum] = useState(() => splitBytes(value).n);
  const [unit, setUnit] = useState(() => splitBytes(value).u);
  const emit = (n: string, u: number) => {
    const x = Number(n.replace(",", "."));
    if (n.trim() === "" || !Number.isFinite(x) || x < 0) onChange(null);
    else onChange(Math.round(x * UNITS[u]!.factor));
  };
  return (
    <label className="field dc-portal__field">
      <span className="field__label">{label}</span>
      <span className="dc-portal__bytes">
        <input
          className="input"
          inputMode="decimal"
          placeholder="Illimité"
          value={num}
          data-testid={testId}
          onChange={(e) => {
            setNum(e.target.value);
            emit(e.target.value, unit);
          }}
        />
        <select
          className="elx-select--surface"
          value={unit}
          onChange={(e) => {
            const u = Number(e.target.value);
            setUnit(u);
            emit(num, u);
          }}
          aria-label={`${label} — unité`}
        >
          {UNITS.map((u, i) => (
            <option key={u.label} value={i}>
              {u.label}
            </option>
          ))}
        </select>
      </span>
      {hint && <span className="muted dc-portal__hint">{hint}</span>}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  desc,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
  testId?: string;
}) {
  return (
    <label className="dc-portal__toggle">
      <input type="checkbox" checked={checked} data-testid={testId} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>{title}</b>
        <span className="muted dc-portal__hint">{desc}</span>
      </span>
    </label>
  );
}

const SIGNUP_CHOICES: { key: SignupMode; title: string; desc: string }[] = [
  { key: "open", title: "Ouverte", desc: "Toute personne peut créer un compte et obtient un espace Drive privé." },
  { key: "invite", title: "Sur invitation", desc: "Seules les personnes que vous invitez (onglet Invitations) peuvent s'inscrire." },
  { key: "closed", title: "Fermée", desc: "Personne ne peut s'inscrire. Les comptes existants continuent de fonctionner." },
];

export default function OwnerPortal({ onNavigate }: { onNavigate?: (t: PortalLink) => void }) {
  const d = useDrive();
  const [section, setSection] = useState<Section>("access");
  const [data, setData] = useState<SiteAdminSettings | null>(null);
  const [draft, setDraft] = useState<SiteSettings | null>(null);
  const [globalQuota, setGlobalQuota] = useState<number | null>(null);
  const [users, setUsers] = useState<SiteUser[]>([]);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await d.api.getSiteSettings();
      setData(s);
      setDraft(s.settings);
      setGlobalQuota(s.globalQuotaBytes);
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Chargement impossible." });
    }
  }, [d.api]);

  const loadUsers = useCallback(async () => {
    try {
      setUsers((await d.api.siteUsers()).users);
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Chargement des utilisateurs impossible." });
    }
  }, [d.api]);

  useEffect(() => {
    void load();
    void loadUsers();
  }, [load, loadUsers]);

  // Les rôles listés doivent être ceux de l'organisation du site.
  useEffect(() => {
    if (data && d.currentOrg?.id !== data.orgId) void d.selectOrg(data.orgId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.orgId, d.currentOrg?.id]);

  const dirty = useMemo(
    () =>
      !!data &&
      !!draft &&
      (JSON.stringify(draft) !== JSON.stringify(data.settings) || globalQuota !== data.globalQuotaBytes),
    [data, draft, globalQuota],
  );

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    try {
      await d.api.putSiteSettings(draft, globalQuota);
      setMsg({ tone: "ok", text: "Réglages enregistrés." });
      await load();
      await d.refreshSite();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Enregistrement impossible." });
    } finally {
      setBusy(false);
    }
  };

  const patchUser = async (u: SiteUser, patch: Parameters<typeof d.api.patchSiteUser>[1], ok: string) => {
    setMsg(null);
    try {
      await d.api.patchSiteUser(u.userId, patch);
      setMsg({ tone: "ok", text: ok });
      await loadUsers();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Action impossible." });
    }
  };

  if (!data || !draft) {
    return (
      <div className="dc-portal" data-testid="owner-portal">
        {msg ? <p className="dc-error">{msg.text}</p> : <p className="muted">Chargement du portail…</p>}
      </div>
    );
  }
  const set = <K extends keyof SiteSettings>(k: K, v: SiteSettings[K]) => setDraft({ ...draft, [k]: v });
  const usedPct = globalQuota ? Math.min(100, Math.round((data.usedBytes / globalQuota) * 100)) : null;

  return (
    <div className="dc-portal" data-testid="owner-portal">
      <nav className="dc-portal__tabs" aria-label="Sections du portail">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            className={`dc-portal__tab ${section === s.key ? "is-active" : ""}`}
            onClick={() => setSection(s.key)}
            data-testid={`portal-tab-${s.key}`}
          >
            {s.icon} {s.label}
          </button>
        ))}
      </nav>

      {msg && (
        <p className={msg.tone === "ok" ? "dc-portal__ok" : "dc-error"} role="status" data-testid="portal-msg">
          {msg.text}
        </p>
      )}

      {section === "access" && (
        <section className="dc-portal__card">
          <h2>
            <UserPlus size={18} /> Qui peut créer un compte ?
          </h2>
          <div className="dc-portal__choices" role="radiogroup" aria-label="Inscription">
            {SIGNUP_CHOICES.map((c) => (
              <label key={c.key} className={`dc-portal__choice ${draft.signupMode === c.key ? "is-active" : ""}`}>
                <input
                  type="radio"
                  name="signup"
                  checked={draft.signupMode === c.key}
                  onChange={() => set("signupMode", c.key)}
                  data-testid={`signup-${c.key}`}
                />
                <b>{c.title}</b>
                <span className="muted">{c.desc}</span>
              </label>
            ))}
          </div>
          <label className="field dc-portal__field">
            <span className="field__label">Rôle donné à chaque nouvel inscrit</span>
            <select
              className="elx-select--surface"
              value={draft.defaultRoleKey}
              onChange={(e) => set("defaultRoleKey", e.target.value)}
              data-testid="default-role"
            >
              {data.roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
            <span className="muted dc-portal__hint">
              « Éditeur » = membre simple : il crée et modifie ses propres fichiers dans son espace privé, sans voir ceux
              des autres.
            </span>
          </label>
          <Toggle
            checked={draft.membersCanCreateSpaces}
            onChange={(v) => set("membersCanCreateSpaces", v)}
            title="Chaque membre a son espace privé"
            desc="Les membres peuvent créer leurs dossiers à la racine du Drive. Seuls eux (et vous, via la clé d'organisation) y accèdent."
          />
          <label className="field dc-portal__field">
            <span className="field__label">Nom affiché sur l'écran de connexion</span>
            <input
              className="input"
              value={draft.siteName}
              maxLength={80}
              placeholder="Elium Drive"
              onChange={(e) => set("siteName", e.target.value)}
            />
          </label>
          <div className="dc-portal__links">
            <button className="eb eb--sm eb--ghost" onClick={() => onNavigate?.("roles")}>
              <Users size={14} /> Rôles & permissions
            </button>
            <button className="eb eb--sm eb--ghost" onClick={() => onNavigate?.("recovery")}>
              <LifeBuoy size={14} /> Recouvrement (clé d'organisation)
            </button>
            <button className="eb eb--sm eb--ghost" onClick={() => onNavigate?.("sso")}>
              <Fingerprint size={14} /> SSO & SCIM
            </button>
          </div>
        </section>
      )}

      {section === "users" && (
        <section className="dc-portal__card">
          <h2>
            <Users size={18} /> Utilisateurs ({users.length})
          </h2>
          <div className="dc-portal__tablewrap">
            <table className="dcx-table" data-testid="portal-users">
              <thead>
                <tr>
                  <th>Utilisateur</th>
                  <th>Rôle</th>
                  <th>Stockage</th>
                  <th>Quota</th>
                  <th>2FA</th>
                  <th>Sessions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.userId} className={u.suspended ? "is-suspended" : ""} data-testid={`user-row-${u.email}`}>
                    <td>
                      <b>{u.displayName || u.email}</b> {u.isOwner && <Crown size={13} aria-label="Propriétaire" />}
                      {u.suspended && <span className="badge badge--danger"> suspendu</span>}
                      <br />
                      <span className="muted">{u.email}</span>
                    </td>
                    <td>
                      {u.isOwner ? (
                        "Propriétaire"
                      ) : (
                        <select
                          className="elx-select--surface"
                          value={u.roleId}
                          aria-label={`Rôle de ${u.email}`}
                          onChange={(e) => void patchUser(u, { roleId: e.target.value }, "Rôle modifié.")}
                        >
                          {d.roles
                            .filter((r) => r.key !== "owner" && r.key !== "guest")
                            .map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                        </select>
                      )}
                    </td>
                    <td>{formatBytes(u.usedBytes)}</td>
                    <td>
                      <QuotaCell
                        user={u}
                        fallback={draft.perUserQuotaBytes}
                        onSave={(q) => void patchUser(u, { quotaBytes: q }, "Quota enregistré.")}
                      />
                    </td>
                    <td>{u.mfa ? "oui" : "non"}</td>
                    <td>{u.activeSessions}</td>
                    <td className="dc-portal__actions">
                      {!u.isOwner && (
                        <>
                          <button
                            className="elx-mini"
                            title="Déconnecter tous ses appareils"
                            onClick={() =>
                              void d.api
                                .revokeUserSessions(u.userId)
                                .then(loadUsers)
                                .then(() => setMsg({ tone: "ok", text: "Sessions révoquées." }))
                            }
                          >
                            <LogOut size={13} />
                          </button>
                          {u.suspended ? (
                            <button
                              className="elx-mini"
                              onClick={() => void patchUser(u, { suspended: false }, "Compte réactivé.")}
                            >
                              <RotateCcw size={13} /> Réactiver
                            </button>
                          ) : (
                            <button
                              className="elx-mini elx-mini--danger"
                              onClick={() => void patchUser(u, { suspended: true }, "Compte suspendu.")}
                            >
                              <Ban size={13} /> Suspendre
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted dc-portal__hint">
            Suspendre un compte coupe immédiatement ses sessions et bloque la connexion ; ses fichiers sont conservés.
          </p>
        </section>
      )}

      {section === "storage" && (
        <section className="dc-portal__card">
          <h2>
            <HardDrive size={18} /> Stockage
          </h2>
          <p>
            Utilisé : <b>{formatBytes(data.usedBytes)}</b>
            {globalQuota ? ` sur ${formatBytes(globalQuota)} (${usedPct} %)` : " (aucune limite globale)"} ·{" "}
            {data.versionCount} versions
          </p>
          {usedPct !== null && (
            <div className="dc-portal__bar" aria-hidden>
              <span style={{ width: `${usedPct}%` }} />
            </div>
          )}
          <div className="dc-portal__row">
            <BytesField
              label="Quota global du Drive"
              value={globalQuota}
              onChange={setGlobalQuota}
              hint="Vide = illimité."
              testId="quota-global"
            />
            <BytesField
              label="Quota par utilisateur (par défaut)"
              value={draft.perUserQuotaBytes}
              onChange={(v) => set("perUserQuotaBytes", v)}
              hint="Modifiable individuellement dans l'onglet Utilisateurs."
              testId="quota-user"
            />
          </div>

          <h2>
            <Save size={18} /> Sauvegarde & rétention
          </h2>
          <Toggle
            checked={draft.backupRequired}
            onChange={(v) => set("backupRequired", v)}
            title="Sauvegarde automatique obligatoire"
            desc="L'espace de travail de chaque utilisateur est envoyé automatiquement dans son Drive (une minute après chaque modification). L'option ne peut plus être désactivée par l'utilisateur."
            testId="backup-required"
          />
          <div className="dc-portal__row">
            <label className="field dc-portal__field">
              <span className="field__label">Conserver les anciennes versions (jours)</span>
              <input
                className="input"
                type="number"
                min={0}
                max={3650}
                value={draft.versionRetentionDays}
                onChange={(e) => set("versionRetentionDays", Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
              <span className="muted dc-portal__hint">
                0 = pour toujours. Au-delà, les versions anciennes (y compris des sauvegardes) sont supprimées ; la
                version courante est toujours gardée.
              </span>
            </label>
            <label className="field dc-portal__field">
              <span className="field__label">Vider la corbeille après (jours)</span>
              <input
                className="input"
                type="number"
                min={1}
                max={3650}
                value={draft.trashRetentionDays}
                onChange={(e) => set("trashRetentionDays", Math.max(1, Math.floor(Number(e.target.value) || 30)))}
              />
            </label>
          </div>
        </section>
      )}

      {section === "security" && (
        <section className="dc-portal__card">
          <h2>
            <ShieldCheck size={18} /> Politique de sécurité
          </h2>
          <Toggle
            checked={draft.mfaPolicy === "required"}
            onChange={(v) => set("mfaPolicy", v ? "required" : "optional")}
            title="Vérification en deux étapes (2FA) obligatoire"
            desc="Chaque utilisateur doit activer une application d'authentification ou une clé de sécurité avant d'accéder au moindre module. Activez d'abord la vôtre (menu Sécurité)."
            testId="mfa-required"
          />
          <label className="field dc-portal__field">
            <span className="field__label">Longueur minimale du mot de passe</span>
            <input
              className="input"
              type="number"
              min={8}
              max={128}
              value={draft.passwordMinLength}
              data-testid="password-min"
              onChange={(e) => set("passwordMinLength", Math.min(128, Math.max(8, Math.floor(Number(e.target.value) || 8))))}
            />
            <span className="muted dc-portal__hint">
              Appliquée à la création et au changement de mot de passe. Le chiffrement est de bout en bout : le serveur
              ne voit jamais les mots de passe, la règle est donc contrôlée par l'application. Recommandé : 12 ou plus.
            </span>
          </label>
        </section>
      )}

      {section === "invites" && (
        <section className="dc-portal__card">
          <h2>
            <Mail size={18} /> Invitations
          </h2>
          <p className="muted">
            En mode « Sur invitation », envoyez le lien généré à la personne invitée : elle pourra créer son compte avec
            l'adresse indiquée.
          </p>
          <MembersPanel />
        </section>
      )}

      {(section === "access" || section === "storage" || section === "security") && (
        <div className="dc-portal__savebar">
          <button className="eb eb--primary" disabled={!dirty || busy} onClick={() => void save()} data-testid="portal-save">
            <Save size={15} /> Enregistrer les réglages
          </button>
          {dirty && <span className="muted">Modifications non enregistrées</span>}
        </div>
      )}
    </div>
  );
}

/** Quota individuel : affiche la valeur effective, bouton pour la modifier. */
function QuotaCell({
  user,
  fallback,
  onSave,
}: {
  user: SiteUser;
  fallback: number | null;
  onSave: (q: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState<number | null>(user.quotaBytes);
  if (!editing) {
    const eff = user.quotaBytes ?? fallback;
    return (
      <button className="elx-mini" onClick={() => setEditing(true)} aria-label={`Quota de ${user.email}`}>
        {eff == null ? "Illimité" : formatBytes(eff)}
        {user.quotaBytes == null && eff != null ? " (défaut)" : ""}
      </button>
    );
  }
  return (
    <span className="dc-portal__quota-edit">
      <BytesField label="Quota" value={val} onChange={setVal} />
      <button
        className="elx-mini elx-mini--primary"
        onClick={() => {
          onSave(val);
          setEditing(false);
        }}
      >
        OK
      </button>
      <button
        className="elx-mini"
        title="Revenir au quota par défaut"
        onClick={() => {
          onSave(null);
          setEditing(false);
        }}
      >
        Défaut
      </button>
    </span>
  );
}
