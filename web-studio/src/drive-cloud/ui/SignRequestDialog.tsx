/**
 * Demande de signature par lien (Approche A, émetteur). Sur un `.elium` du Drive,
 * crée un circuit à 1..N signataires : chaque partie reçoit son propre lien scellé
 * « can_sign » (`?sign=<token>#k=priv.pub`), à transmettre hors bande. Option
 * « signer dans l'ordre ». La crypto est dans ops.ts ; le secret de déchiffrement
 * reste dans le fragment `#` (jamais envoyé au serveur). Suivi en temps réel via
 * la WS d'événements d'organisation (+ poll de secours espacé).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  PenLine,
  Copy,
  CheckCircle2,
  Clock,
  Plus,
  Trash2,
  ListOrdered,
  XCircle,
  Loader,
  RotateCcw,
  Ban,
} from "lucide-react";
import { useDrive } from "../session";
import { useDialogs } from "../../ui/dialogs";
import {
  createSignRequestForNode,
  loadEliumFile,
  syncCircuitForSignRequest,
  type DriveEntry,
  type OpsCtx,
  type SignPartyLink,
} from "../ops";
import type { SignRequestDto, SignParty } from "../api";
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
  const dialogs = useDialogs();
  const [parties, setParties] = useState<{ label: string }[]>([{ label: "" }]);
  const [ordered, setOrdered] = useState(false);
  const [expiry, setExpiry] = useState(""); // "" | "7" | "30" (jours)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [links, setLinks] = useState<SignPartyLink[] | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [requests, setRequests] = useState<SignRequestDto[] | null>(null);
  // Action en cours (Révoquer / Relancer) sur une partie précise du suivi —
  // désactive ses boutons le temps de l'appel, affiche un message de résultat.
  const [actingId, setActingId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // Le document a-t-il DÉJÀ un circuit de signature (Parapheur) ? Si oui, ses
  // parties (source de vérité — voir alignCircuitWithRequest) préremplissent la
  // liste ci-dessous en lecture seule : la demande DOIT en dériver, pas exister
  // comme une liste ad-hoc déconnectée. `circuitLoading` évite d'envoyer la
  // demande avant d'avoir eu la réponse (sans quoi on partirait sur la ligne
  // vide par défaut alors qu'un circuit existant allait arriver).
  const [circuitLoading, setCircuitLoading] = useState(true);
  const [hasExistingCircuit, setHasExistingCircuit] = useState(false);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCircuitLoading(true);
    (async () => {
      const loaded = await loadEliumFile(ctx, entry);
      if (cancelled) return;
      const existing = loaded?.file.parapheur?.parties;
      if (existing?.length) {
        setParties(existing.map((p) => ({ label: p.name })));
        setHasExistingCircuit(true);
      }
      setCircuitLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

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

  // `party=` correlate ce lien à son `ParapheurParty.id` dans le circuit
  // embarqué (voir alignCircuitWithRequest) : un simple UUID opaque déjà connu
  // du serveur (c'est son propre id de ligne), qui ne lui apprend rien de plus
  // sur le format .elium — la réconciliation reste entièrement côté client.
  const urlFor = (l: SignPartyLink) =>
    `${location.origin}/?sign=${l.token}&party=${l.partyId}#k=${l.secret}.${l.publicHex}`;

  const createLinks = async () => {
    setErr(null);
    setSyncWarning(null);
    setBusy(true);
    try {
      const opts: { ordered?: boolean; expiresAt?: string } = { ordered };
      if (expiry) opts.expiresAt = new Date(Date.now() + Number(expiry) * 86400_000).toISOString();
      const clean = parties.map((p) => ({ label: p.label.trim() || undefined }));
      const { parties: created } = await createSignRequestForNode(ctx, entry, roleId, clean, opts);
      setLinks(created);
      await loadStatus();
      // Bridge vers le circuit local (Parapheur) : le document EST la source de
      // vérité, donc on le relit à cet instant précis (pas le snapshot chargé à
      // l'ouverture de la boîte de dialogue, potentiellement périmé) avant de le
      // réécrire — best effort : la demande existe déjà côté serveur, un échec
      // ici ne doit pas donner l'impression que la demande entière a échoué.
      try {
        const fresh = await loadEliumFile(ctx, entry);
        if (fresh) await syncCircuitForSignRequest(ctx, entry, fresh, created);
      } catch (e) {
        setSyncWarning(
          "Le circuit du document (Parapheur) n'a pas pu être synchronisé : " +
            (e instanceof Error ? e.message : "erreur inconnue") +
            ". Les liens de signature fonctionnent malgré tout ; le suivi ci-dessous reste fiable.",
        );
      }
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

  // Révoque le lien d'UNE partie précise (pas toute la demande) — le serveur
  // marque aussi la partie « cancelled » dans le même mouvement (voir
  // DELETE /nodes/:id/links/:linkId côté serveur), donc plus besoin de relance.
  const revokeParty = async (p: SignParty) => {
    if (
      !(await dialogs.confirm({
        title: "Révoquer ce lien de signature",
        message: `Révoquer le lien de « ${p.label || `signataire ${p.index + 1}`} » ? Il ne pourra plus signer avec ce lien.`,
        danger: true,
        confirmLabel: "Révoquer",
      }))
    )
      return;
    setActingId(p.id);
    setActionMsg(null);
    try {
      await ctx.api.revokeLink(entry.id, p.linkId);
      setActionMsg("Lien révoqué.");
      await loadStatus();
    } catch (e) {
      await dialogs.alert({ title: "Révocation impossible", message: e instanceof Error ? e.message : "Erreur." });
    } finally {
      setActingId(null);
    }
  };

  // Relance un signataire qui ignore son lien. Le secret du lien ne quitte
  // jamais le navigateur de l'émetteur : le serveur ne peut donc pas
  // reconstituer l'URL lui-même — seule cette session, si elle a encore le
  // lien fraîchement créé en mémoire (`links`), peut le recopier telle quelle ;
  // sinon on ne peut que réactiver le lien côté serveur (repousse son
  // expiration si besoin) et inviter à retransmettre le lien déjà envoyé.
  const remindParty = async (r: SignRequestDto, p: SignParty) => {
    setActingId(p.id);
    setActionMsg(null);
    try {
      const res = await ctx.api.remindSignParty(entry.id, r.id, p.id);
      const cached = links?.find((l) => l.partyId === p.id);
      if (cached) {
        void navigator.clipboard?.writeText(urlFor(cached));
        setActionMsg(
          res.reactivated
            ? "Lien réactivé (expiration repoussée) et recopié dans le presse-papiers."
            : "Lien recopié dans le presse-papiers — retransmettez-le au signataire.",
        );
      } else {
        setActionMsg(
          res.reactivated
            ? "Lien réactivé (expiration repoussée). Retransmettez le lien déjà envoyé à ce signataire."
            : "Rappel enregistré. Retransmettez le lien déjà envoyé à ce signataire.",
        );
      }
    } catch (e) {
      await dialogs.alert({ title: "Relance impossible", message: e instanceof Error ? e.message : "Erreur." });
    } finally {
      setActingId(null);
    }
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
            <PenLine size={18} /> Demander une signature — « {entry.name} »
          </h2>
          <button className="elx-icon" onClick={onClose} aria-label="Fermer">
            <X size={18} />
          </button>
        </header>

        <p className="muted">
          Chaque signataire reçoit un lien : il signe en ligne <strong>sans compte</strong>, et le document signé
          revient automatiquement ici. Le secret de déchiffrement reste dans le fragment <code>#</code> du lien.
        </p>

        {!links && (
          <div className="dcx-modal__section">
            <h3 className="dcx-modal__section-title">
              <PenLine size={11} /> Signataires
            </h3>
            {circuitLoading && (
              <p className="muted" style={{ fontSize: 12 }}>
                <Loader size={12} className="elx-spin" /> Vérification du circuit existant du document…
              </p>
            )}
            {hasExistingCircuit && !circuitLoading && (
              <p className="muted" style={{ fontSize: 12 }}>
                Ce document a déjà un circuit de signature (Parapheur) : la demande en reprend les signataires, dans le
                même ordre. Modifiez la liste depuis le panneau Parapheur du document.
              </p>
            )}
            {parties.map((p, i) => (
              <div key={i} className="elx-signrow">
                <span className="elx-signrow__n">{i + 1}</span>
                <input
                  className="elx-input"
                  value={p.label}
                  onChange={(e) => setLabel(i, e.target.value)}
                  placeholder={`Libellé du signataire ${i + 1} (optionnel)`}
                  readOnly={hasExistingCircuit}
                  disabled={circuitLoading}
                />
                {parties.length > 1 && !hasExistingCircuit && (
                  <button className="elx-icon" title="Retirer" onClick={() => removeParty(i)} disabled={circuitLoading}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
            <div className="dcx-fieldrow" style={{ marginTop: 8 }}>
              {!hasExistingCircuit && (
                <button className="elx-mini" onClick={addParty} disabled={parties.length >= 50 || circuitLoading}>
                  <Plus size={14} /> Ajouter un signataire
                </button>
              )}
              <label
                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer" }}
                title="Chaque signataire ne peut signer qu'après le précédent"
              >
                <input type="checkbox" checked={ordered} onChange={(e) => setOrdered(e.target.checked)} />
                <ListOrdered size={14} /> Signer dans l'ordre
              </label>
              <label className="dcx-field">
                <span>Expiration</span>
                <select className="elx-select--surface" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  <option value="">Jamais</option>
                  <option value="7">7 jours</option>
                  <option value="30">30 jours</option>
                </select>
              </label>
            </div>
            {err && <p className="elx-form__error">{err}</p>}
            <button
              className="elx-mini elx-mini--primary"
              style={{ marginTop: 10 }}
              disabled={busy || circuitLoading}
              onClick={() => void createLinks()}
            >
              <PenLine size={14} />{" "}
              {busy ? "Création…" : `Créer ${parties.length > 1 ? parties.length + " liens" : "le lien"}`}
            </button>
          </div>
        )}

        {links && (
          <div className="dcx-modal__section">
            <h3 className="dcx-modal__section-title">
              <CheckCircle2 size={11} /> Liens à transmettre{ordered ? " (à envoyer dans l'ordre)" : ""}
            </h3>
            {links.map((l) => (
              <div key={l.index} className="elx-signrow">
                <span className="elx-signrow__n">{l.index + 1}</span>
                <span className="elx-signrow__label">{l.label || `Signataire ${l.index + 1}`}</span>
                <div className="elx-signrow__out">
                  <input className="elx-input" readOnly value={urlFor(l)} onFocus={(e) => e.currentTarget.select()} />
                  <button className="elx-icon" title="Copier" onClick={() => copy(urlFor(l), l.index)}>
                    {copiedIdx === l.index ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                  </button>
                </div>
              </div>
            ))}
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Transmettez chaque lien au signataire concerné. Le serveur ne voit jamais le secret.
            </p>
            {syncWarning && <p className="elx-form__error">{syncWarning}</p>}
          </div>
        )}

        {requests && requests.length > 0 && (
          <div className="dcx-modal__section">
            <h3 className="dcx-modal__section-title">Suivi</h3>
            {actionMsg && (
              <p className="muted" role="status" style={{ fontSize: 12 }}>
                {actionMsg}
              </p>
            )}
            {requests.map((r) => (
              <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                {r.ordered && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    <ListOrdered size={12} /> Signature dans l'ordre
                  </span>
                )}
                {r.parties.map((p) => (
                  <div key={p.id} className="elx-row">
                    {p.status === "signed" ? (
                      <CheckCircle2 size={15} className="elx-sign-ok" />
                    ) : p.status === "declined" ? (
                      <XCircle size={15} className="elx-sign-no" />
                    ) : p.status === "cancelled" ? (
                      <Ban size={15} className="elx-sign-wait" />
                    ) : (
                      <Clock size={15} className="elx-sign-wait" />
                    )}
                    <span className="elx-row__label">{p.label || `Signataire ${p.index + 1}`}</span>
                    <span className="elx-row__meta">
                      {p.status === "signed" ? (
                        <>signé{p.signerFpr ? ` · ${fingerprintWords(p.signerFpr)}` : ""}</>
                      ) : p.status === "declined" ? (
                        "refusé"
                      ) : p.status === "cancelled" ? (
                        "révoqué"
                      ) : (
                        "en attente"
                      )}
                    </span>
                    {p.status === "pending" && (
                      <>
                        <button
                          className="elx-icon"
                          title="Relancer (réactive le lien s'il a expiré)"
                          aria-label={`Relancer ${p.label || `signataire ${p.index + 1}`}`}
                          disabled={actingId === p.id}
                          onClick={() => void remindParty(r, p)}
                        >
                          <RotateCcw size={14} />
                        </button>
                        <button
                          className="elx-icon elx-icon--danger"
                          title="Révoquer ce lien"
                          aria-label={`Révoquer le lien de ${p.label || `signataire ${p.index + 1}`}`}
                          disabled={actingId === p.id}
                          onClick={() => void revokeParty(p)}
                        >
                          <Ban size={14} />
                        </button>
                      </>
                    )}
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
