/** Passeport professionnel : tableau synoptique activités × modalités, tâches grisées, solutions logicielles, visa. */
import { Fragment, useMemo } from "react";
import { Download, FileDown, FileText } from "lucide-react";
import { Alert, Button } from "../../ui/components";
import { MODALITES, REFERENTIEL, passportCells } from "../model";
import { synopticRows } from "../exportPasseport";
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
  const rows = useMemo(() => synopticRows(data, { allDomains: p.allDomains }), [data, p.allDomains]);
  const cells = useMemo(() => passportCells(data), [data]);
  const validated = data.situations.filter((s) => s.transfer).length;
  const h = data.holder;
  const domains = p.allDomains ? REFERENTIEL : REFERENTIEL.slice(0, 1);

  return (
    <div className="pp-passport">
      <div className="pp-passport__bar">
        <div>
          <h2>BTS Gestion de la PME — Session {h.session || "…"} — Passeport professionnel</h2>
          <p className="pp-note">
            {[h.nom.toUpperCase(), h.prenom].filter(Boolean).join(" ") || "Candidat non renseigné"}
            {h.numeroCandidat ? ` — N° ${h.numeroCandidat}` : ""} · {validated} situation(s) validée(s) sur{" "}
            {data.situations.length}
          </p>
        </div>
        <div className="pp-passport__actions">
          <Button size="sm" onClick={p.onDocx}>
            <FileDown size={14} /> Word (paysage)
          </Button>
          <Button size="sm" variant="outline" onClick={p.onPdf}>
            <FileText size={14} /> PDF
          </Button>
          <Button size="sm" variant="outline" onClick={p.onDossier}>
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

      <label className="pp-check">
        <input type="checkbox" checked={p.allDomains} onChange={(e) => p.onAllDomains(e.target.checked)} /> Afficher et
        exporter aussi les domaines 2 à 4 (le document de l'épreuve E4 ne reprend que le domaine 1)
      </label>

      <div className="pp-tablewrap" tabIndex={0} role="region" aria-label="Tableau du passeport professionnel">
        <table className="pp-syn">
          <thead>
            <tr>
              <th scope="col">Activités</th>
              <th scope="col">Compétences</th>
              {MODALITES.map((m) => (
                <th key={m.id} scope="col">
                  {m.short}
                </th>
              ))}
              <th scope="col">Tâches des activités</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.taskId}>
                {r.firstOfDomain && (
                  <tr>
                    <td className="pp-syn__dom" colSpan={7}>
                      DOMAINE D’ACTIVITÉS {r.domainId} : {r.domainTitle}
                    </td>
                  </tr>
                )}
                <tr>
                  {r.first && (
                    <>
                      <td rowSpan={r.span} className="pp-syn__act">
                        Activité {r.activity.id} — {r.activity.title}
                      </td>
                      <td rowSpan={r.span}>{r.activity.competence}</td>
                      {MODALITES.map((m) => {
                        const marks = cells.get(`${r.activity.id}|${m.id}`) ?? [];
                        return (
                          <td key={m.id} rowSpan={r.span} className={`pp-syn__mark ${marks.length ? "has" : ""}`}>
                            {marks.map((x) => (
                              <div key={`${x.spId}`}>
                                {x.code} – {x.period}
                              </div>
                            ))}
                          </td>
                        );
                      })}
                    </>
                  )}
                  <td className={r.sps.length ? "pp-syn__task is-done" : "pp-syn__task"}>
                    <b>T.{r.taskId}</b> {r.taskLabel}
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
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pp-note">Les tâches grisées ont été réalisées dans au moins une situation validée.</p>

      <section className="pp-card">
        <h3>Solutions logicielles et fonctionnalités</h3>
        <p className="pp-note">
          Une rubrique du passeport officiel : pour chaque activité, les logiciels et fonctionnalités mobilisés. Elle
          figure dans le PDF et le Word du passeport.
        </p>
        <div className="pp-grid">
          {domains.flatMap((d) =>
            d.activities.map((a) => (
              <label key={a.id} className="pp-field">
                <span className="pp-field__label">
                  Activité {a.id} — {a.title}
                </span>
                <textarea
                  className="pp-input pp-textarea"
                  rows={2}
                  value={data.solutions[a.id] ?? ""}
                  placeholder="Logiciels et fonctionnalités mobilisés…"
                  onChange={(e) => p.onSolutions(a.id, e.target.value)}
                />
              </label>
            )),
          )}
        </div>
        <div className="pp-actions">
          <Button size="sm" variant="outline" onClick={p.onPrefillSolutions}>
            Reprendre les solutions logicielles des fiches
          </Button>
        </div>
      </section>

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
