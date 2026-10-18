/** Contexte commercial (annexe V-3) et stages / attestations (annexe III-3). */
import { Plus, Printer, Trash2 } from "lucide-react";
import { Alert, Badge, Button, EmptyState } from "../../ui/components";
import { CONTEXTE_ITEMS, newStage } from "../model";
import type { ContexteItem, Stage } from "../types";

export function ContexteTab({
  items,
  onChange,
  onPrint,
}: {
  items: ContexteItem[];
  onChange: (items: ContexteItem[]) => void;
  onPrint: () => void;
}) {
  const done = items.filter((i) => i.done).length;
  const patch = (id: string, p: Partial<ContexteItem>) =>
    onChange(items.map((i) => (i.id === id ? { ...i, ...p } : i)));
  return (
    <div className="pp-ctx">
      <Alert tone="info" title="Présentation du contexte commercial">
        Support des situations professionnelles, il doit comporter au minimum les 12 éléments ci-dessous. Cochez chaque
        élément une fois rédigé et gardez ici vos notes, chiffres et sources.
      </Alert>
      <div className="pp-progress">
        <div className="pp-progress__bar">
          <div style={{ width: `${Math.round((done / items.length) * 100)}%` }} />
        </div>
        <span>
          {done} / {items.length} éléments
        </span>
        <Button size="sm" variant="outline" onClick={onPrint}>
          <Printer size={14} /> Imprimer
        </Button>
      </div>
      {CONTEXTE_ITEMS.map((c, idx) => {
        const it = items.find((i) => i.id === c.id) ?? { id: c.id, done: false, notes: "" };
        return (
          <section key={c.id} className={`pp-card pp-ctx__item ${it.done ? "is-done" : ""}`}>
            <label className="pp-check pp-ctx__head">
              <input type="checkbox" checked={it.done} onChange={(e) => patch(c.id, { done: e.target.checked })} />
              <strong>
                {idx + 1}. {c.label}
              </strong>
            </label>
            <label className="pp-field">
              <span className="pp-field__hint">{c.hint}</span>
              <textarea
                className="pp-input pp-textarea"
                rows={3}
                aria-label={`Notes — ${c.label}`}
                value={it.notes}
                onChange={(e) => patch(c.id, { notes: e.target.value })}
              />
            </label>
          </section>
        );
      })}
    </div>
  );
}

export function StagesTab({
  stages,
  onChange,
  onPrint,
}: {
  stages: Stage[];
  onChange: (stages: Stage[]) => void;
  onPrint: (st: Stage) => void;
}) {
  const patch = (id: string, p: Partial<Stage>) => onChange(stages.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const add = () => onChange([...stages, newStage(`st-${Date.now().toString(36)}`)]);
  const field = (
    st: Stage,
    key: Exclude<keyof Stage, "id" | "attestationRecue">,
    label: string,
    o: { area?: boolean; type?: string } = {},
  ) => (
    <label className="pp-field" key={key}>
      <span className="pp-field__label">{label}</span>
      {o.area ? (
        <textarea
          className="pp-input pp-textarea"
          rows={3}
          value={st[key]}
          onChange={(e) => patch(st.id, { [key]: e.target.value })}
        />
      ) : (
        <input
          className="pp-input"
          type={o.type ?? "text"}
          value={st[key]}
          onChange={(e) => patch(st.id, { [key]: e.target.value })}
        />
      )}
    </label>
  );
  return (
    <div className="pp-stages">
      <Alert tone="info" title="Attestations de stage">
        L'attestation de stage (annexe III-3) est indispensable au dossier et doit mentionner les missions relevant de
        l'épreuve E4 et de la sous-épreuve E51. Pour une activité professionnelle, elle est remplacée par des
        certificats ou contrats de travail. Suivez ici chaque période et préparez l'attestation à faire signer.
      </Alert>
      <Button onClick={add}>
        <Plus size={16} /> Ajouter une période
      </Button>
      {stages.length === 0 && <EmptyState title="Aucune période de stage saisie" />}
      {stages.map((st, i) => (
        <section key={st.id} className="pp-card">
          <div className="pp-stage__head">
            <h3>
              Période {i + 1} {st.organisme && `— ${st.organisme}`}
            </h3>
            <Badge accent={st.attestationRecue ? "success" : "warning"}>
              {st.attestationRecue ? "Attestation reçue" : "Attestation à obtenir"}
            </Badge>
          </div>
          <div className="pp-grid">
            {field(st, "organisme", "Organisme d'accueil")}
            {field(st, "secteur", "Secteur d'activité")}
            {field(st, "debut", "Début", { type: "date" })}
            {field(st, "fin", "Fin", { type: "date" })}
            {field(st, "semaines", "Durée (semaines)")}
            {field(st, "gratification", "Gratification (€)")}
            {field(st, "representant", "Représentant de l'organisme")}
          </div>
          {field(st, "adresse", "Adresse")}
          {field(st, "missionsE4", "Missions relevant de l'épreuve E4", { area: true })}
          {field(st, "missionsE51", "Missions relevant de la sous-épreuve E51", { area: true })}
          {field(st, "notes", "Notes", { area: true })}
          <div className="pp-stage__foot">
            <label className="pp-check">
              <input
                type="checkbox"
                checked={st.attestationRecue}
                onChange={(e) => patch(st.id, { attestationRecue: e.target.checked })}
              />
              Attestation signée reçue
            </label>
            <Button size="sm" variant="outline" onClick={() => onPrint(st)}>
              <Printer size={14} /> Préparer l'attestation (PDF)
            </Button>
            <Button size="sm" variant="danger" onClick={() => onChange(stages.filter((s) => s.id !== st.id))}>
              <Trash2 size={14} /> Supprimer
            </Button>
          </div>
        </section>
      ))}
    </div>
  );
}
