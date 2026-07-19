/**
 * Enterprise recovery — the interactive UI on top of the org recovery key.
 *
 * Two capabilities, both gated server-side by `recovery.perform`:
 *  1. Recovery admins — see who holds the org private key and promote another
 *     member to a recovery admin (re-wraps the org key to them, client-side).
 *  2. Restore access — browse the org tree (names decrypted locally with the org
 *     key) and re-grant a chosen member cryptographic access to a node.
 *
 * The org private key is only ever unwrapped transiently inside the recovery.ts
 * helpers (memory-hygiene there); this component just orchestrates and never
 * holds the key in state.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { LifeBuoy, ShieldAlert, UserCog, KeyRound, FolderTree, Folder, FileText, Check, RotateCcw, Search } from "lucide-react";
import { useDrive } from "../session";
import { useDialogs } from "../../ui/dialogs";
import { ApiError } from "../api";
import { promoteRecoveryAdmin, restoreNodeAccess, decryptRecoveryNodeNames, type RecoveryContext } from "../recovery";
import type { RecoveryAdmin, RecoveryNode } from "../types";

interface Member {
  userId: string;
  email: string;
  displayName: string;
  p256PublicHex: string;
  roleKey: string;
}

/** A recovery node once its name has been decrypted with the org key. */
type DecryptedNode = RecoveryNode & { name: string };

export default function RecoveryPanel() {
  const d = useDrive();
  const dialogs = useDialogs();
  const orgId = d.currentOrg?.id ?? "";

  const [admins, setAdmins] = useState<RecoveryAdmin[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [promoteId, setPromoteId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  // Restore-access state.
  const [nodes, setNodes] = useState<DecryptedNode[] | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedNode, setSelectedNode] = useState<string>("");
  const [targetUser, setTargetUser] = useState("");
  const [grantRole, setGrantRole] = useState("");

  const ctx = useMemo<RecoveryContext | null>(() => {
    if (!orgId || !d.keys || !d.currentOrg?.orgPublicHex) return null;
    return { api: d.api, orgId, orgPublicHex: d.currentOrg.orgPublicHex, adminKeys: d.keys.recipient };
  }, [orgId, d.api, d.keys, d.currentOrg?.orgPublicHex]);

  const adminIds = useMemo(() => new Set(admins.map((a) => a.userId)), [admins]);
  const defaultRole = d.roleIdByKey["editor"] ?? d.roles.find((r) => r.key !== "guest")?.id ?? "";

  const reload = useCallback(async () => {
    if (!orgId) return;
    setErr(null);
    try {
      const [{ admins: a }, { members: m }] = await Promise.all([d.api.listRecoveryAdmins(orgId), d.api.listMembers(orgId)]);
      setAdmins(a ?? []);
      setMembers((m as Member[]) ?? []);
      setDenied(false);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setDenied(true);
      else setErr(e instanceof Error ? e.message : "Chargement impossible.");
    }
  }, [d.api, orgId]);

  useEffect(() => {
    setGrantRole(defaultRole);
    void reload();
  }, [reload, defaultRole]);

  const promotable = members.filter((m) => !adminIds.has(m.userId));

  const promote = async () => {
    if (!ctx || !promoteId) return;
    const m = members.find((x) => x.userId === promoteId);
    if (!m) return;
    if (
      !(await dialogs.confirm({
        title: "Promouvoir un administrateur de recouvrement",
        message: `Donner à ${m.displayName || m.email} le pouvoir de recouvrer les fichiers de l'organisation ? La clé privée d'organisation lui sera ré-emballée. À n'accorder qu'à une personne de confiance.`,
        confirmLabel: "Promouvoir",
      }))
    )
      return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await promoteRecoveryAdmin(ctx, { userId: m.userId, publicHex: m.p256PublicHex });
      setMsg(`${m.displayName || m.email} peut désormais recouvrer les fichiers.`);
      setPromoteId("");
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Promotion impossible.");
    } finally {
      setBusy(false);
    }
  };

  const loadTree = async () => {
    if (!ctx) return;
    setLoadingTree(true);
    setErr(null);
    try {
      const { nodes: raw } = await d.api.listRecoveryNodes(orgId);
      const live = raw.filter((n) => !n.trashed);
      const names = await decryptRecoveryNodeNames(ctx, live);
      setNodes(live.map((n) => ({ ...n, name: names.get(n.id) || "(nom indéchiffrable)" })));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chargement de l'arborescence impossible.");
    } finally {
      setLoadingTree(false);
    }
  };

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes ?? []) m.set(n.id, n.name);
    return m;
  }, [nodes]);

  const shownNodes = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = nodes ?? [];
    if (!f) return list;
    return list.filter((n) => n.name.toLowerCase().includes(f));
  }, [nodes, filter]);

  const restore = async () => {
    if (!ctx || !selectedNode || !targetUser || !grantRole) return;
    const node = nodes?.find((n) => n.id === selectedNode);
    const m = members.find((x) => x.userId === targetUser);
    if (!node || !m) return;
    if (
      !(await dialogs.confirm({
        title: "Restaurer l'accès",
        message: `Restaurer l'accès à « ${node.name} » pour ${m.displayName || m.email} ? Sa clé de contenu sera ré-emballée vers cette personne via la clé d'organisation.`,
        confirmLabel: "Restaurer l'accès",
      }))
    )
      return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await restoreNodeAccess(ctx, {
        nodeId: node.id,
        orgWrappedKey: node.orgWrappedKey,
        targetUserId: m.userId,
        targetPublicHex: m.p256PublicHex,
        roleId: grantRole,
      });
      setMsg(`Accès à « ${node.name} » restauré pour ${m.displayName || m.email}.`);
      setSelectedNode("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Restauration impossible.");
    } finally {
      setBusy(false);
    }
  };

  if (denied) {
    return (
      <div className="dc-empty-list">
        <LifeBuoy size={30} />
        <p>Le recouvrement d'organisation est réservé aux administrateurs disposant de la permission « Recouvrer les fichiers ».</p>
      </div>
    );
  }

  return (
    <div className="dc-sso">
      {err && <div className="dc-error" role="alert">{err}</div>}
      {msg && <div className="dc-sso__ok">{msg}</div>}

      <div className="dc-rec__warn">
        <ShieldAlert size={18} />
        <p>
          La <strong>clé de recouvrement d'organisation</strong> peut déchiffrer n'importe quel fichier de l'org. Elle
          n'est jamais détenue par le serveur : elle est emballée vers chaque administrateur de recouvrement et
          déballée dans votre navigateur, le temps de l'opération, puis effacée. N'accordez ce pouvoir qu'à des
          personnes de confiance.
        </p>
      </div>

      {/* --- Recovery admins ------------------------------------------------ */}
      <section className="dc-sso__card">
        <h2 className="dc-sso__title"><UserCog size={18} /> Administrateurs de recouvrement</h2>
        <p className="muted">Les personnes qui peuvent recouvrer les fichiers (elles détiennent une copie emballée de la clé privée d'org).</p>

        <table className="dc-table">
          <thead><tr><th>Administrateur</th><th className="dc-table__actions">Depuis</th></tr></thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.userId} className="dc-row">
                <td className="dc-row__name">
                  <span className="dc-avatar">{(a.displayName || a.email).slice(0, 1).toUpperCase()}</span>
                  <span><b>{a.displayName || "—"}</b><br /><span className="dc-row__muted">{a.email}</span></span>
                </td>
                <td className="dc-row__muted">{a.since ? new Date(a.since).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
            {admins.length === 0 && <tr><td colSpan={2} className="dc-row__muted">Aucun administrateur de recouvrement.</td></tr>}
          </tbody>
        </table>

        <div className="dc-rec__promote">
          <KeyRound size={16} className="dc-invite__ic" />
          <select className="tool-select" value={promoteId} onChange={(e) => setPromoteId(e.target.value)}>
            <option value="">Promouvoir un membre…</option>
            {promotable.map((m) => <option key={m.userId} value={m.userId}>{m.displayName || m.email}</option>)}
          </select>
          <button className="eb eb--sm eb--primary" disabled={busy || !promoteId || !ctx} onClick={() => void promote()}>
            <Check size={14} /> Promouvoir
          </button>
        </div>
      </section>

      {/* --- Restore access ------------------------------------------------- */}
      <section className="dc-sso__card">
        <h2 className="dc-sso__title"><FolderTree size={18} /> Restaurer l'accès à un fichier</h2>
        <p className="muted">
          Rendez à un membre l'accès chiffré à un fichier ou dossier — par exemple après un départ, une révocation ou
          la perte d'un partage — sans dépendre de la personne qui l'avait partagé.
        </p>

        {nodes === null ? (
          <button className="eb eb--sm eb--outline" disabled={loadingTree || !ctx} onClick={() => void loadTree()}>
            <FolderTree size={14} /> {loadingTree ? "Déchiffrement…" : "Charger l'arborescence (déchiffre les noms avec la clé d'org)"}
          </button>
        ) : (
          <>
            <div className="dc-rec__search">
              <Search size={15} />
              <input className="input" placeholder="Filtrer par nom…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <button className="icon-btn" title="Recharger" onClick={() => void loadTree()} disabled={loadingTree}><RotateCcw size={15} /></button>
            </div>
            <div className="dc-rec__tree">
              {shownNodes.map((n) => (
                <button
                  key={n.id}
                  className={`dc-rec__node ${selectedNode === n.id ? "is-active" : ""}`}
                  onClick={() => setSelectedNode(n.id)}
                >
                  {n.kind === "folder" ? <Folder size={15} /> : <FileText size={15} />}
                  <span className="dc-rec__nodename">{n.name}</span>
                  {n.parentId && nameById.has(n.parentId) && <span className="dc-rec__path">dans {nameById.get(n.parentId)}</span>}
                </button>
              ))}
              {shownNodes.length === 0 && <p className="dc-row__muted" style={{ padding: "10px 12px" }}>Aucun nœud.</p>}
            </div>

            <div className="dc-rec__grant">
              <label className="field">
                <span className="field__label">Rendre l'accès à</span>
                <select className="tool-select" value={targetUser} onChange={(e) => setTargetUser(e.target.value)}>
                  <option value="">Choisir un membre…</option>
                  {members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName || m.email}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field__label">Avec le rôle</span>
                <select className="tool-select" value={grantRole} onChange={(e) => setGrantRole(e.target.value)}>
                  {d.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <button className="eb eb--sm eb--primary" disabled={busy || !selectedNode || !targetUser || !grantRole || !ctx} onClick={() => void restore()}>
                <LifeBuoy size={14} /> Restaurer l'accès
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
