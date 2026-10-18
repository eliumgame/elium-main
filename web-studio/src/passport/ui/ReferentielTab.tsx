/** Référentiel de compétences : parcours des 4 domaines, avec la couverture par les situations validées. */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "../../ui/components";
import { REFERENTIEL, activityCoverage, coveredTasks } from "../model";
import type { PassportData } from "../types";

interface Props {
  data: PassportData;
  onOpenSituation: (id: number) => void;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

export default function ReferentielTab({ data, onOpenSituation }: Props) {
  const [q, setQ] = useState("");
  const covByAct = useMemo(() => new Map(activityCoverage(data).map((c) => [c.activity.id, c])), [data]);
  const tasks = useMemo(() => coveredTasks(data), [data]);
  const needle = norm(q.trim());

  return (
    <div className="pp-ref">
      <label className="pp-search">
        <Search size={16} aria-hidden="true" />
        <input
          className="pp-input"
          type="search"
          placeholder="Rechercher une activité, une tâche, une compétence…"
          aria-label="Rechercher dans le référentiel"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      {REFERENTIEL.map((d) => {
        const acts = d.activities
          .map((a) => ({
            a,
            tasks: a.tasks.filter(
              (t) => !needle || norm(`${t.id} ${t.label} ${a.title} ${a.competence}`).includes(needle),
            ),
          }))
          .filter((x) => !needle || x.tasks.length > 0);
        if (acts.length === 0) return null;
        return (
          <section key={d.id} className="pp-card">
            <h3>
              Domaine d'activités {d.id} — {d.title} {d.id === "1" && <Badge accent="info">E4</Badge>}
              {d.id === "2" && <Badge accent="neutral">E51</Badge>}
            </h3>
            {acts.map(({ a, tasks: ts }) => {
              const c = covByAct.get(a.id)!;
              return (
                <details key={a.id} className="pp-act" open={!!needle}>
                  <summary>
                    <strong>Activité {a.id}</strong> {a.title}
                    <span className="pp-act__cov">
                      <Badge accent={c.tasksCovered === c.tasksTotal ? "success" : c.tasksCovered ? "info" : "neutral"}>
                        {c.tasksCovered}/{c.tasksTotal} tâches
                      </Badge>
                      {c.situations.map((id) => (
                        <button
                          key={id}
                          className="pp-chip"
                          onClick={(e) => {
                            e.preventDefault();
                            onOpenSituation(id);
                          }}
                        >
                          SP{id}
                        </button>
                      ))}
                    </span>
                  </summary>
                  <p className="pp-note">Compétence : {a.competence}</p>
                  <ul className="pp-ref__tasks">
                    {ts.map((t) => (
                      <li key={t.id} className={tasks.has(t.id) ? "is-done" : ""}>
                        <b>T.{t.id}</b> {t.label}
                        {(tasks.get(t.id) ?? []).map((id) => (
                          <button key={id} className="pp-chip" onClick={() => onOpenSituation(id)}>
                            SP{id}
                          </button>
                        ))}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
