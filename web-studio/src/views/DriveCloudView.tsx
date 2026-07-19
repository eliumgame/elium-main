/**
 * Elium Drive Entreprise — the cloud workspace shell. Gates on the session
 * (auth/unlock), then shows a sidebar workspace: brand, org switcher, nav
 * (Fichiers / Membres / Rôles), and the active panel. All content is
 * end-to-end encrypted; this view only orchestrates the panels.
 */
import { useMemo, useState } from "react";
import {
  Home, Cloud, LogOut, Building2, Plus, Files, Users, Users2, ShieldHalf, ChevronDown, Check, Trash2, ScrollText, ShieldCheck, Fingerprint, LifeBuoy,
} from "lucide-react";
import "../drive-cloud/drive-cloud.css";
import { DriveProvider, useDrive } from "../drive-cloud/session";
import AuthPanel from "../drive-cloud/ui/AuthPanel";
import DriveBrowser from "../drive-cloud/ui/DriveBrowser";
import MembersPanel from "../drive-cloud/ui/MembersPanel";
import GroupsPanel from "../drive-cloud/ui/GroupsPanel";
import RolesPanel from "../drive-cloud/ui/RolesPanel";
import TrashPanel from "../drive-cloud/ui/TrashPanel";
import AuditPanel from "../drive-cloud/ui/AuditPanel";
import SecurityPanel from "../drive-cloud/ui/SecurityPanel";
import SsoScimPanel from "../drive-cloud/ui/SsoScimPanel";
import RecoveryPanel from "../drive-cloud/ui/RecoveryPanel";

type Tab = "files" | "members" | "groups" | "roles" | "trash" | "audit" | "security" | "sso" | "recovery";

// `perm` (optional) gates a tab behind an org permission; tabs without it are
// always shown (the server still enforces access when a panel loads).
const NAV: { key: Tab; label: string; subtitle: string; icon: React.ReactNode; perm?: string }[] = [
  { key: "files", label: "Fichiers", subtitle: "Vos dossiers et fichiers chiffrés", icon: <Files size={18} /> },
  { key: "members", label: "Membres", subtitle: "Les personnes de votre organisation", icon: <Users size={18} /> },
  { key: "groups", label: "Équipes", subtitle: "Groupes d'employés pour partager en masse", icon: <Users2 size={18} /> },
  { key: "roles", label: "Rôles & permissions", subtitle: "Qui peut faire quoi, dans le détail", icon: <ShieldHalf size={18} /> },
  { key: "trash", label: "Corbeille", subtitle: "Éléments supprimés, restaurables", icon: <Trash2 size={18} /> },
  { key: "recovery", label: "Recouvrement", subtitle: "Recouvrer les fichiers via la clé d'organisation", icon: <LifeBuoy size={18} />, perm: "recovery.perform" },
  { key: "audit", label: "Journal d'audit", subtitle: "L'activité de l'organisation", icon: <ScrollText size={18} /> },
  { key: "security", label: "Sécurité", subtitle: "Vérification en deux étapes (2FA)", icon: <ShieldCheck size={18} /> },
  { key: "sso", label: "SSO & SCIM", subtitle: "Fournisseur d'identité et provisioning", icon: <Fingerprint size={18} /> },
];

function initials(s: string): string {
  const parts = s.split(/[@\s.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function CreateOrgCard() {
  const d = useDrive();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const s = (slug || name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    await d.createOrg(name, s).catch(() => {});
  };
  return (
    <div className="dc-hero-empty">
      <div className="dc-hero-empty__card">
        <span className="dc-hero-empty__badge"><Building2 size={30} /></span>
        <h2>Créez votre organisation</h2>
        <p className="muted">Une organisation regroupe vos membres, groupes, rôles et fichiers chiffrés. Vous en serez le propriétaire.</p>
        <form className="dc-org-form" onSubmit={submit}>
          <label className="field"><span className="field__label">Nom de l'organisation</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ma société" required /></label>
          <label className="field"><span className="field__label">Identifiant (slug)</span><input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="ma-societe" /></label>
          {d.error && <p className="dc-error">{d.error}</p>}
          <button className="eb eb--primary eb--block" disabled={d.busy || !name.trim()}><Plus size={16} /> Créer l'organisation</button>
        </form>
      </div>
    </div>
  );
}

function OrgSwitcher() {
  const d = useDrive();
  const [open, setOpen] = useState(false);
  if (!d.currentOrg) return null;
  return (
    <div className="dc-orgswitch">
      <button className="dc-orgswitch__btn" onClick={() => setOpen((o) => !o)}>
        <span className="dc-org-avatar">{initials(d.currentOrg.name)}</span>
        <span className="dc-orgswitch__name">{d.currentOrg.name}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="dc-orgswitch__menu" onMouseLeave={() => setOpen(false)}>
          {d.orgs.map((o) => (
            <button key={o.id} className={`dc-orgswitch__item ${o.id === d.currentOrg?.id ? "is-active" : ""}`} onClick={() => { void d.selectOrg(o.id); setOpen(false); }}>
              <span className="dc-org-avatar dc-org-avatar--sm">{initials(o.name)}</span>
              <span className="dc-orgswitch__itemname">{o.name}</span>
              {o.id === d.currentOrg?.id && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Workspace({ onHome }: { onHome: () => void }) {
  const d = useDrive();
  const [tab, setTab] = useState<Tab>("files");
  const active = NAV.find((n) => n.key === tab)!;
  const hasOrg = d.orgs.length > 0;

  // Current member's org permissions (owner bypasses everything server-side).
  const perms = useMemo(() => {
    const role = d.roles.find((r) => r.id === d.currentOrg?.roleId);
    return new Set(role?.permissions ?? []);
  }, [d.roles, d.currentOrg?.roleId]);
  const can = (p: string) => d.currentOrg?.roleKey === "owner" || perms.has(p);
  const nav = NAV.filter((n) => !n.perm || can(n.perm));

  return (
    <div className="dc-app">
      <aside className="dc-sidebar">
        <div className="dc-sidebar__brand"><Cloud size={20} /> <span>Drive</span> <span className="dc-chip">entreprise</span></div>
        {hasOrg && <div className="dc-sidebar__org"><OrgSwitcher /></div>}
        {hasOrg && (
          <nav className="dc-nav">
            {nav.map((n) => (
              <button key={n.key} className={`dc-nav__item ${tab === n.key ? "is-active" : ""}`} onClick={() => setTab(n.key)}>
                {n.icon} <span>{n.label}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="dc-sidebar__spacer" />
        <div className="dc-sidebar__foot">
          <div className="dc-userchip">
            <span className="dc-user-avatar">{initials(d.user?.displayName || d.user?.email || "?")}</span>
            <span className="dc-userchip__meta">
              <span className="dc-userchip__name">{d.user?.displayName || "Compte"}</span>
              <span className="dc-userchip__mail">{d.user?.email}</span>
            </span>
            <button className="icon-btn" title="Se déconnecter" onClick={() => void d.logout()}><LogOut size={16} /></button>
          </div>
          <button className="dc-sidebar__home" onClick={onHome}><Home size={15} /> Retour à l'accueil</button>
        </div>
      </aside>

      <div className="dc-workspace">
        {!hasOrg ? (
          <CreateOrgCard />
        ) : (
          <>
            <header className="dc-header">
              <div>
                <h1 className="dc-header__title">{active.label}</h1>
                <p className="dc-header__sub">{active.subtitle}</p>
              </div>
            </header>
            <main className="dc-main">
              {tab === "files" && <DriveBrowser />}
              {tab === "members" && <MembersPanel />}
              {tab === "groups" && <GroupsPanel />}
              {tab === "roles" && <RolesPanel />}
              {tab === "trash" && <TrashPanel />}
              {tab === "audit" && <AuditPanel />}
              {tab === "security" && <SecurityPanel />}
              {tab === "sso" && <SsoScimPanel />}
              {tab === "recovery" && <RecoveryPanel />}
            </main>
          </>
        )}
      </div>
    </div>
  );
}

function Shell({ onHome }: { onHome: () => void }) {
  const d = useDrive();
  if (d.status === "loading") return <div className="dc-loading"><Cloud size={28} /> Chargement…</div>;
  if (d.status !== "authenticated") return <AuthPanel onHome={onHome} />;
  return <Workspace onHome={onHome} />;
}

export default function DriveCloudView({ onHome }: { onHome: () => void }) {
  return (
    <DriveProvider>
      <Shell onHome={onHome} />
    </DriveProvider>
  );
}
