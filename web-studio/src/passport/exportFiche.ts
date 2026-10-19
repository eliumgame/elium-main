/**
 * Fiche d'analyse de situation professionnelle (annexe V-4, recto-verso).
 * Word : le modèle officiel `ficheAnalyseSPVierge.docx` est rempli balise par
 * balise — comme la macro du classeur Excel — donc mise en page identique.
 * PDF : même contenu en HTML autonome, imprimé par le navigateur.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { FICHE_TEMPLATE_B64 } from "./ficheTemplate";
import { MOIS, activityById, spLabel } from "./model";
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
@page { size: A4; margin: 18mm 15mm; }
html { color-scheme: light; background: #fff; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.4 Arial, Helvetica, sans-serif; color: #111; background: #fff; margin: 0; padding: 4mm; }
@media print { body { padding: 0; } }
td { color: #111; }
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

export const FICHE_CSS = `
.fiche { font: 8.5pt/1.25 Arial, Helvetica, sans-serif; color: #000; }
.fiche .ttl { text-align: center; font: bold 11pt Calibri, Carlito, Arial, sans-serif; margin: 0; }
.fiche .ttl2 { text-align: center; font: bold 10pt Calibri, Carlito, Arial, sans-serif; margin: 0 0 1mm; }
.fiche .ident { display: flex; justify-content: space-between; gap: 6mm; margin: 0 0 2mm; }
.fiche .ident > div { border: 1px solid #000; border-radius: 1.5mm; text-align: center; padding: 0.5mm 2mm 1mm; font: 9pt Calibri, Carlito, Arial, sans-serif; }
.fiche .ident > div:first-child { flex: 1 1 62%; }
.fiche .ident > div:last-child { flex: 1 1 33%; }
.fiche .ident b { display: block; font-size: 9.5pt; }
.fiche table { width: 100%; border-collapse: collapse; margin: 0; table-layout: fixed; }
.fiche td, .fiche th { border: 1px solid #7f7f7f; padding: 0.35mm 1.4mm; vertical-align: top; text-align: left; font-weight: normal; width: auto; background: none; }
.fiche .grey { background: #d9d9d9; text-align: center; }
.fiche .bigttl { font: bold 13pt Calibri, Carlito, Arial, sans-serif; text-align: center; padding: 1.2mm; background: #d9d9d9; }
.fiche .lbl { font: bold 8.5pt Calibri, Carlito, Arial, sans-serif; vertical-align: middle; }
.fiche .mid { text-align: center; font: bold 9pt Calibri, Carlito, Arial, sans-serif; vertical-align: middle; }
.fiche .sub { font: bold 8.5pt Calibri, Carlito, Arial, sans-serif; border-bottom: 0; }
.fiche .opt { border-top: 0; border-bottom: 0; padding-top: 0; padding-bottom: 0; line-height: 1.15; font: 8pt/1.15 Arial, Helvetica, sans-serif; }
.fiche .opt.last { border-bottom: 1px solid #7f7f7f; }
.fiche .cb { font-family: "Segoe UI Symbol", "MS Gothic", "DejaVu Sans", Arial, sans-serif; margin: 0; display: inline; }
.fiche .acts td { font-size: 7.3pt; line-height: 1.2; }
.fiche .head3 { font: bold 9pt Calibri, Carlito, Arial, sans-serif; text-align: center; }
.fiche .nat { text-align: center; font: 9pt Calibri, Carlito, Arial, sans-serif; }
.fiche .val { min-height: 6mm; }
.fiche .verso { page-break-before: always; }
.fiche .rot { writing-mode: vertical-rl; transform: rotate(180deg); text-align: center; font: bold 8.5pt Calibri, Carlito, Arial, sans-serif; width: 8mm; padding: 1mm 0; }
.fiche tr { page-break-inside: avoid; }
`;

/** Contenu HTML d'une fiche (sans <html>) — mise en page calquée sur le modèle officiel (annexe V-4, recto/verso). */
export function ficheBody(h: Holder, s: Situation): string {
  const v = ficheValues(h, s);
  const t = (x: string) => (x ? escMultiline(x) : "&nbsp;");
  const cb = (k: string, label: string) => `<span class="cb">${v[k]}</span> ${esc(label)}`;
  const row = (label: string, value: string) =>
    `<tr><td class="lbl">${esc(label)}</td><td colspan="2" class="val">${t(value)}</td></tr>`;
  const acts = ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"]
    .map(
      (id, i) =>
        `<div><span class="cb">${v[`ACT${i + 1}`]}</span>&nbsp; Activité ${id} ${esc(activityById(id)?.title ?? "")}</div>`,
    )
    .join("");
  return `<div class="fiche">
<p class="ttl">BTS Gestion de la PME - Session ${esc(h.session)}</p>
<p class="ttl2">E4 - Gérer les relations avec les clients et les fournisseurs</p>
<div class="ident"><div>NOM et prénom du candidat<b>${esc(h.nom.toUpperCase())} ${esc(h.prenom)}</b></div><div>Numéro de candidat<b>${esc(h.numeroCandidat)}</b></div></div>
<table>
<colgroup><col style="width:21%"><col style="width:14%"><col style="width:65%"></colgroup>
<tr><td colspan="3" class="bigttl">Fiche d’analyse de situation professionnelle</td></tr>
<tr><td colspan="3" style="padding:0"><table><tr><td class="nat" style="width:33%">${cb("Prob1", "GRCF")}</td><td class="nat" style="width:34%">${cb("Prob2", "Communication orale")}</td><td class="nat">${cb("Prob3", "Communication écrite")}</td></tr></table></td></tr>
<tr><td class="lbl" rowspan="4">Identification de la situation professionnelle</td><td class="mid" rowspan="4">${esc(v.IdSP)}</td><td class="sub">Modalité de réalisation</td></tr>
<tr><td class="opt">${cb("MOD1", "Avant la formation")}</td></tr>
<tr><td class="opt">${cb("MOD2", "Pendant la formation en établissement")}</td></tr>
<tr><td class="opt last">${cb("MOD3", "Pendant la formation en milieu professionnel")}</td></tr>
<tr><td class="lbl" rowspan="4">Période de réalisation</td><td class="mid" rowspan="4">${esc(v.MoisSP)}<br>${esc(v.AnneeSP)}</td><td class="sub">Condition de réalisation</td></tr>
<tr><td class="opt">${cb("COND1", "En autonomie")}</td></tr>
<tr><td class="opt">${cb("COND2", "Accompagnée")}</td></tr>
<tr><td class="opt last">${cb("COND3", "En observation")}</td></tr>
<tr class="acts"><td class="lbl">Activités concernées</td><td colspan="2">${acts}</td></tr>
${row("Intitulé de la situation professionnelle", s.intitule)}
${row("Lieu, période et durée de réalisation", s.lieuPeriodeDuree)}
${row("Cadre de la Situation professionnelle", s.cadre)}
<tr><td colspan="3" class="grey sub" style="border-bottom:1px solid #7f7f7f">Problème de gestion soulevé et enjeux de la situation</td></tr>
<tr><td colspan="3" style="padding:0"><table><tr><td class="head3 grey" style="width:33%">De GRCF</td><td class="head3 grey" style="width:34%">De communication orale</td><td class="head3 grey">De communication écrite</td></tr>
<tr><td class="val" style="height:12mm">${t(s.problemeGestion)}</td><td class="val">${t(s.problemeOral)}</td><td class="val">${t(s.problemeEcrit)}</td></tr></table></td></tr>
${row("Acteurs et relation entre les acteurs", s.acteurs)}
${row("Objectif", s.objectif)}
${row("Conditions de réalisation : contraintes dont le processus et organisation comptable, environnement numérique", s.conditions)}
${row("Ressources à disposition", s.ressources)}
${row("Solutions logicielles choisies et fonctionnalités mobilisées", s.solutions)}
${row("Productions réalisées", s.productions)}
${row("Ecrits professionnels produits", s.ecrits)}
${row("Oraux professionnels", s.oraux)}
</table>
<div class="verso"><table>
<colgroup><col style="width:8mm"><col></colgroup>
<tr><td colspan="2" class="bigttl" style="font-size:11pt;padding:0.8mm">ANALYSE</td></tr>
<tr><td class="rot">Analyse de la situation</td><td style="height:46mm">${t(s.analyse)}</td></tr>
<tr><td class="rot">Contribution de la situation professionnelle à la professionnalisation</td><td style="height:109mm">${t(s.contribution)}</td></tr>
</table></div>
</div>`;
}

export function ficheHtml(h: Holder, s: Situation): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(
    ficheFileName(h, s, "pdf"),
  )}</title><style>${PRINT_CSS}${FICHE_CSS}</style></head><body>${ficheBody(h, s)}</body></html>`;
}
