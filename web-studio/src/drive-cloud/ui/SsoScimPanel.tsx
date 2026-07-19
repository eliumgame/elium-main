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
  const [domains, setDomains] = useState("");
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
        const s = sso as { issuer?: string; clientId?: string; allowedDomains?: string[] };
        setIssuer(s.issuer ?? "");
        setClientId(s.clientId ?? "");
        setDomains((s.allowedDomains ?? []).join(", "));
      }
    } catch {
      /* not configured yet, or insufficient permission — leave the form empty */
    }
  }, [orgId, d.api]);
  useEffect(() => { void load(); }, [load]);

  const saveSso = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setMsg(null);
    let keys: unknown[];
    try {
      keys = parseJwks(jwks);
    } catch {
      setErr("JWKS invalide : collez le JSON du endpoint jwks_uri de votre fournisseur (un objet { keys: […] } ou un tableau de clés).");
      return;
    }
    setBusy(true);
    try {
      const allowedDomains = domains.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      await d.api.setOrgSso(orgId, { issuer: issuer.trim(), clientId: clientId.trim(), jwks: keys, allowedDomains });
      setConfigured(true);
      setMsg("Configuration SSO enregistrée.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Échec de l'enregistrement de la configuration SSO.");
    } finally {
      setBusy(false);
    }
  };

  const disableSso = async () => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      await d.api.disableOrgSso(orgId);
      setConfigured(false);
      setIssuer(""); setClientId(""); setJwks(""); setDomains("");
      setMsg("SSO désactivé.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Échec de la désactivation du SSO.");
    } finally {
      setBusy(false);
    }
  };

  const genScim = async () => {
    setErr(null); setBusy(true);
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
      {err && <div className="dc-error" role="alert">{err}</div>}
      {msg && <div className="dc-sso__ok">{msg}</div>}

      <section className="dc-sso__card">
        <h2 className="dc-sso__title">
          <ShieldCheck size={18} /> Authentification unique (SSO — OIDC)
          {configured && <span className="badge badge--success">Actif</span>}
        </h2>
        <p className="muted">
          Fédère l'<strong>identité</strong> via votre fournisseur (Okta, Entra ID, Google…). Le SSO ne touche
          jamais aux clés de chiffrement : le Drive reste zéro-connaissance.
        </p>
        <form className="dc-sso__form" onSubmit={saveSso}>
          <label className="field"><span className="field__label">Issuer (URL de l'émetteur)</span>
            <input className="input" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://exemple.okta.com" required /></label>
          <label className="field"><span className="field__label">Client ID</span>
            <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="0oa…" required /></label>
          <label className="field"><span className="field__label">JWKS (contenu du jwks_uri)</span>
            <textarea className="input" value={jwks} onChange={(e) => setJwks(e.target.value)} rows={4} placeholder='{ "keys": [ … ] }' required /></label>
          <label className="field"><span className="field__label">Domaines autorisés (optionnel)</span>
            <input className="input" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="exemple.fr, filiale.fr" /></label>
          <div className="dc-sso__actions">
            <button type="submit" className="eb eb--primary eb--sm" disabled={busy}>Enregistrer le SSO</button>
            {configured && (
              <button type="button" className="eb eb--outline eb--sm" disabled={busy} onClick={disableSso}><Trash2 size={14} /> Désactiver</button>
            )}
          </div>
        </form>
      </section>

      <section className="dc-sso__card">
        <h2 className="dc-sso__title"><KeyRound size={18} /> Provisioning SCIM</h2>
        <p className="muted">
          Générez un jeton pour que votre fournisseur d'identité crée et désactive automatiquement les
          comptes (provisioning / déprovisioning). Le jeton n'est affiché qu'une fois.
        </p>
        <label className="field"><span className="field__label">Endpoint SCIM 2.0</span>
          <span className="dc-sso__copyrow">
            <code className="dc-sso__code">{scimUrl}</code>
            <button type="button" className="icon-btn" title="Copier l'URL" onClick={() => copy(scimUrl, "url")}>{copied === "url" ? <Check size={14} /> : <Copy size={14} />}</button>
          </span>
        </label>
        {scimToken && (
          <label className="field"><span className="field__label">Jeton SCIM (bearer) — copiez-le maintenant</span>
            <span className="dc-sso__copyrow">
              <code className="dc-sso__code dc-sso__code--secret">{scimToken}</code>
              <button type="button" className="icon-btn" title="Copier le jeton" onClick={() => copy(scimToken, "scim")}>{copied === "scim" ? <Check size={14} /> : <Copy size={14} />}</button>
            </span>
          </label>
        )}
        <div className="dc-sso__actions">
          <button type="button" className="eb eb--primary eb--sm" disabled={busy} onClick={genScim}>
            <RefreshCw size={14} /> {scimToken ? "Régénérer un jeton" : "Générer un jeton SCIM"}
          </button>
        </div>
      </section>
    </div>
  );
}
