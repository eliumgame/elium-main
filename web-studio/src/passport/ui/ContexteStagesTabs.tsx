/** Contexte commercial (annexe V-3) et stages / attestations (annexe III-3). */
import { Plus, Printer, Trash2 } from "lucide-react";
import { Alert, Badge, Button, EmptyState } from "../../ui/components";
import { CONTEXTE_ITEMS, STAGE_TYPES, VOIES, newStage, stageSummary, stageWeeks } from "../model";
import type { ContexteItem, PassportData, Stage, StageType, Voie } from "../types";

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
  data,
  onParcours,
  onChange,
  onPrint,
}: {
  data: PassportData;
  onParcours: (p: PassportData["parcours"]) => void;
  onChange: (stages: Stage[]) => void;
  onPrint: (st: Stage) => void;
}) {
  const stages = data.stages;
  const sum = stageSummary(data);
  const voie = VOIES.find((v) => v.id === data.parcours.voie)!;
  const scolaire = data.parcours.voie === "scolaire";
  const pct = sum.required ? Math.min(100, Math.round((sum.totalWeeks / sum.required) * 100)) : stages.length ? 100 : 0;
  const patch = (id: string, p: Partial<Stage>) => onChange(stages.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const add = (type: StageType) => onChange([...stages, { ...newStage(`st-${Date.now().toString(36)}`), type }]);
  const field = (
    st: Stage,
    key: Exclude<keyof Stage, "id" | "type" | "attestationRecue">,
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
      <section className="pp-card">
        <h3>Parcours et durée à réaliser</h3>
        <div className="pp-grid">
          <label className="pp-field pp-field--wide">
            <span className="pp-field__label">Parcours du candidat</span>
            <select
              className="pp-input"
              value={data.parcours.voie}
              onChange={(e) => onParcours({ ...data.parcours, voie: e.target.value as Voie })}
            >
              {VOIES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
            <span className="pp-field__hint">{voie.requiredHint}</span>
          </label>
          {scolaire && (
            <label className="pp-field">
              <span className="pp-field__label">Semaines de stage à réaliser</span>
              <input
                className="pp-input"
                type="number"
                min={0}
                max={60}
                value={data.parcours.requiredWeeks}
                onChange={(e) =>
                  onParcours({ ...data.parcours, requiredWeeks: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </label>
          )}
        </div>
        <div className="pp-progress" aria-label={`Avancement des périodes en entreprise : ${pct} %`}>
          <div className="pp-progress__bar">
            <div style={{ width: `${pct}%` }} />
          </div>
          <span>
            {sum.totalWeeks} {scolaire ? `/ ${sum.required} ` : ""}semaine(s)
          </span>
        </div>
        <ul className="pp-note pp-stagesum">
          <li>
            Stage : {sum.byType.stage} sem. · Alternance : {sum.byType.alternance} sem. · Activité salariée :{" "}
            {sum.byType.emploi} sem.
          </li>
          {scolaire && (
            <li>
              1re année : {sum.year1} sem. · 2e année : {sum.year2} sem. (plus longue période : {sum.longestYear2} sem.)
              {sum.other > 0 ? ` · hors cycle ou sans date : ${sum.other} sem.` : ""}
            </li>
          )}
          {scolaire && sum.remaining > 0 && (
            <li>
              <b>Il reste {sum.remaining} semaine(s) à réaliser.</b>
            </li>
          )}
          {sum.missingProofs > 0 && <li>{sum.missingProofs} justificatif(s) à obtenir.</li>}
        </ul>
        <Alert tone="warning" title="Durée à confirmer">
          La durée exacte dépend de votre situation (positionnement réglementaire, session, voie) : les sources publiées
          indiquent le plus souvent 12 semaines en voie scolaire — dont 6 consécutives en fin de 1re année et au moins 4
          consécutives en 2e année — mais d'autres valeurs (8, 10, 14) existent. Elium ne la fixe pas : saisissez celle
          de votre établissement. En alternance ou comme salarié, il n'y a pas de stage distinct ; les périodes en
          entreprise et leurs justificatifs fournissent les situations.
        </Alert>
      </section>

      <Alert tone="info" title="Justificatifs">
        Stage : attestation de stage (annexe III-3) avec les missions relevant de l'épreuve E4 et de la sous-épreuve
        E51. Alternance ou activité salariée : contrat et certificat de l'employeur, à la place de l'attestation de
        stage.
      </Alert>
      <div className="pp-actions">
        {STAGE_TYPES.map((tp) => (
          <Button key={tp.id} variant={tp.id === "stage" ? "primary" : "outline"} onClick={() => add(tp.id)}>
            <Plus size={16} /> Ajouter : {tp.label.toLowerCase()}
          </Button>
        ))}
      </div>
      {stages.length === 0 && <EmptyState title="Aucune période saisie" />}
      {stages.map((st, i) => {
        const tp = STAGE_TYPES.find((x) => x.id === st.type)!;
        return (
          <section key={st.id} className="pp-card">
            <div className="pp-stage__head">
              <h3>
                {tp.label} {i + 1} {st.organisme && `— ${st.organisme}`}
              </h3>
              <Badge accent={st.attestationRecue ? "success" : "warning"}>
                {st.attestationRecue ? "Justificatif reçu" : "Justificatif à obtenir"}
              </Badge>
              <Badge accent="info">{stageWeeks(st)} sem.</Badge>
            </div>
            <div className="pp-grid">
              <label className="pp-field">
                <span className="pp-field__label">Nature</span>
                <select
                  className="pp-input"
                  value={st.type}
                  onChange={(e) => patch(st.id, { type: e.target.value as StageType })}
                >
                  {STAGE_TYPES.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
              {field(st, "organisme", st.type === "stage" ? "Organisme d'accueil" : "Employeur")}
              {field(st, "secteur", "Secteur d'activité")}
              {field(st, "debut", "Début", { type: "date" })}
              {field(st, "fin", "Fin", { type: "date" })}
              {field(st, "semaines", "Durée (semaines) — vide : calculée sur les dates")}
              {field(st, "gratification", st.type === "stage" ? "Gratification (€)" : "Rémunération (€)")}
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
                {tp.proof} reçu
              </label>
              <Button size="sm" variant="outline" onClick={() => onPrint(st)}>
                <Printer size={14} /> Préparer l'attestation (PDF)
              </Button>
              <Button size="sm" variant="danger" onClick={() => onChange(stages.filter((s) => s.id !== st.id))}>
                <Trash2 size={14} /> Supprimer
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
