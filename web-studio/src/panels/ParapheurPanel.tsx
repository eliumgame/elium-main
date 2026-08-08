import { useCallback, useEffect, useState } from "react";
import { Stamp, UserPlus, PenLine, X, RotateCcw, Trash2, ArrowUp, ArrowDown, ShieldCheck, UserCheck } from "lucide-react";
import { Button, Badge, EmptyState } from "../ui/components";
import { getWorkflow, saveWorkflow, newPartyId, workflowStatus, type Party } from "../format/parapheur-store";
import { docKeyOf } from "../format/doc-key";
import { verdictLabel } from "../sign/proof";
import { fingerprintWords } from "../sign/safety-words";
import type { Studio } from "../studio/types";
import { useDialogs } from "../ui/dialogs";

const STATUS_LABEL = { draft: "Brouillon", in_progress: "En signature", completed: "Terminé", rejected: "Rejeté" } as const;
const STATUS_ACCENT = { draft: "neutral", in_progress: "info", completed: "success", rejected: "danger" } as const;

/**
 * Parapheur: ordered signing circuit for the document. Each party signs at their
 * turn and their "signé" is backed by a REAL Ed25519 signature embedded in the
 * document (and covered by the seal) — not a mere local flag. The circuit itself
 * (order/status) is still tracked locally in this browser (its travel inside the
 * .elium is a follow-up); the cryptographic proofs, however, travel with the file.
 */
export default function ParapheurPanel({ studio }: { studio: Studio }) {
  const docKey = docKeyOf(studio.file.manifest);
  const vaultSecret = studio.vaultSecret;
  const [parties, setParties] = useState<Party[]>([]);
  const { prompt } = useDialogs();

  useEffect(() => {
    getWorkflow(docKey, vaultSecret)
      .then((w) => setParties(w?.parties ?? []))
      .catch(() => setParties([]));
  }, [docKey, vaultSecret]);

  const persist = useCallback(
    (next: Party[]) => {
      setParties(next);
      void saveWorkflow({ docKey, parties: next, createdAt: new Date().toISOString() }, vaultSecret);
    },
    [docKey, vaultSecret],
  );

  const addParty = async () => {
    const name = await prompt({ title: "Ajouter un signataire", label: "Nom du signataire" });
    if (!name) return;
    const role = (await prompt({ title: "Ajouter un signataire", label: "Rôle / fonction (optionnel)" })) ?? "";
    persist([...parties, { id: newPartyId(), name: name.trim(), role: role.trim(), status: "pending" }]);
  };

  // Really sign as this party: produce an embedded, sealed Ed25519 signature.
  const sign = async (party: Party) => {
    const link = await studio.signAsParty({ name: party.name, role: party.role });
    if (!link) return; // cancelled / no identity
    const at = new Date().toISOString();
    persist(parties.map((p) => (p.id === party.id
      ? { ...p, status: "signed", signatureId: link.signatureId, publicKeyHex: link.publicKeyHex, signedAt: at, updatedAt: at }
      : p)));
  };

  const reject = (id: string) =>
    persist(parties.map((p) => (p.id === id ? { ...p, status: "rejected", updatedAt: new Date().toISOString() } : p)));

  // Reset undoes the signing: drop the link AND remove the embedded signature.
  const reset = (party: Party) => {
    if (party.signatureId) studio.removeSignature(party.signatureId);
    persist(parties.map((p) => (p.id === party.id
      ? { ...p, status: "pending", signatureId: undefined, publicKeyHex: undefined, signedAt: undefined, updatedAt: new Date().toISOString() }
      : p)));
  };

  const move = (id: string, dir: -1 | 1) => {
    const i = parties.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= parties.length) return;
    const next = parties.slice();
    [next[i], next[j]] = [next[j], next[i]];
    persist(next);
  };

  const remove = (id: string) => persist(parties.filter((p) => p.id !== id));

  const overall = workflowStatus(parties);
  const nextPendingIdx = parties.findIndex((p) => p.status === "pending");

  return (
    <div className="panel-section">
      <div className="panel-title-row">
        <h3 className="panel-title"><Stamp size={16} /> Parapheur</h3>
        <Badge accent={STATUS_ACCENT[overall]}>{STATUS_LABEL[overall]}</Badge>
      </div>
      <p className="muted" style={{ marginBottom: 10 }}>
        Circuit de signature ordonné. Chaque partie signe à son tour : sa signature est une vraie preuve
        Ed25519 embarquée dans le document et couverte par le sceau. L'ordre et le suivi sont conservés
        localement (le voyage du circuit dans le <code>.elium</code> viendra ensuite).
      </p>

      {parties.length === 0 ? (
        <EmptyState title="Aucun signataire" hint="Ajoutez les parties dans l'ordre de signature." />
      ) : (
        <ol className="party-list">
          {parties.map((p, i) => {
            const isNext = i === nextPendingIdx;
            const verdict = p.signatureId ? studio.verdicts[p.signatureId] : undefined;
            const attributedTo = p.signatureId ? studio.attributions[p.signatureId] : undefined;
            const tagClass = p.status === "signed"
              ? (verdict === "modified" || verdict === "invalid" ? "invalid" : "valid")
              : p.status === "rejected" ? "invalid" : "visual_only";
            const tagText = p.status === "signed"
              ? (verdict ? verdictLabel(verdict) : "Signé")
              : p.status === "rejected" ? "Refusé" : "En attente";
            return (
              <li key={p.id} className={`party-item ${isNext ? "is-next" : ""}`}>
                <div className="party-item__main">
                  <span className="party-item__order">{i + 1}</span>
                  <div className="party-item__info">
                    <div className="party-item__name">{p.name}</div>
                    {p.role && <div className="party-item__role">{p.role}</div>}
                    {p.status === "signed" && (
                      <div className="party-item__proof">
                        {attributedTo
                          ? <><UserCheck size={12} /> {attributedTo} (clé de confiance)</>
                          : p.publicKeyHex
                            ? <><ShieldCheck size={12} /> {fingerprintWords(p.publicKeyHex)}</>
                            : null}
                      </div>
                    )}
                  </div>
                  <span className={`sig-tag sig-tag--${tagClass}`}>{tagText}</span>
                </div>
                <div className="party-item__actions">
                  <button className="icon-btn" title="Monter" onClick={() => move(p.id, -1)} disabled={i === 0}>
                    <ArrowUp size={14} />
                  </button>
                  <button className="icon-btn" title="Descendre" onClick={() => move(p.id, 1)} disabled={i === parties.length - 1}>
                    <ArrowDown size={14} />
                  </button>
                  {p.status === "pending" && isNext && studio.editable && (
                    <>
                      <button className="icon-btn" title="Signer (preuve Ed25519)" disabled={studio.busy} onClick={() => void sign(p)}>
                        <PenLine size={15} />
                      </button>
                      <button className="icon-btn icon-btn--danger" title="Refuser" onClick={() => reject(p.id)}>
                        <X size={15} />
                      </button>
                    </>
                  )}
                  {(p.status === "signed" || p.status === "rejected") && studio.editable && (
                    <button className="icon-btn" title="Réinitialiser (retire la signature)" onClick={() => reset(p)}>
                      <RotateCcw size={15} />
                    </button>
                  )}
                  <button className="icon-btn icon-btn--danger" title="Retirer du circuit" onClick={() => remove(p.id)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <Button variant="outline" size="sm" onClick={addParty} style={{ marginTop: 12 }}>
        <UserPlus size={14} /> Ajouter un signataire
      </Button>
    </div>
  );
}
