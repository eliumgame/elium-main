import { useCallback, useEffect, useState } from "react";
import { Stamp, UserPlus, Check, X, RotateCcw, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { Button, Badge, EmptyState } from "../ui/components";
import { getWorkflow, saveWorkflow, newPartyId, workflowStatus, type Party } from "../format/parapheur-store";
import { docKeyOf } from "../format/doc-key";
import type { Studio } from "../studio/types";
import { useDialogs } from "../ui/dialogs";

const STATUS_LABEL = { draft: "Brouillon", in_progress: "En signature", completed: "Terminé", rejected: "Rejeté" } as const;
const STATUS_ACCENT = { draft: "neutral", in_progress: "info", completed: "success", rejected: "danger" } as const;

/**
 * Parapheur: ordered signing circuit for the document. Local-first tracker (v1):
 * define the parties in signing order and follow each one's status. The actual
 * cryptographic signatures are produced by the existing Elium Sign engine.
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

  const setStatus = (id: string, status: Party["status"]) =>
    persist(parties.map((p) => (p.id === id ? { ...p, status, updatedAt: new Date().toISOString() } : p)));

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
        Circuit de signature ordonné (suivi local). Chaque partie signe à son tour via Elium Sign ;
        marquez ici l'avancement. Le voyage du circuit dans le `.elium` viendra ensuite.
      </p>

      {parties.length === 0 ? (
        <EmptyState title="Aucun signataire" hint="Ajoutez les parties dans l'ordre de signature." />
      ) : (
        <ol className="party-list">
          {parties.map((p, i) => (
            <li key={p.id} className={`party-item ${i === nextPendingIdx ? "is-next" : ""}`}>
              <div className="party-item__main">
                <span className="party-item__order">{i + 1}</span>
                <div className="party-item__info">
                  <div className="party-item__name">{p.name}</div>
                  {p.role && <div className="party-item__role">{p.role}</div>}
                </div>
                <span
                  className={`sig-tag sig-tag--${
                    p.status === "signed" ? "valid" : p.status === "rejected" ? "invalid" : "visual_only"
                  }`}
                >
                  {p.status === "signed" ? "Signé" : p.status === "rejected" ? "Refusé" : "En attente"}
                </span>
              </div>
              <div className="party-item__actions">
                <button className="icon-btn" title="Monter" onClick={() => move(p.id, -1)} disabled={i === 0}>
                  <ArrowUp size={14} />
                </button>
                <button className="icon-btn" title="Descendre" onClick={() => move(p.id, 1)} disabled={i === parties.length - 1}>
                  <ArrowDown size={14} />
                </button>
                <button className="icon-btn" title="Marquer signé" onClick={() => setStatus(p.id, "signed")}>
                  <Check size={15} />
                </button>
                <button className="icon-btn icon-btn--danger" title="Marquer refusé" onClick={() => setStatus(p.id, "rejected")}>
                  <X size={15} />
                </button>
                <button className="icon-btn" title="Réinitialiser" onClick={() => setStatus(p.id, "pending")}>
                  <RotateCcw size={15} />
                </button>
                <button className="icon-btn icon-btn--danger" title="Retirer du circuit" onClick={() => remove(p.id)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <Button variant="outline" size="sm" onClick={addParty} style={{ marginTop: 12 }}>
        <UserPlus size={14} /> Ajouter un signataire
      </Button>
    </div>
  );
}
