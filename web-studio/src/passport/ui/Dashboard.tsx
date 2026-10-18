/** Tableau de bord : identité du candidat, avancement du dossier E4, statistiques et gestion des données. */
import { useRef, type ReactNode } from "react";
import { CheckCircle2, Circle, Download, Plus, RotateCcw, Upload } from "lucide-react";
import { Badge, Button } from "../../ui/components";
import { MODALITES, dossierChecklist, dossierProgress, passportStats } from "../model";
import type { Holder, PassportData } from "../types";

export type TabId = "dashboard" | "situations" | "passport" | "referentiel" | "contexte" | "stages";

interface Props {
  data: PassportData;
  onHolder: (patch: Partial<Holder>) => void;
  onGoto: (tab: TabId) => void;
  onNewSituation: () => void;
  onBackup: () => void;
  onImport: (file: File) => void;
  onReset: () => void;
  /** Section supplémentaire (sauvegarde serveur), affichée avant la sauvegarde locale. */
  extra?: ReactNode;
}

const HOLDER_FIELDS: { key: keyof Holder; label: string; placeholder?: string; wide?: boolean }[] = [
  { key: "nom", label: "Nom du titulaire" },
  { key: "prenom", label: "Prénom du titulaire" },
  { key: "numeroCandidat", label: "Numéro de candidat" },
  { key: "session", label: "Session du BTS", placeholder: "2026" },
  { key: "etablissement", label: "Nom de l'établissement", wide: true },
  { key: "academie", label: "Académie" },
  { key: "ville", label: "Ville de l'établissement" },
  { key: "enseignant1", label: "Enseignant 1" },
  { key: "enseignant2", label: "Enseignant 2" },
];

export default function Dashboard(p: Props) {
  const { data } = p;
  const items = dossierChecklist(data);
  const pct = dossierProgress(items);
  const st = passportStats(data);
  const file = useRef<HTMLInputElement>(null);
  const modMax = Math.max(1, ...Object.values(st.byModalite));

  return (
    <div className="pp-dash">
      <section className="pp-card">
        <h3>Titulaire du passeport et établissement</h3>
        <div className="pp-grid">
          {HOLDER_FIELDS.map((f) => (
            <label key={f.key} className={`pp-field ${f.wide ? "pp-field--wide" : ""}`}>
              <span className="pp-field__label">{f.label}</span>
              <input
                className="pp-input"
                value={data.holder[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => p.onHolder({ [f.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <p className="pp-note">
          Certaines informations peuvent être complétées plus tard (le numéro de candidat par exemple). Elles servent à
          pré-remplir les fiches d'analyse et le passeport.
        </p>
      </section>

      <section className="pp-card">
        <div className="pp-dash__head">
          <h3>Suivi du dossier E4</h3>
          <Badge accent={pct === 100 ? "success" : "info"}>{pct} %</Badge>
        </div>
        <div className="pp-progress">
          <div className="pp-progress__bar">
            <div style={{ width: `${pct}%` }} />
          </div>
        </div>
        <ul className="pp-check-list">
          {items.map((i) => (
            <li key={i.id} className={i.ok ? "is-ok" : ""}>
              {i.ok ? <CheckCircle2 size={18} aria-label="Fait" /> : <Circle size={18} aria-label="À faire" />}
              <span className="pp-check-list__text">
                {i.label}
                {i.detail && <small>{i.detail}</small>}
              </span>
              {!i.ok && i.tab && (
                <Button size="sm" variant="ghost" onClick={() => p.onGoto(i.tab!)}>
                  Corriger
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="pp-card">
        <h3>Vue d'ensemble</h3>
        <div className="pp-stats">
          <div>
            <strong>{st.total}</strong>
            <span>situation(s)</span>
          </div>
          <div>
            <strong>{st.validated}</strong>
            <span>validée(s) dans le passeport</span>
          </div>
          <div>
            <strong>
              {st.e4TasksCovered}/{st.e4TasksTotal}
            </strong>
            <span>tâches E4 couvertes</span>
          </div>
          <div>
            <strong>
              {st.tasksCovered}/{st.tasksTotal}
            </strong>
            <span>tâches du référentiel</span>
          </div>
        </div>
        <h4>Situations par modalité de réalisation</h4>
        <ul className="pp-bars">
          {MODALITES.map((m) => (
            <li key={m.id}>
              <span>{m.short}</span>
              <span className="pp-bars__track">
                <span style={{ width: `${(st.byModalite[m.id] / modMax) * 100}%` }} />
              </span>
              <b>{st.byModalite[m.id]}</b>
            </li>
          ))}
        </ul>
        <p className="pp-note">
          Nature des situations : GRCF {st.byNature.grcf} · communication orale {st.byNature.orale} · communication
          écrite {st.byNature.ecrite}.
        </p>
        <div className="pp-actions">
          <Button onClick={p.onNewSituation}>
            <Plus size={16} /> Nouvelle situation
          </Button>
        </div>
      </section>

      {p.extra}

      <section className="pp-card">
        <h3>Sauvegarde des données</h3>
        <p className="pp-note">
          Le passeport est enregistré automatiquement dans ce navigateur (chiffré si le coffre local est actif).
          Exportez régulièrement une sauvegarde pour changer d'ordinateur ou vous protéger d'un effacement des données
          du navigateur.
        </p>
        <div className="pp-actions">
          <Button variant="outline" onClick={p.onBackup}>
            <Download size={16} /> Exporter une sauvegarde
          </Button>
          <Button variant="outline" onClick={() => file.current?.click()}>
            <Upload size={16} /> Importer une sauvegarde
          </Button>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) p.onImport(f);
            }}
          />
          <Button variant="danger" onClick={p.onReset}>
            <RotateCcw size={16} /> Tout réinitialiser
          </Button>
        </div>
      </section>
    </div>
  );
}
