/** Passeport professionnel : tableau synoptique (même structure que le passeport officiel), solutions logicielles par activité, visa. */
import { useMemo, useState } from "react";
import { Download, FileDown, FileText } from "lucide-react";
import { Alert, Button } from "../../ui/components";
import { MODALITES } from "../model";
import { synopticRows, type SynopticRow } from "../exportPasseport";
import type { PassportData } from "../types";

interface Props {
  data: PassportData;
  onVisa: (visa: PassportData["visa"]) => void;
  onSolutions: (activityId: string, text: string) => void;
  /** Reprend les « solutions logicielles » des situations validées qui touchent l'activité. */
  onPrefillSolutions: () => void;
  allDomains: boolean;
  onAllDomains: (v: boolean) => void;
  onDocx: () => void;
  onPdf: () => void;
  onDossier: () => void;
  onOpenSituation: (id: number) => void;
}

export default function PassportTab(p: Props) {
  const { data } = p;
  const [pending, setPending] = useState(false);
  const rows = useMemo(() => synopticRows(data, { allDomains: p.allDomains }), [data, p.allDomains]);
  const validated = data.situations.filter((s) => s.transfer).length;
  const h = data.holder;
  const wrapAction = (fn: () => void) => () => {
    setPending(true);
    try {
      fn();
    } finally {
      setTimeout(() => setPending(false), 600);
    }
  };

  return (
    <div className="pp-passport">
      <div className="pp-passport__bar">
        <div>
          <h2>BTS GESTION DE LA PME — SESSION {h.session || "…"} — PASSEPORT PROFESSIONNEL</h2>
          <p className="pp-note">
            {[h.nom.toUpperCase(), h.prenom].filter(Boolean).join(" ") || "Candidat non renseigné"}
            {h.numeroCandidat ? ` — N° ${h.numeroCandidat}` : " — numéro de candidat à compléter"} · {validated}{" "}
            situation(s) validée(s) sur {data.situations.length}
          </p>
        </div>
        <div className="pp-passport__actions">
          <Button size="sm" onClick={wrapAction(p.onPdf)} disabled={pending}>
            <FileText size={14} /> PDF (A4 paysage)
          </Button>
          <Button size="sm" variant="outline" onClick={wrapAction(p.onDocx)} disabled={pending}>
            <FileDown size={14} /> Word
          </Button>
          <Button size="sm" variant="outline" onClick={wrapAction(p.onDossier)} disabled={pending}>
            <Download size={14} /> Dossier complet (PDF)
          </Button>
        </div>
      </div>

      {validated === 0 && (
        <Alert tone="info">
          Le passeport se remplit à partir des fiches : ouvrez une situation, choisissez ses activités et tâches, puis «
          Transférer vers le passeport ».
        </Alert>
      )}

      <div className="pp-passport__opts">
        <label className="pp-check">
          <input type="checkbox" checked={p.allDomains} onChange={(e) => p.onAllDomains(e.target.checked)} /> Afficher
          et exporter aussi les domaines 2 à 4 (E51, ressources humaines, soutien) — le document de l'épreuve E4 ne
          reprend que le domaine 1
        </label>
        <Button size="sm" variant="ghost" onClick={p.onPrefillSolutions}>
          Reprendre les solutions logicielles des fiches
        </Button>
      </div>

      <div className="pp-tablewrap" tabIndex={0} role="region" aria-label="Tableau du passeport professionnel">
        <table className="pp-syn">
          <thead>
            <tr>
              <th rowSpan={2} className="pp-syn__bandh" aria-label="Domaine" />
              <th rowSpan={2} className="pp-syn__left">
                ACTIVITÉS ▸
              </th>
              <th rowSpan={2}>SOLUTIONS LOGICIELLES ET FONCTIONNALITÉS</th>
              <th rowSpan={2}>
                SITUATIONS VÉCUES OU OBSERVÉES ▸<br />
                COMPÉTENCES ▾
              </th>
              {MODALITES.map((m) => (
                <th key={m.id}>{m.label}</th>
              ))}
              <th rowSpan={2}>Tâches des activités</th>
            </tr>
            <tr>
              <th colSpan={4}>Périodes (Situations Professionnelles)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: SynopticRow) => (
              <tr key={r.taskId}>
                {r.firstOfDomain && (
                  <td rowSpan={r.domainSpan} className="pp-syn__band">
                    <div>
                      DOMAINE D’ACTIVITÉS {r.domainId} : {r.domainTitle}
                    </div>
                  </td>
                )}
                {r.first && (
                  <>
                    <td rowSpan={r.span} className="pp-syn__act">
                      {r.activityLabel}
                    </td>
                    <td rowSpan={r.span} className="pp-syn__sol">
                      <textarea
                        className="pp-input pp-textarea"
                        rows={Math.min(6, Math.max(2, r.span))}
                        aria-label={`Solutions logicielles — activité ${r.activity.id}`}
                        placeholder="Logiciels et fonctionnalités mobilisés…"
                        value={r.solutions}
                        onChange={(e) => p.onSolutions(r.activity.id, e.target.value)}
                      />
                    </td>
                    <td rowSpan={r.span} className="pp-syn__comp">
                      {r.activity.competence}
                    </td>
                    {MODALITES.map((m) => (
                      <td key={m.id} rowSpan={r.span} className={`pp-syn__mark ${r.marks[m.id] ? "has" : ""}`}>
                        {r.marks[m.id]}
                      </td>
                    ))}
                  </>
                )}
                <td className={r.sps.length ? "pp-syn__task is-done" : "pp-syn__task"}>
                  T.{r.taskId}. {r.taskLabel}
                  {r.sps.length > 0 && (
                    <span className="pp-syn__sps">
                      {r.sps.map((id) => (
                        <button key={id} className="pp-chip" onClick={() => p.onOpenSituation(id)}>
                          SP{id}
                        </button>
                      ))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pp-note">
        Les identifiants (« GRCF 2 ; CE2 ») viennent des fiches validées : saisissez-les sur chaque fiche (rubrique
        Identification) ou laissez Elium les déduire de la nature et du rang. Les tâches grisées sont réalisées dans au
        moins une situation validée.
      </p>

      <section className="pp-card">
        <h3>Visa de l'équipe pédagogique</h3>
        <p className="pp-note">
          Le document synoptique doit être authentifié par l'équipe pédagogique et porter le cachet de l'établissement :
          la date de visa s'imprime sur le passeport, les signatures et le cachet se posent sur la version imprimée.
        </p>
        <div className="pp-grid">
          <label className="pp-field">
            <span className="pp-field__label">Date du visa</span>
            <input
              className="pp-input"
              type="date"
              value={data.visa.date}
              onChange={(e) => p.onVisa({ ...data.visa, date: e.target.value })}
            />
          </label>
          <label className="pp-field pp-field--wide">
            <span className="pp-field__label">Mention</span>
            <input
              className="pp-input"
              value={data.visa.note}
              onChange={(e) => p.onVisa({ ...data.visa, note: e.target.value })}
            />
          </label>
        </div>
      </section>
    </div>
  );
}
