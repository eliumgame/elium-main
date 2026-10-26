/**
 * Dossier de la sous-épreuve E51 « Participer à la gestion des risques de la PME » (domaine 2). Un seul
 * dossier (pas de fiches numérotées comme pour E4) : identification du projet, contexte et analyse
 * managériale de la PME, évaluation globale des risques et de la démarche qualité, conduite de projet et
 * veille, puis les productions réalisées — ordre et contenu de l'annexe VI-2 du règlement d'examen.
 */
import { useRef } from "react";
import { Download, Eye, FileDown, Paperclip, Printer, Trash2 } from "lucide-react";
import { Badge, Button } from "../../ui/components";
import {
  E51_BODY_FIELDS,
  E51_SECTION_TITLES,
  FORMES_EVALUATION,
  REFERENTIEL,
  dossierE51Checklist,
  dossierProgress,
  estimateE51Pages,
} from "../model";
import type { Annexe, DossierE51, FormeEvaluation, PassportData } from "../types";

interface Props {
  data: PassportData;
  onChange: (patch: Partial<DossierE51>) => void;
  onAddAnnexes: (files: File[]) => void;
  onRemoveAnnexe: (a: Annexe) => void;
  onOpenAnnexe: (a: Annexe, download: boolean) => void;
  onDocx: () => void;
  onPdf: () => void;
}

const fmtSize = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`;
const previewable = (a: Annexe) => /^(image\/|application\/pdf|text\/)/.test(a.mime);

export default function DossierE51Tab(p: Props) {
  const e = p.data.dossierE51;
  const fileInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<DossierE51>) => p.onChange(patch);
  const items = dossierE51Checklist(p.data);
  const pct = dossierProgress(items);
  const pages = estimateE51Pages(e);
  const domaine2 = REFERENTIEL.find((d) => d.id === "2")!;

  const toggleActivite = (id: string) =>
    set({
      activitesMobilisees: e.activitesMobilisees.includes(id)
        ? e.activitesMobilisees.filter((x) => x !== id)
        : [...e.activitesMobilisees, id],
    });

  const area = (key: (typeof E51_BODY_FIELDS)[number], hint?: string, rows = 6) => (
    <label className="pp-field" key={key}>
      <span className="pp-field__label">{E51_SECTION_TITLES[key]}</span>
      {hint && <span className="pp-field__hint">{hint}</span>}
      <textarea
        className="pp-input pp-textarea"
        rows={rows}
        value={e[key]}
        onChange={(ev) => set({ [key]: ev.target.value } as Partial<DossierE51>)}
      />
    </label>
  );

  return (
    <div className="pp-editor">
      <div className="pp-editor__bar">
        <h2 className="pp-editor__title">
          Dossier E51 <span>Participer à la gestion des risques de la PME</span>
        </h2>
        <Badge accent={pct === 100 ? "success" : "info"}>{pct} %</Badge>
      </div>

      <div className="pp-editor__actions" role="toolbar" aria-label="Actions du dossier E51">
        <Button size="sm" variant="outline" onClick={p.onDocx}>
          <FileDown size={14} /> Dossier (Word)
        </Button>
        <Button size="sm" variant="outline" onClick={p.onPdf}>
          <Printer size={14} /> Dossier (PDF)
        </Button>
        <Badge accent={pages > 12 ? "warning" : "neutral"}>
          ≈ {pages} page{pages > 1 ? "s" : ""} / 12 maximum
        </Badge>
      </div>
      <p className="pp-note">
        Estimation indicative sur la présentation du contexte et l'évaluation globale (hors productions en annexe),
        d'après l'annexe VI-2 — ce n'est pas une mesure exacte de mise en page.
      </p>

      <div className="pp-progress" aria-label={`Avancement du dossier E51 : ${pct} %`}>
        <div className="pp-progress__bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <span>{pct} % du dossier</span>
      </div>

      <ul className="pp-check-list">
        {items
          .filter((i) => !i.ok)
          .map((i) => (
            <li key={i.id}>
              <span className="pp-check-list__text">
                {i.label}
                {i.detail && <small>{i.detail}</small>}
              </span>
            </li>
          ))}
        {items.every((i) => i.ok) && <li className="is-ok">Dossier complet selon la checklist.</li>}
      </ul>

      <section className="pp-card">
        <h3>Identification du projet</h3>
        <div className="pp-grid">
          <label className="pp-field">
            <span className="pp-field__label">Forme d'évaluation</span>
            <select
              className="pp-input"
              value={e.formeEvaluation}
              onChange={(ev) => set({ formeEvaluation: ev.target.value as FormeEvaluation })}
            >
              {FORMES_EVALUATION.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="pp-field">
            <span className="pp-field__label">Période</span>
            <input className="pp-input" value={e.periode} onChange={(ev) => set({ periode: ev.target.value })} />
          </label>
          <label className="pp-field">
            <span className="pp-field__label">Lieu</span>
            <input className="pp-input" value={e.lieu} onChange={(ev) => set({ lieu: ev.target.value })} />
          </label>
        </div>
        <label className="pp-field">
          <span className="pp-field__label">Intitulé du projet validé par le(s) formateur(s)</span>
          <input
            className="pp-input"
            value={e.intituleProjet}
            onChange={(ev) => set({ intituleProjet: ev.target.value })}
          />
        </label>
        <fieldset className="pp-checks">
          <legend>Activités du domaine 2 mobilisées</legend>
          {domaine2.activities.map((a) => (
            <label key={a.id} className="pp-check">
              <input
                type="checkbox"
                checked={e.activitesMobilisees.includes(a.id)}
                onChange={() => toggleActivite(a.id)}
              />
              <b>{a.id}</b> {a.title}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="pp-card">
        <h3>Contexte et analyse managériale</h3>
        {area(
          "contextePme",
          "Activité et impact sur les risques ou la démarche qualité, effectif, fiche d'identité, chiffre d'affaires et marché, type de clientèle, politique de communication, certification/label, environnement numérique.",
        )}
        {area(
          "analyseManageriale",
          "Mode de production, structure, mode de coordination, style de management, forces et faiblesses, analyse de la concurrence, ressources et compétences, avantage concurrentiel, facteur clé de succès, stratégies.",
        )}
      </section>

      <section className="pp-card">
        <h3>Évaluation globale</h3>
        {area(
          "evaluationRisques",
          "Ensemble des risques de la PME et moyens déployés pour les prévenir ou les gérer (cartographie, sources, fiabilité).",
        )}
        {area(
          "evaluationQualite",
          "Normes, processus, procédures, labels et certificats ; outils mis en place dans la démarche qualité.",
        )}
      </section>

      <section className="pp-card">
        <h3>Conduite de projet</h3>
        {area("risqueChoisi", "Thème choisi (un risque repéré, ou la démarche qualité) et justification du choix.", 3)}
        {area(
          "conduiteProjet",
          "Organisation des activités et opérations, contraintes et ressources, suivi, contrôle et correction.",
        )}
        {area("veille", "Veille réglementaire ou technologique associée au thème choisi.", 4)}
      </section>

      <section className="pp-card">
        <h3>
          <Paperclip size={16} aria-hidden="true" /> Productions réalisées (annexes du dossier)
        </h3>
        <p className="pp-note">
          Les productions réalisées pour conduire ces travaux (outils, supports, documents produits) se joignent en
          annexe du dossier, en plus des 12 pages (annexe VI-2). Tous les types de fichiers sont acceptés (40 Mo maximum
          chacun).
        </p>
        <div className="pp-actions">
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Paperclip size={14} /> Ajouter des productions…
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(ev) => {
              const files = Array.from(ev.target.files ?? []);
              ev.target.value = "";
              if (files.length) p.onAddAnnexes(files);
            }}
          />
        </div>
        {e.productions.length === 0 ? (
          <p className="pp-note">Aucune production pour l'instant.</p>
        ) : (
          <ol className="pp-annexes">
            {e.productions.map((a, i) => (
              <li key={a.id}>
                <span className="pp-annexes__n">Annexe {i + 1}</span>
                <span className="pp-annexes__body">
                  <b>{a.name}</b>
                  <small>
                    {a.mime || "fichier"} · {fmtSize(a.size)}
                  </small>
                  <input
                    className="pp-input"
                    aria-label={`Légende de la production ${i + 1}`}
                    placeholder="Légende (facultatif)"
                    value={a.note}
                    onChange={(ev) =>
                      set({
                        productions: e.productions.map((x) => (x.id === a.id ? { ...x, note: ev.target.value } : x)),
                      })
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
    </div>
  );
}
