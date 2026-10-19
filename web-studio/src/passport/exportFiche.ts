/**
 * Fiche d'analyse de situation professionnelle (annexe V-4, recto-verso).
 * Word : le modèle officiel `ficheAnalyseSPVierge.docx` est rempli balise par
 * balise — comme la macro du classeur Excel — donc mise en page identique.
 * PDF : même contenu en HTML autonome, imprimé par le navigateur.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { FICHE_TEMPLATE_B64 } from "./ficheTemplate";
import { MOIS, spLabel } from "./model";
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
