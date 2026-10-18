/** Passeport professionnel : tableau synoptique activités × modalités, tâches grisées, visa de l'équipe pédagogique. */
import { useMemo, useState } from "react";
import { Download, FileDown, Printer } from "lucide-react";
import { Alert, Button } from "../../ui/components";
import { MODALITES } from "../model";
import { synopticRows } from "../exportPasseport";
import type { PassportData } from "../types";

interface Props {
  data: PassportData;
  onVisa: (visa: PassportData["visa"]) => void;
  onDocx: () => void;
  onPdf: () => void;
  onDossier: () => void;
  onOpenSituation: (id: number) => void;
}

export default function PassportTab({ data, onVisa, onDocx, onPdf, onDossier, onOpenSituation }: Props) {
  const [e4Only, setE4Only] = useState(false);
  const rows = useMemo(() => synopticRows(data), [data]);
  const shown = e4Only
    ? rows.filter((r, i) => {
        if (r.kind === "domain") return i === 0;
        return r.activity.id.startsWith("1.");
      })
    : rows;
  const validated = data.situations.filter((s) => s.transfer).length;
  const h = data.holder;

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
          <Button size="sm" onClick={onDocx}>
            <FileDown size={14} /> Word (paysage)
          </Button>
          <Button size="sm" variant="outline" onClick={onPdf}>
            <Printer size={14} /> PDF
          </Button>
          <Button size="sm" variant="outline" onClick={onDossier}>
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
        <input type="checkbox" checked={e4Only} onChange={(e) => setE4Only(e.target.checked)} /> Afficher uniquement le
        domaine 1 (E4)
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
            {shown.map((r) => {
              if (r.kind === "domain")
                return (
                  <tr key={r.title}>
                    <td className="pp-syn__dom" colSpan={7}>
                      {r.title}
                    </td>
                  </tr>
                );
              return (
                <tr key={r.taskId}>
                  {r.first && (
                    <>
                      <td rowSpan={r.span} className="pp-syn__act">
                        Activité {r.activity.id} — {r.activity.title}
                      </td>
                      <td rowSpan={r.span}>{r.activity.competence}</td>
                      {MODALITES.map((m) => (
                        <td key={m.id} rowSpan={r.span} className={`pp-syn__mark ${r.marks[m.id].length ? "has" : ""}`}>
                          {r.marks[m.id].map((x) => (
                            <div key={x}>{x}</div>
                          ))}
                        </td>
                      ))}
                    </>
                  )}
                  <td className={r.sps.length ? "pp-syn__task is-done" : "pp-syn__task"}>
                    <b>T.{r.taskId}</b> {r.taskLabel}
                    {r.sps.length > 0 && (
                      <span className="pp-syn__sps">
                        {r.sps.map((id) => (
                          <button key={id} className="pp-chip" onClick={() => onOpenSituation(id)}>
                            SP{id}
                          </button>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="pp-note">Les tâches grisées ont été réalisées dans au moins une situation validée.</p>

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
              onChange={(e) => onVisa({ ...data.visa, date: e.target.value })}
            />
          </label>
          <label className="pp-field pp-field--wide">
            <span className="pp-field__label">Mention</span>
            <input
              className="pp-input"
              value={data.visa.note}
              onChange={(e) => onVisa({ ...data.visa, note: e.target.value })}
            />
          </label>
        </div>
      </section>
    </div>
  );
}
