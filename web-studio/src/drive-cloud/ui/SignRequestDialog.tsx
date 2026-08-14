/**
 * Demande de signature par lien (Approche A, émetteur). Crée un lien scellé
 * « can_sign » pour un `.elium` du Drive et affiche l'URL à transmettre + le
 * suivi des parties (poll). La crypto est dans ops.ts ; le secret de
 * déchiffrement reste dans le fragment `#` (jamais envoyé au serveur).
 */
import { useCallback, useEffect, useState } from "react";
import { X, PenLine, Copy, CheckCircle2, Clock } from "lucide-react";
import { useDrive } from "../session";
import { createSignLinkForNode, type DriveEntry, type OpsCtx } from "../ops";
import type { SignRequestDto } from "../api";
import { fingerprintWords } from "../../sign/safety-words";

export default function SignRequestDialog({ ctx, entry, onClose }: { ctx: OpsCtx; entry: DriveEntry; onClose: () => void }) {
  const d = useDrive();
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState(""); // "" | "7" | "30" (jours)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [requests, setRequests] = useState<SignRequestDto[] | null>(null);

  // Un lien de signature n'a pas besoin d'un rôle privilégié (l'accès est scellé
  // par le token) : on attache le rôle de lecture le moins permissif disponible.
  const roleId = d.roleIdByKey["viewer"] ?? d.roleIdByKey["editor"] ?? d.roles[0]?.id ?? "";

  const loadStatus = useCallback(async () => {
    try {
      const res = await ctx.api.getSignRequests(entry.id);
      setRequests(res.requests);
    } catch {
      /* best effort — le suivi n'est pas bloquant */
    }
  }, [ctx, entry.id]);

  useEffect(() => {
    void loadStatus();
    // Rafraîchit tant que des parties sont en attente (poll léger).
    const t = setInterval(() => void loadStatus(), 8000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const createLink = async () => {
    setErr(null);
    setBusy(true);
    try {
      const opts: { label?: string; expiresAt?: string } = {};
      if (label.trim()) opts.label = label.trim();
      if (expiry) opts.expiresAt = new Date(Date.now() + Number(expiry) * 86400_000).toISOString();
      const { token, secret, publicHex } = await createSignLinkForNode(ctx, entry, roleId, opts);
      setLinkUrl(`${location.origin}/?sign=${token}#k=${secret}.${publicHex}`);
      await loadStatus();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Création de la demande impossible.");
    } finally {
      setBusy(false);
    }
  };

  const copy = (t: string) => {
    void navigator.clipboard?.writeText(t);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="dc-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dc-modal" role="dialog" aria-modal="true">
        <header className="dc-modal__head">
          <h2><PenLine size={18} /> Demander une signature — « {entry.name} »</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </header>

        <p className="muted">
          Générez un lien : le destinataire signe en ligne <strong>sans compte</strong>, et le document signé
          revient automatiquement ici. Le secret de déchiffrement reste dans le fragment <code>#</code> du lien.
        </p>

        <div className="dc-share-link">
          <div className="dc-share-link__row">
            <label className="dc-share-link__field">
              <span>Libellé du signataire (optionnel)</span>
              <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ex. Direction" />
            </label>
            <label className="dc-share-link__field">
              <span>Expiration</span>
              <select className="tool-select" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                <option value="">Jamais</option>
                <option value="7">7 jours</option>
                <option value="30">30 jours</option>
              </select>
            </label>
            <button className="eb eb--sm eb--outline dc-share-link__create" disabled={busy} onClick={() => void createLink()}>
              <PenLine size={14} /> {busy ? "Création…" : "Créer le lien"}
            </button>
          </div>
          {err && <p className="dc-error">{err}</p>}
          {linkUrl && (
            <div className="dc-share-link__out">
              <input className="input" readOnly value={linkUrl} onFocus={(e) => e.currentTarget.select()} />
              <button className="icon-btn" title="Copier" onClick={() => copy(linkUrl)}><Copy size={15} /></button>
            </div>
          )}
          <p className="muted dc-share-link__note">
            Transmettez ce lien au signataire. Le secret de déchiffrement reste dans le fragment <code>#</code> — le serveur ne le voit jamais.{copied ? " Lien copié !" : ""}
          </p>
        </div>

        {requests && requests.length > 0 && (
          <div className="dc-sign-status">
            <h3>Suivi</h3>
            {requests.map((r) => (
              <div key={r.id} className="dc-sign-req">
                {r.parties.map((p) => (
                  <div key={p.id} className="dc-sign-party">
                    {p.status === "signed"
                      ? <CheckCircle2 size={15} className="dc-sign-ok" />
                      : <Clock size={15} className="dc-sign-wait" />}
                    <span className="dc-sign-party__label">{p.label || `Signataire ${p.index + 1}`}</span>
                    <span className="dc-sign-party__state">
                      {p.status === "signed"
                        ? <>signé{p.signerFpr ? ` · ${fingerprintWords(p.signerFpr)}` : ""}</>
                        : "en attente"}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            <p className="muted" style={{ fontSize: 12 }}>Le document signé remplace la version courante du fichier dans le Drive. Ouvrez-le pour vérifier la signature.</p>
          </div>
        )}
      </div>
    </div>
  );
}
