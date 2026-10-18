/**
 * Fiche d'analyse de situation professionnelle (annexe V-4, recto-verso).
 * Word : le modèle officiel `ficheAnalyseSPVierge.docx` est rempli balise par
 * balise — comme la macro du classeur Excel — donc mise en page identique.
 * PDF : même contenu en HTML autonome, imprimé par le navigateur.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { FICHE_TEMPLATE_B64 } from "./ficheTemplate";
import { MODALITES, MOIS, activityById, spLabel } from "./model";
import { esc, escMultiline } from "./print";
import type { Holder, Situation } from "./types";

const CHECKED = "☒";
const UNCHECKED = "☐";
const BREAK = "\u0000";
const box = (on: boolean) => (on ? CHECKED : UNCHECKED);

/** Valeur de chaque balise `<Nom>` du modèle. */
export function ficheValues(h: Holder, s: Situation): Record<string, string> {
  const act = (id: string) => box(s.activityIds.includes(id));
  return {
    AnneeSession: h.session,
    NomCandidat: h.nom.toUpperCase(),
    PrenomCandidat: h.prenom,
    NumeroCandidat: h.numeroCandidat,
    Prob1: box(s.natures.includes("grcf")),
    Prob2: box(s.natures.includes("orale")),
    Prob3: box(s.natures.includes("ecrite")),
    IdSP: spLabel(s.id),
    MOD1: box(s.modalite === "avant"),
    MOD2: box(s.modalite === "etablissement"),
    MOD3: box(s.modalite === "pme" || s.modalite === "organisation"),
    MoisSP: MOIS[Math.min(11, Math.max(0, s.mois - 1))],
    AnneeSP: String(s.annee),
    COND1: box(s.condition === "autonomie"),
    COND2: box(s.condition === "accompagnee"),
    COND3: box(s.condition === "observation"),
    ACT1: act("1.1"),
    ACT2: act("1.2"),
    ACT3: act("1.3"),
    ACT4: act("1.4"),
    ACT5: act("1.5"),
    ACT6: act("1.6"),
    IntituleSP: s.intitule,
    InfosSP: s.lieuPeriodeDuree,
    CadreSP: s.cadre,
    ProblemGestSP: s.problemeGestion,
    ProblemComOSP: s.problemeOral,
    ProblemComESP: s.problemeEcrit,
    ActeursSP: s.acteurs,
    ObjectifSP: s.objectif,
    ConditionsSP: s.conditions,
    RessourcesSP: s.ressources,
    SolutionsSP: s.solutions,
    ProductionsSP: s.productions,
    EcritsSP: s.ecrits,
    OrauxSP: s.oraux,
    AnalyseSP: s.analyse,
    ContributionSP: s.contribution,
  };
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Remplace les balises d'un paragraphe, même coupées entre plusieurs `w:r` par
 * Word : le texte de remplacement va dans le premier `w:t` touché par la balise.
 */
function fillParagraph(p: string, values: Record<string, string>): string {
  const tRe = /<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g;
  const parts: { start: number; end: number; text: string }[] = [];
  for (let m = tRe.exec(p); m; m = tRe.exec(p)) parts.push({ start: m.index, end: m.index + m[0].length, text: m[1] });
  if (parts.length === 0) return p;
  const joined = parts.map((x) => x.text).join("");
  if (!joined.includes("&lt;")) return p;
  const owner: number[] = [];
  parts.forEach((x, i) => {
    for (let k = 0; k < x.text.length; k++) owner.push(i);
  });
  const out = parts.map(() => "");
  const tokenRe = /&lt;(\w+)&gt;/g;
  let pos = 0;
  let touched = false;
  for (let m = tokenRe.exec(joined); m; m = tokenRe.exec(joined)) {
    const val = values[m[1]];
    if (val === undefined) continue;
    for (let i = pos; i < m.index; i++) out[owner[i]] += joined[i];
    out[owner[m.index]] += xmlEsc(val).replace(/\r?\n/g, BREAK);
    pos = m.index + m[0].length;
    touched = true;
  }
  if (!touched) return p;
  for (let i = pos; i < joined.length; i++) out[owner[i]] += joined[i];
  let res = "";
  let last = 0;
  parts.forEach((x, i) => {
    res += p.slice(last, x.start);
    res += `<w:t xml:space="preserve">${out[i].split(BREAK).join('</w:t><w:br/><w:t xml:space="preserve">')}</w:t>`;
    last = x.end;
  });
  return res + p.slice(last);
}

export function fillTemplateXml(xml: string, values: Record<string, string>): string {
  return xml.replace(/<w:p(?:\s[^>]*?)?(?<!\/)>[\s\S]*?<\/w:p>/g, (p) => fillParagraph(p, values));
}

function templateBytes(): Uint8Array {
  const bin = atob(FICHE_TEMPLATE_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Fiche d'analyse au format .docx (modèle officiel rempli). */
export function buildFicheDocx(h: Holder, s: Situation): Uint8Array {
  const files = unzipSync(templateBytes());
  const doc = files["word/document.xml"];
  if (!doc) throw new Error("Modèle de fiche d'analyse invalide.");
  files["word/document.xml"] = strToU8(fillTemplateXml(strFromU8(doc), ficheValues(h, s)));
  return zipSync(files, { level: 6 });
}

export function ficheFileName(h: Holder, s: Situation, ext: string): string {
  const who = [h.nom, h.prenom].filter(Boolean).join("_") || "candidat";
  return `Fiche_analyse_${spLabel(s.id)}_${who}.${ext}`.replace(/[\\/:*?"<>|\s]+/g, "_");
}

// ------------------------------------------------------------------- HTML/PDF

export const PRINT_CSS = `
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.4 Arial, Helvetica, sans-serif; color: #111; margin: 0; }
h1 { font-size: 13pt; margin: 0 0 2mm; } h2 { font-size: 11pt; margin: 0; }
.head { display: flex; justify-content: space-between; gap: 8mm; border-bottom: 2px solid #1a3a6e; padding-bottom: 3mm; margin-bottom: 4mm; }
.meta { font-size: 9.5pt; color: #333; }
table { width: 100%; border-collapse: collapse; margin: 0 0 3mm; }
td, th { border: 1px solid #555; padding: 2mm 2.5mm; vertical-align: top; text-align: left; }
th { background: #e8edf5; font-size: 9.5pt; width: 32%; }
th.full { width: auto; }
.cb { display: inline-block; margin-right: 5mm; white-space: nowrap; }
.acts div { margin: 0.6mm 0; }
.txt { min-height: 14mm; }
.analyse { page-break-before: always; }
.band { background: #1a3a6e; color: #fff; padding: 1.5mm 3mm; font-weight: bold; margin: 0 0 2mm; }
`;

/** Contenu HTML d'une fiche (sans <html>) — réutilisé par le dossier complet. */
export function ficheBody(h: Holder, s: Situation): string {
  const v = ficheValues(h, s);
  const cb = (k: string, label: string) => `<span class="cb">${v[k]} ${esc(label)}</span>`;
  const row = (label: string, value: string) =>
    `<tr><th>${esc(label)}</th><td class="txt">${value ? escMultiline(value) : "&nbsp;"}</td></tr>`;
  const acts = ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"]
    .map((id, i) => `<div>${v[`ACT${i + 1}`]} Activité ${id} ${esc(activityById(id)?.title ?? "")}</div>`)
    .join("");
  const mod = MODALITES.find((m) => m.id === s.modalite)?.label ?? "";
  return `<div class="head"><div><h1>BTS Gestion de la PME — Session ${esc(h.session)}</h1>
<h2>E4 — Gérer les relations avec les clients et les fournisseurs</h2>
<div class="meta"><b>Fiche d'analyse de situation professionnelle</b> ${esc(spLabel(s.id))}</div></div>
<div class="meta"><b>${esc(h.nom.toUpperCase())} ${esc(h.prenom)}</b><br>N° de candidat : ${esc(h.numeroCandidat)}</div></div>
<table><tr><th class="full">Nature : ${cb("Prob1", "GRCF")}${cb("Prob2", "Communication orale")}${cb("Prob3", "Communication écrite")}</th></tr></table>
<div class="band">Identification de la situation professionnelle</div>
<table>
<tr><th>Identification</th><td>${esc(v.IdSP)}</td></tr>
<tr><th>Modalité de réalisation</th><td>${cb("MOD1", "Avant la formation")}${cb("MOD2", "Pendant la formation en établissement")}${cb("MOD3", "Pendant la formation en milieu professionnel")}<br><small>(${esc(mod)})</small></td></tr>
<tr><th>Période de réalisation</th><td>${esc(v.MoisSP)} ${esc(v.AnneeSP)}${s.duree ? ` — ${esc(s.duree)}` : ""}</td></tr>
<tr><th>Condition de réalisation</th><td>${cb("COND1", "En autonomie")}${cb("COND2", "Accompagnée")}${cb("COND3", "En observation")}</td></tr>
<tr><th>Activités concernées</th><td class="acts">${acts}</td></tr>
</table>
<div class="band">Présentation et contexte</div>
<table>
${row("Intitulé de la situation professionnelle", s.intitule)}
${row("Lieu, période et durée de réalisation", s.lieuPeriodeDuree)}
${row("Cadre de la situation professionnelle", s.cadre)}
${row("Problème de gestion soulevé et enjeux — de GRCF", s.problemeGestion)}
${row("— de communication orale", s.problemeOral)}
${row("— de communication écrite", s.problemeEcrit)}
${row("Acteurs et relation entre les acteurs", s.acteurs)}
${row("Objectif", s.objectif)}
${row("Conditions de réalisation : contraintes, processus et organisation comptable, environnement numérique", s.conditions)}
${row("Ressources à disposition", s.ressources)}
${row("Solutions logicielles choisies et fonctionnalités mobilisées", s.solutions)}
${row("Productions réalisées", s.productions)}
${row("Écrits professionnels produits", s.ecrits)}
${row("Oraux professionnels", s.oraux)}
</table>
<div class="analyse"><div class="band">Analyse</div>
<table>
<tr><th class="full">Analyse de la situation</th></tr><tr><td class="txt" style="min-height:90mm">${s.analyse ? escMultiline(s.analyse) : "&nbsp;"}</td></tr>
<tr><th class="full">Contribution de la situation professionnelle à la professionnalisation</th></tr><tr><td class="txt" style="min-height:60mm">${s.contribution ? escMultiline(s.contribution) : "&nbsp;"}</td></tr>
</table></div>`;
}

export function ficheHtml(h: Holder, s: Situation): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(
    ficheFileName(h, s, "pdf"),
  )}</title><style>${PRINT_CSS}</style></head><body>${ficheBody(h, s)}</body></html>`;
}
