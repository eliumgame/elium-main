/** Éditeur d'une fiche de situation professionnelle (équivalent d'une feuille « Fiche SPxx » du classeur). */
import { useMemo } from "react";
import { ArrowLeft, Copy, FileDown, Printer, Send, Trash2, Undo2 } from "lucide-react";
import { Alert, Badge, Button } from "../../ui/components";
import {
  CONDITIONS,
  MODALITES,
  MOIS,
  NATURES,
  REFERENTIEL,
  STATE_LABEL,
  competencesOf,
  completion,
  isStale,
  periodLabel,
  situationState,
  spLabel,
  toggleActivity,
  toggleTask,
  transferIssues,
} from "../model";
import type { Condition, Modalite, Nature, Situation } from "../types";

interface Props {
  situation: Situation;
  onChange: (fn: (s: Situation) => Situation) => void;
  onBack: () => void;
  onTransfer: () => void;
  onUntransfer: () => void;
  onDocx: () => void;
  onPdf: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

type TextKey =
  | "intitule"
  | "lieuPeriodeDuree"
  | "cadre"
  | "problemeGestion"
  | "problemeOral"
  | "problemeEcrit"
  | "acteurs"
  | "objectif"
  | "conditions"
  | "ressources"
  | "solutions"
  | "productions"
  | "ecrits"
  | "oraux"
  | "analyse"
  | "contribution"
  | "pieces"
  | "remarques";

export const STATE_ACCENT = {
  "a-completer": "neutral",
  "a-valider": "info",
  "a-retransferer": "warning",
  validee: "success",
} as const;

export default function SituationEditor(p: Props) {
  const s = p.situation;
  const set = (patch: Partial<Situation>) =>
    p.onChange((cur) => ({ ...cur, ...patch, modifiedAt: new Date().toISOString() }));
  const state = situationState(s);
  const issues = useMemo(() => transferIssues(s), [s]);
  const pct = completion(s);

  const area = (key: TextKey, label: string, o: { hint?: string; rows?: number; show?: boolean } = {}) =>
    o.show === false ? null : (
      <label className="pp-field" key={key}>
        <span className="pp-field__label">{label}</span>
        {o.hint && <span className="pp-field__hint">{o.hint}</span>}
        <textarea
          className="pp-input pp-textarea"
          rows={o.rows ?? 3}
          value={s[key] as string}
          onChange={(e) => set({ [key]: e.target.value } as Partial<Situation>)}
        />
      </label>
    );

  const toggleNature = (n: Nature) =>
    set({ natures: s.natures.includes(n) ? s.natures.filter((x) => x !== n) : [...s.natures, n] });

  return (
    <div className="pp-editor">
      <div className="pp-editor__bar">
        <Button variant="ghost" size="sm" onClick={p.onBack}>
          <ArrowLeft size={16} /> Situations
        </Button>
        <h2 className="pp-editor__title">
          Fiche {spLabel(s.id)} <span>{s.intitule || "Sans intitulé"}</span>
        </h2>
        <Badge accent={STATE_ACCENT[state]}>{STATE_LABEL[state]}</Badge>
      </div>

      <div className="pp-editor__actions" role="toolbar" aria-label="Actions de la fiche">
        {s.transfer ? (
          <>
            <Button
              size="sm"
              onClick={p.onTransfer}
              disabled={!isStale(s)}
              title="Met à jour le passeport avec les modifications"
            >
              <Send size={14} /> {isStale(s) ? "Retransférer au passeport" : "À jour dans le passeport"}
            </Button>
            <Button size="sm" variant="outline" onClick={p.onUntransfer}>
              <Undo2 size={14} /> Retirer du passeport
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={p.onTransfer}>
            <Send size={14} /> Transférer vers le passeport
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={p.onDocx}>
          <FileDown size={14} /> Fiche d'analyse (Word)
        </Button>
        <Button size="sm" variant="outline" onClick={p.onPdf}>
          <Printer size={14} /> PDF
        </Button>
        <Button size="sm" variant="outline" onClick={p.onDuplicate}>
          <Copy size={14} /> Dupliquer
        </Button>
        <Button size="sm" variant="danger" onClick={p.onDelete}>
          <Trash2 size={14} /> Supprimer
        </Button>
      </div>

      <div className="pp-progress" aria-label={`Avancement de la rédaction : ${pct} %`}>
        <div className="pp-progress__bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <span>{pct} % rédigé</span>
      </div>

      {isStale(s) && (
        <Alert tone="warning">
          Cette fiche a été modifiée depuis son dernier transfert : le passeport affiche encore l'ancienne version.
          Refaites le transfert pour le mettre à jour.
        </Alert>
      )}
      {!s.transfer && issues.length > 0 && (
        <Alert tone={issues.some((i) => i.level === "error") ? "danger" : "info"}>
          {issues.map((i) => i.message).join(" ")}
        </Alert>
      )}

      <section className="pp-card">
        <h3>Identification de la situation professionnelle</h3>
        <div className="pp-grid">
          <label className="pp-field">
            <span className="pp-field__label">Modalité de réalisation</span>
            <select
              className="pp-input"
              value={s.modalite}
              onChange={(e) => set({ modalite: e.target.value as Modalite })}
            >
              {MODALITES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="pp-field">
            <span className="pp-field__label">Condition de réalisation</span>
            <select
              className="pp-input"
              value={s.condition}
              onChange={(e) => set({ condition: e.target.value as Condition })}
            >
              {CONDITIONS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="pp-field">
            <span className="pp-field__label">Début de la réalisation (mois)</span>
            <select className="pp-input" value={s.mois} onChange={(e) => set({ mois: Number(e.target.value) })}>
              {MOIS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="pp-field">
            <span className="pp-field__label">Année</span>
            <input
              className="pp-input"
              type="number"
              min={2000}
              max={2100}
              value={s.annee}
              onChange={(e) => set({ annee: Number(e.target.value) || s.annee })}
            />
          </label>
          <label className="pp-field">
            <span className="pp-field__label">Durée de la réalisation</span>
            <input
              className="pp-input"
              value={s.duree}
              placeholder="1 mois, 12 h…"
              onChange={(e) => set({ duree: e.target.value })}
            />
          </label>
        </div>
        <fieldset className="pp-checks">
          <legend>Nature de la situation (enjeux traités)</legend>
          {NATURES.map((n) => (
            <label key={n.id} className="pp-check">
              <input type="checkbox" checked={s.natures.includes(n.id)} onChange={() => toggleNature(n.id)} />
              {n.label}
            </label>
          ))}
        </fieldset>
        <p className="pp-note">Période affichée dans le passeport : {periodLabel(s)}.</p>
      </section>

      <section className="pp-card">
        <h3>Activités et tâches concernées</h3>
        <p className="pp-note">
          Cochez les activités puis les tâches mobilisées : les compétences associées se complètent automatiquement. Les
          activités 1.1 à 1.6 relèvent de l'épreuve E4.
        </p>
        {REFERENTIEL.map((d) => {
          const picked = d.activities.some((a) => s.activityIds.includes(a.id));
          return (
            <details key={d.id} className="pp-domain" open={d.id === "1" || picked}>
              <summary>
                Domaine {d.id} — {d.title}
                {d.id === "1" && <Badge accent="info">E4</Badge>}
              </summary>
              {d.activities.map((a) => {
                const on = s.activityIds.includes(a.id);
                return (
                  <div key={a.id} className={`pp-act ${on ? "is-on" : ""}`}>
                    <label className="pp-check pp-act__head">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => p.onChange((cur) => toggleActivity(cur, a.id))}
                      />
                      <strong>Activité {a.id}</strong> {a.title}
                    </label>
                    <div className="pp-act__tasks">
                      {a.tasks.map((t) => (
                        <label key={t.id} className="pp-check pp-task">
                          <input
                            type="checkbox"
                            checked={s.taskIds.includes(t.id)}
                            onChange={() => p.onChange((cur) => toggleTask(cur, t.id))}
                          />
                          <span>
                            <b>T.{t.id}</b> {t.label}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </details>
          );
        })}
        {competencesOf(s).length > 0 && (
          <div className="pp-compet">
            <h4>Compétences associées</h4>
            <ul>
              {competencesOf(s).map((c) => (
                <li key={c.activityId}>
                  <b>{c.activityId}</b> — {c.competence}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="pp-card">
        <h3>Présentation et contexte</h3>
        {area("intitule", "Intitulé de la situation professionnelle", { rows: 2 })}
        {area("lieuPeriodeDuree", "Lieu, période et durée de réalisation", { rows: 2 })}
        {area("cadre", "Cadre de la situation professionnelle", { rows: 4 })}
        <div className="pp-subhead">Problème de gestion soulevé et enjeux de la situation</div>
        {area("problemeGestion", "De GRCF", { show: s.natures.includes("grcf") || !s.natures.length })}
        {area("problemeOral", "De communication orale", { show: s.natures.includes("orale") })}
        {area("problemeEcrit", "De communication écrite", { show: s.natures.includes("ecrite") })}
        {area("acteurs", "Acteurs et relation entre les acteurs")}
        {area("objectif", "Objectif", { rows: 2 })}
        {area("conditions", "Conditions de réalisation", {
          hint: "Contraintes, processus et organisation comptable, environnement numérique.",
        })}
        {area("ressources", "Ressources à disposition")}
        {area("solutions", "Solutions logicielles choisies et fonctionnalités mobilisées", {
          hint: "Indiquer les noms et versions du PGI, tableur, traitement de texte, messagerie, PréAO et autres.",
        })}
        {area("productions", "Productions réalisées")}
        {area("ecrits", "Écrits professionnels produits")}
        {area("oraux", "Oraux professionnels")}
      </section>

      <section className="pp-card">
        <h3>Analyse</h3>
        {area("analyse", "Analyse de la situation", {
          rows: 8,
          hint: "Analyse de l'activité menée, démarches et techniques mises en œuvre, moyens mobilisés, stratégie de communication, difficultés rencontrées et solutions proposées, évaluation de l'atteinte de l'objectif.",
        })}
        {area("contribution", "Contribution à la professionnalisation", {
          rows: 5,
          hint: "Qu'avez-vous appris et en quoi avez-vous progressé ?",
        })}
      </section>

      <section className="pp-card">
        <h3>Suivi</h3>
        {area("pieces", "Pièces et preuves à joindre", {
          hint: "Une ligne par pièce (capture, document produit, courriel, extrait de PGI…). Ces notes restent dans Elium.",
        })}
        {area("remarques", "Remarques de l'enseignant")}
        <label className="pp-check">
          <input type="checkbox" checked={s.relue} onChange={(e) => set({ relue: e.target.checked })} /> Fiche relue par
          l'équipe pédagogique
        </label>
      </section>
    </div>
  );
}
