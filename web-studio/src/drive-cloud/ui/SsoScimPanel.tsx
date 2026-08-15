/**
 * Identity-provider administration: SSO (OIDC) configuration and SCIM
 * provisioning token. Both are org-level settings the server already enforces
 * zero-knowledge — SSO federates *identity* only (never the content keys), and
 * SCIM (de)provisions members. This is the missing admin UI on top of the
 * existing SDK (`setOrgSso` / `disableOrgSso` / `createScimToken`).
 */
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Copy, Check, Trash2, ShieldCheck, RefreshCw } from "lucide-react";
import { useDrive } from "../session";

/** Accept a raw JWKS array or a `{ keys: [...] }` object; throw on anything else. */
function parseJwks(text: string): unknown[] {
  const j = JSON.parse(text);
  const keys = Array.isArray(j) ? j : (j as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("empty");
  return keys;
}

export default function SsoScimPanel() {
  const d = useDrive();
  const orgId = d.currentOrg?.id ?? "";

  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [jwks, setJwks] = useState("");
  const [jwksUri, setJwksUri] = useState("");
  const [domains, setDomains] = useState("");
  const [roleOptions, setRoleOptions] = useState<{ key: string; name: string }[]>([]);
  const [defaultRoleKey, setDefaultRoleKey] = useState("editor");
  const [groupMap, setGroupMap] = useState<{ group: string; roleKey: string }[]>([]);
  const [configured, setConfigured] = useState(false);
  const [scimToken, setScimToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<"scim" | "url" | null>(null);

  const scimUrl = `${d.api.serverUrl}/scim/v2`;

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const { sso } = await d.api.getOrgSso(orgId);
      setConfigured(!!sso);
      if (sso && typeof sso === "object") {
        const s = sso as { issuer?: string; clientId?: string; jwksUri?: string; allowedDomains?: string[] };
        setIssuer(s.issuer ?? "");
        setClientId(s.clientId ?? "");
        setJwksUri(s.jwksUri ?? "");
        setDomains((s.allowedDomains ?? []).join(", "));
      }
    } catch {
      /* not configured yet, or insufficient permission — leave the form empty */
    }
    try {
      const { roles } = await d.api.listRoles(orgId);
      setRoleOptions((roles as { key: string; name: string }[]).map((r) => ({ key: r.key, name: r.name })));
    } catch {
      /* insufficient permission — leave role options empty */
    }
    try {
      const cfg = await d.api.getOrgScimConfig(orgId);
      setDefaultRoleKey(cfg.defaultRoleKey ?? "editor");
      setGroupMap(Object.entries(cfg.groupRoleMap ?? {}).map(([group, roleKey]) => ({ group, roleKey })));
    } catch {
      /* not configured yet, or insufficient permission */
    }
  }, [orgId, d.api]);
  useEffect(() => {
    void load();
  }, [load]);

  const saveScimConfig = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const groupRoleMap: Record<string, string> = {};
      for (const row of groupMap) {
        const g = row.group.trim();
        if (g && row.roleKey) groupRoleMap[g] = row.roleKey;
      }
      await d.api.setOrgScimConfig(orgId, { defaultRoleKey, groupRoleMap });
      setMsg("Configuration de provisioning SCIM enregistrée.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Échec de l'enregistrement de la configuration SCIM.");
    } finally {
      setBusy(false);
    }
  };

  const saveSso = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    const uri = jwksUri.trim();
    let keys: unknown[] = [];
    if (jwks.trim()) {
      try {
        keys = parseJwks(jwks);
      } catch {
        setErr(
          "JWKS statique invalide : collez un objet { keys: […] } ou un tableau de clés — ou laissez vide et renseignez le jwks_uri.",
        );
        return;
      }
    }
    if (!uri && keys.length === 0) {
      setErr("Renseignez le jwks_uri de votre fournisseur (recommandé) ou collez un JWKS statique.");
      return;
    }
    setBusy(true);
    try {
      const allowedDomains = domains
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await d.api.setOrgSso(orgId, {
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        ...(uri ? { jwksUri: uri } : {}),
        ...(keys.length ? { jwks: keys } : {}),
        allowedDomains,
      });
      setConfigured(true);
      setMsg("Configuration SSO enregistrée.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Échec de l'enregistrement de la configuration SSO.");
    } finally {
      setBusy(false);
    }
  };

  const disableSso = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await d.api.disableOrgSso(orgId);
      setConfigured(false);
      setIssuer("");
      setClientId("");
      setJwks("");
      setJwksUri("");
      setDomains("");
      setMsg("SSO désactivé.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Échec de la désactivation du SSO.");
    } finally {
      setBusy(false);
    }
  };

  const genScim = async () => {
    setErr(null);
    setBusy(true);
    try {
      const { token } = await d.api.createScimToken(orgId);
      setScimToken(token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Échec de la génération du jeton SCIM.");
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string, which: "scim" | "url") => {
    void navigator.clipboard?.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="dc-sso">
      {err && (
        <div className="dc-error" role="alert">
          {err}
        </div>
      )}
      {msg && <div className="dc-sso__ok">{msg}</div>}

      <section className="dc-sso__card">
        <h2 className="dc-sso__title">
          <ShieldCheck size={18} /> Authentification unique (SSO — OIDC)
          {configured && <span className="badge badge--success">Actif</span>}
        </h2>
        <p className="muted">
          Fédère l'<strong>identité</strong> via votre fournisseur (Okta, Entra ID, Google…). Le SSO ne touche jamais
          aux clés de chiffrement : le Drive reste zéro-connaissance.
        </p>
        <form className="dc-sso__form" onSubmit={saveSso}>
          <label className="field">
            <span className="field__label">Issuer (URL de l'émetteur)</span>
            <input
              className="input"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="https://exemple.okta.com"
              required
            />
          </label>
          <label className="field">
            <span className="field__label">Client ID</span>
            <input
              className="input"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="0oa…"
              required
            />
          </label>
          <label className="field">
            <span className="field__label">URL du jwks_uri (recommandé)</span>
            <input
              className="input"
              value={jwksUri}
              onChange={(e) => setJwksUri(e.target.value)}
              placeholder="https://exemple.okta.com/oauth2/v1/keys"
            />
          </label>
          <p className="muted" style={{ marginTop: -4 }}>
            Les clés de signature sont récupérées dynamiquement et mises en cache ; la rotation de clés du fournisseur
            est prise en compte automatiquement. À défaut, collez un JWKS statique ci-dessous.
          </p>
          <label className="field">
            <span className="field__label">JWKS statique (optionnel — repli)</span>
            <textarea
              className="input"
              value={jwks}
              onChange={(e) => setJwks(e.target.value)}
              rows={4}
              placeholder='{ "keys": [ … ] }'
            />
          </label>
          <label className="field">
            <span className="field__label">Domaines autorisés (optionnel)</span>
            <input
              className="input"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="exemple.fr, filiale.fr"
            />
          </label>
          <div className="dc-sso__actions">
            <button type="submit" className="eb eb--primary eb--sm" disabled={busy}>
              Enregistrer le SSO
            </button>
            {configured && (
              <button type="button" className="eb eb--outline eb--sm" disabled={busy} onClick={disableSso}>
                <Trash2 size={14} /> Désactiver
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="dc-sso__card">
        <h2 className="dc-sso__title">
          <KeyRound size={18} /> Provisioning SCIM
        </h2>
        <p className="muted">
          Générez un jeton pour que votre fournisseur d'identité crée et désactive automatiquement les comptes
          (provisioning / déprovisioning). Le jeton n'est affiché qu'une fois.
        </p>
        <label className="field">
          <span className="field__label">Endpoint SCIM 2.0</span>
          <span className="dc-sso__copyrow">
            <code className="dc-sso__code">{scimUrl}</code>
            <button type="button" className="icon-btn" title="Copier l'URL" onClick={() => copy(scimUrl, "url")}>
              {copied === "url" ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </span>
        </label>
        {scimToken && (
          <label className="field">
            <span className="field__label">Jeton SCIM (bearer) — copiez-le maintenant</span>
            <span className="dc-sso__copyrow">
              <code className="dc-sso__code dc-sso__code--secret">{scimToken}</code>
              <button
                type="button"
                className="icon-btn"
                title="Copier le jeton"
                onClick={() => copy(scimToken, "scim")}
              >
                {copied === "scim" ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </span>
          </label>
        )}
        <div className="dc-sso__actions">
          <button type="button" className="eb eb--primary eb--sm" disabled={busy} onClick={genScim}>
            <RefreshCw size={14} /> {scimToken ? "Régénérer un jeton" : "Générer un jeton SCIM"}
          </button>
        </div>
      </section>

      <section className="dc-sso__card">
        <h2 className="dc-sso__title">
          <KeyRound size={18} /> Rôles de provisioning SCIM
        </h2>
        <p className="muted">
          Rôle attribué par défaut aux membres provisionnés, et correspondance entre les groupes de votre annuaire (SCIM
          /Groups) et les rôles Elium. Un membre d'un groupe mappé reçoit le rôle mappé le plus privilégié. Les groupes
          SCIM sont des métadonnées de provisioning, pas des équipes chiffrées.
        </p>
        <label className="field">
          <span className="field__label">Rôle par défaut</span>
          <select className="input" value={defaultRoleKey} onChange={(e) => setDefaultRoleKey(e.target.value)}>
            {roleOptions.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="field__label">Correspondance groupe → rôle</span>
          {groupMap.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <input
                className="input"
                placeholder="Nom du groupe (annuaire)"
                value={row.group}
                onChange={(e) => setGroupMap((m) => m.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)))}
              />
              <select
                className="input"
                value={row.roleKey}
                onChange={(e) => setGroupMap((m) => m.map((x, j) => (j === i ? { ...x, roleKey: e.target.value } : x)))}
              >
                {roleOptions.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="icon-btn"
                title="Retirer"
                onClick={() => setGroupMap((m) => m.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="eb eb--outline eb--sm"
            onClick={() => setGroupMap((m) => [...m, { group: "", roleKey: defaultRoleKey }])}
          >
            + Ajouter une correspondance
          </button>
        </div>
        <div className="dc-sso__actions">
          <button type="button" className="eb eb--primary eb--sm" disabled={busy} onClick={saveScimConfig}>
            Enregistrer les rôles
          </button>
        </div>
      </section>
    </div>
  );
}
