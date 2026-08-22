/**
 * Demande de signature par lien (Approche A, émetteur). Sur un `.elium` du Drive,
 * crée un circuit à 1..N signataires : chaque partie reçoit son propre lien scellé
 * « can_sign » (`?sign=<token>#k=priv.pub`), à transmettre hors bande. Option
 * « signer dans l'ordre ». La crypto est dans ops.ts ; le secret de déchiffrement
 * reste dans le fragment `#` (jamais envoyé au serveur). Suivi en temps réel via
 * la WS d'événements d'organisation (+ poll de secours espacé).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X, PenLine, Copy, CheckCircle2, Clock, Plus, Trash2, ListOrdered, XCircle } from "lucide-react";
import { useDrive } from "../session";
import { createSignRequestForNode, type DriveEntry, type OpsCtx, type SignPartyLink } from "../ops";
import type { SignRequestDto } from "../api";
import { fingerprintWords } from "../../sign/safety-words";

export default function SignRequestDialog({
  ctx,
  entry,
  onClose,
}: {
  ctx: OpsCtx;
  entry: DriveEntry;
  onClose: () => void;
}) {
  const d = useDrive();
  const [parties, setParties] = useState<{ label: string }[]>([{ label: "" }]);
  const [ordered, setOrdered] = useState(false);
  const [expiry, setExpiry] = useState(""); // "" | "7" | "30" (jours)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [links, setLinks] = useState<SignPartyLink[] | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
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

  // `loadStatus` change à chaque changement de `ctx`/`entry.id` (en pratique
  // jamais pendant la vie de cette boîte de dialogue) ; on le garde dans une
  // ref pour que l'abonnement WS ci-dessous n'ait pas à se reconnecter.
  const loadStatusRef = useRef(loadStatus);
  loadStatusRef.current = loadStatus;

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Actualisation INSTANTANÉE via WebSocket : le serveur pousse un ping
  // « nodes-changed » (sans contenu) sur CHAQUE signature/refus (voir
  // server/src/routes/signing.ts → notifyOrg), donc on relit le statut dès
  // réception au lieu d'attendre le prochain tick de poll. Reconnexion
  // automatique. Un poll de SECOURS très espacé couvre les coupures WS
  // (proxys, veille, WS bloqué par un pare-feu) — même logique que
  // DriveBrowser.tsx.
  useEffect(() => {
    const orgId = ctx.orgId;
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnect: number | undefined;
    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(ctx.api.orgEventsSocketUrl(orgId));
      } catch {
        reconnect = window.setTimeout(connect, 4000);
        return;
      }
      ws.onmessage = (ev) => {
        try {
          if ((JSON.parse(String(ev.data)) as { type?: string }).type === "nodes-changed") {
            void loadStatusRef.current();
          }
        } catch {
          /* ping non-JSON ignoré */
        }
      };
      ws.onclose = () => {
        if (!closed) {
          window.clearTimeout(reconnect);
          reconnect = window.setTimeout(connect, 4000);
        }
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };
    connect();
    // Filet de sécurité : poll rare (60 s), au cas où la connexion WS resterait
    // coupée (bien plus espacé que l'ancien poll à 8 s, la WS couvrant déjà le
    // cas nominal).
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadStatusRef.current();
    }, 60000);
    return () => {
      closed = true;
      window.clearTimeout(reconnect);
      window.clearInterval(poll);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, [ctx.orgId, ctx.api]);

  const setLabel = (i: number, label: string) => setParties((ps) => ps.map((p, j) => (j === i ? { label } : p)));
  const addParty = () => setParties((ps) => (ps.length < 50 ? [...ps, { label: "" }] : ps));
  const removeParty = (i: number) => setParties((ps) => (ps.length > 1 ? ps.filter((_, j) => j !== i) : ps));

  const urlFor = (l: SignPartyLink) => `${location.origin}/?sign=${l.token}#k=${l.secret}.${l.publicHex}`;

  const createLinks = async () => {
    setErr(null);
    setBusy(true);
    try {
      const opts: { ordered?: boolean; expiresAt?: string } = { ordered };
      if (expiry) opts.expiresAt = new Date(Date.now() + Number(expiry) * 86400_000).toISOString();
      const clean = parties.map((p) => ({ label: p.label.trim() || undefined }));
      const { parties: created } = await createSignRequestForNode(ctx, entry, roleId, clean, opts);
      setLinks(created);
      await loadStatus();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Création de la demande impossible.");
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string, idx: number) => {
    void navigator.clipboard?.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1800);
  };

  return (
    <div
      className="dc-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dc-modal" role="dialog" aria-modal="true">
        <header className="dc-modal__head">
          <h2>
            <PenLine size={18} /> Demander une signature — « {entry.name} »
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer">
            <X size={18} />
          </button>
        </header>

        <p className="muted">
          Chaque signataire reçoit un lien : il signe en ligne <strong>sans compte</strong>, et le document signé
          revient automatiquement ici. Le secret de déchiffrement reste dans le fragment <code>#</code> du lien.
        </p>

        {!links && (
          <div className="dc-share-link">
            <h3 className="dc-share-list__title">
              <PenLine size={15} /> Signataires
            </h3>
            {parties.map((p, i) => (
              <div key={i} className="dc-sign-partyrow">
                <span className="dc-sign-partyrow__n">{i + 1}</span>
                <input
                  className="input"
                  value={p.label}
                  onChange={(e) => setLabel(i, e.target.value)}
                  placeholder={`Libellé du signataire ${i + 1} (optionnel)`}
                />
                {parties.length > 1 && (
                  <button className="icon-btn" title="Retirer" onClick={() => removeParty(i)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
            <div className="dc-sign-controls">
              <button className="eb eb--sm eb--outline" onClick={addParty} disabled={parties.length >= 50}>
                <Plus size={14} /> Ajouter un signataire
              </button>
              <label className="dc-sign-check" title="Chaque signataire ne peut signer qu'après le précédent">
                <input type="checkbox" checked={ordered} onChange={(e) => setOrdered(e.target.checked)} />
                <ListOrdered size={14} /> Signer dans l'ordre
              </label>
              <label className="dc-share-link__field">
                <span>Expiration</span>
                <select className="tool-select" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  <option value="">Jamais</option>
                  <option value="7">7 jours</option>
                  <option value="30">30 jours</option>
                </select>
              </label>
            </div>
            {err && <p className="dc-error">{err}</p>}
            <button className="eb eb--primary" disabled={busy} onClick={() => void createLinks()}>
              <PenLine size={14} />{" "}
              {busy ? "Création…" : `Créer ${parties.length > 1 ? parties.length + " liens" : "le lien"}`}
            </button>
          </div>
        )}

        {links && (
          <div className="dc-share-link">
            <h3 className="dc-share-list__title">
              <CheckCircle2 size={15} /> Liens à transmettre{ordered ? " (à envoyer dans l'ordre)" : ""}
            </h3>
            {links.map((l) => (
              <div key={l.index} className="dc-sign-linkrow">
                <span className="dc-sign-partyrow__n">{l.index + 1}</span>
                <span className="dc-sign-linkrow__label">{l.label || `Signataire ${l.index + 1}`}</span>
                <div className="dc-share-link__out">
                  <input className="input" readOnly value={urlFor(l)} onFocus={(e) => e.currentTarget.select()} />
                  <button className="icon-btn" title="Copier" onClick={() => copy(urlFor(l), l.index)}>
                    {copiedIdx === l.index ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                  </button>
                </div>
              </div>
            ))}
            <p className="muted dc-share-link__note">
              Transmettez chaque lien au signataire concerné. Le serveur ne voit jamais le secret.
            </p>
          </div>
        )}

        {requests && requests.length > 0 && (
          <div className="dc-sign-status">
            <h3>Suivi</h3>
            {requests.map((r) => (
              <div key={r.id} className="dc-sign-req">
                {r.ordered && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    <ListOrdered size={12} /> Signature dans l'ordre
                  </span>
                )}
                {r.parties.map((p) => (
                  <div key={p.id} className="dc-sign-party">
                    {p.status === "signed" ? (
                      <CheckCircle2 size={15} className="dc-sign-ok" />
                    ) : p.status === "declined" ? (
                      <XCircle size={15} className="dc-sign-no" />
                    ) : (
                      <Clock size={15} className="dc-sign-wait" />
                    )}
                    <span className="dc-sign-party__label">{p.label || `Signataire ${p.index + 1}`}</span>
                    <span className="dc-sign-party__state">
                      {p.status === "signed" ? (
                        <>signé{p.signerFpr ? ` · ${fingerprintWords(p.signerFpr)}` : ""}</>
                      ) : p.status === "declined" ? (
                        "refusé"
                      ) : (
                        "en attente"
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            <p className="muted" style={{ fontSize: 12 }}>
              Le document signé remplace la version courante du fichier dans le Drive. Ouvrez-le pour vérifier les
              signatures.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
