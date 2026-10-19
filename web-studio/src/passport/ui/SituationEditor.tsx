/** Éditeur d'une fiche de situation professionnelle (équivalent d'une feuille « Fiche SPxx » du classeur). */
import { useMemo } from "react";
import { ArrowLeft, Copy, Download, Eye, FileDown, Paperclip, Printer, Send, Trash2, Undo2 } from "lucide-react";
import { useRef } from "react";
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
import type { Annexe, Condition, Holder, Modalite, Nature, Situation } from "../types";
import { LEVEL_LABEL, analyseSituation, type Level } from "../analyse";

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
  holder: Holder;
  onAddAnnexes: (files: File[]) => void;
  onRemoveAnnexe: (a: Annexe) => void;
  onOpenAnnexe: (a: Annexe, download: boolean) => void;
}

const fmtSize = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`;
const previewable = (a: Annexe) => /^(image\/|application\/pdf|text\/)/.test(a.mime);

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
  const analysis = useMemo(() => analyseSituation(s, { holder: p.holder }), [s, p.holder]);
  const fileInput = useRef<HTMLInputElement>(null);
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

      <details className="pp-card pp-analyse" open={analysis.score < 100}>
        <summary>
          <b>Analyse de la fiche</b>
          <Badge accent={analysis.score >= 80 ? "success" : analysis.score >= 50 ? "warning" : "danger"}>
            {analysis.score} %
          </Badge>
          <span className="pp-note">
            {analysis.stats.words} mots · phrases de {analysis.stats.avgSentence} mots en moyenne · rubrique la plus
            longue : {analysis.stats.longestRubric || "—"}
          </span>
        </summary>
        <p className="pp-note">
          Repères de rédaction calculés sur le texte (longueur par rubrique, cohérence des activités cochées,
          répétitions, lisibilité) : ce n'est pas une note d'examen.
        </p>
        <ul className="pp-findings">
          {analysis.findings
            .filter((f) => f.level !== "ok")
            .map((f, k) => (
              <li key={k} className={`is-${f.level}`}>
                <span className="pp-findings__lvl">{LEVEL_LABEL[f.level as Level]}</span>
                <b>{f.rubric}</b> — {f.message}
              </li>
            ))}
          {analysis.findings.every((f) => f.level === "ok") && (
            <li className="is-ok">Aucune remarque : la fiche est complète et cohérente.</li>
          )}
        </ul>
        {analysis.suggestedActivities.length > 0 && (
          <div className="pp-actions">
            {analysis.suggestedActivities.map((id) => (
              <Button key={id} size="sm" variant="outline" onClick={() => p.onChange((cur) => toggleActivity(cur, id))}>
                Cocher l'activité {id}
              </Button>
            ))}
          </div>
        )}
      </details>

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
        <label className="pp-field">
          <span className="pp-field__label">Identifiant dans le passeport</span>
          <input
            className="pp-input"
            value={s.code}
            placeholder={`${spLabel(s.id)} (par défaut)`}
            onChange={(e) => set({ code: e.target.value })}
          />
          <span className="pp-field__hint">
            Ce qui s'écrit dans les cases du passeport : par défaut le nom de la fiche (« {spLabel(s.id)} »). Saisissez
            un autre nom au besoin, ou plusieurs séparés par « ; ».
          </span>
        </label>
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
        <h3>
          <Paperclip size={16} aria-hidden="true" /> Annexes de la situation
        </h3>
        <p className="pp-note">
          Joignez les pièces qui prouvent la situation : captures, devis, courriels, tableaux, extraits de logiciel…
          tous les types de fichiers sont acceptés (40 Mo maximum chacun). Elles restent chiffrées sur cet appareil si
          le coffre local est actif, et s'ajoutent à la suite de la fiche dans le dossier complet (PDF, images et textes
          intégrés ; les autres types sont signalés).
        </p>
        <div className="pp-actions">
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Paperclip size={14} /> Ajouter des annexes…
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) p.onAddAnnexes(files);
            }}
          />
        </div>
        {s.annexes.length === 0 ? (
          <p className="pp-note">Aucune annexe pour l'instant.</p>
        ) : (
          <ol className="pp-annexes">
            {s.annexes.map((a, i) => (
              <li key={a.id}>
                <span className="pp-annexes__n">Annexe {i + 1}</span>
                <span className="pp-annexes__body">
                  <b>{a.name}</b>
                  <small>
                    {a.mime || "fichier"} · {fmtSize(a.size)}
                  </small>
                  <input
                    className="pp-input"
                    aria-label={`Légende de l'annexe ${i + 1}`}
                    placeholder="Légende (facultatif)"
                    value={a.note}
                    onChange={(e) =>
                      p.onChange((cur) => ({
                        ...cur,
                        annexes: cur.annexes.map((x) => (x.id === a.id ? { ...x, note: e.target.value } : x)),
                      }))
                    }
                  />
                </span>
                <span className="pp-annexes__actions">
                  {previewable(a) && (
                    <Button size="sm" variant="ghost" onClick={() => p.onOpenAnnexe(a, false)} title="Ouvrir">
                      <Eye size={14} />
                      <span className="pp-sr">Ouvrir {a.name}</span>
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => p.onOpenAnnexe(a, true)} title="Télécharger">
                    <Download size={14} />
                    <span className="pp-sr">Télécharger {a.name}</span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => p.onRemoveAnnexe(a)} title="Retirer">
                    <Trash2 size={14} />
                    <span className="pp-sr">Retirer {a.name}</span>
                  </Button>
                </span>
              </li>
            ))}
          </ol>
        )}
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
