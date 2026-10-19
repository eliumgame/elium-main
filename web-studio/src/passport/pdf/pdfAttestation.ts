/**
 * Attestation de stage (annexe III-3 du règlement d'examen) en PDF : formulaire reproduit cote par cote d'après
 * le rendu Word de l'annexe officielle (cadres, filets, polices Arial Narrow rendues en Helvetica étirée à 82 %,
 * Times pour l'en-tête et les notes). Les pointillés sont remplacés par les valeurs saisies quand elles existent.
 */
import type { PDFDocument } from "pdf-lib";
import type { Holder, Stage } from "../types";
import { A4_PORTRAIT, Canvas, newDoc, type FontBytes, type FontKey, type Fonts } from "./pdfKit";

const NARROW = 0.82; // Arial Narrow ≈ 82 % d'Arial
const SZ = 9;
const L = 48; // marge gauche du texte
const R = 543.2; // fin des pointillés

type Seg = { t: string; bold?: boolean; italic?: boolean };

const frDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

/** Texte étroit (Arial Narrow) ; `bold` choisit la graisse. */
function nt(
  c: Canvas,
  s: string,
  x: number,
  y: number,
  o: { bold?: boolean; italic?: boolean; size?: number } = {},
): number {
  const font: FontKey = o.bold && o.italic ? "arialBoldItalic" : o.bold ? "arialBold" : "arial";
  return c.text(s, x, y, { font, size: o.size ?? SZ, hscale: NARROW });
}

const nw = (c: Canvas, s: string, o: { bold?: boolean; size?: number } = {}) =>
  c.measure(s, { font: o.bold ? "arialBold" : "arial", size: o.size ?? SZ, hscale: NARROW });

/** Champ : valeur à la place des points ; sinon points de conduite de x0 à x1. */
function field(c: Canvas, value: string, x0: number, x1: number, y: number): void {
  const v = value.trim();
  if (!v) return c.dots(x0, x1, y);
  let size = SZ;
  while (size > 6 && nw(c, v, { size }) > x1 - x0) size -= 0.5;
  nt(c, v, x0 + 3, y, { size });
  c.dots(x0, x1, y);
}

/** Valeur sur plusieurs lignes de pointillés (adresse, missions) : réduit la taille puis tronque si besoin. */
function multi(c: Canvas, value: string, lines: { x0: number; x1: number; y: number }[]): void {
  const v = value.replace(/\s*\n\s*/g, " ").trim();
  if (!v) return lines.forEach((l) => c.dots(l.x0, l.x1, l.y));
  for (let size = SZ; size >= 6; size -= 0.5) {
    const out: string[] = [];
    const rest = v.split(/\s+/);
    for (const l of lines) {
      let cur = "";
      while (rest.length && nw(c, cur ? `${cur} ${rest[0]}` : rest[0], { size }) <= l.x1 - l.x0 - 2)
        cur = cur ? `${cur} ${rest.shift()}` : rest.shift()!;
      out.push(cur);
    }
    if (!rest.length || size === 6) {
      if (rest.length) out[out.length - 1] = `${out[out.length - 1]} …`;
      lines.forEach((l, i) => {
        if (out[i]) nt(c, out[i], l.x0 + 1, l.y, { size });
        c.dots(l.x0, l.x1, l.y);
      });
      return;
    }
  }
}

function checkbox(c: Canvas, x: number, y: number, on: boolean): void {
  c.checkbox(x, y, on, 5.5);
}

function para(c: Canvas, segs: Seg[], x: number, y: number, maxW: number, pitch: number, size = SZ): number {
  // paragraphe à largeur contrainte, segments gras/italique mélangés
  const words: { w: string; b: boolean; i: boolean }[] = [];
  for (const s of segs)
    for (const w of s.t.split(/(\s+)/).filter((z) => z.length)) words.push({ w, b: !!s.bold, i: !!s.italic });
  let cx = x;
  let cy = y;
  for (const wd of words) {
    const wide = c.measure(wd.w, {
      font: wd.b && wd.i ? "arialBoldItalic" : wd.b ? "arialBold" : "arial",
      size,
      hscale: NARROW,
    });
    if (cx + wide > x + maxW && !/^\s+$/.test(wd.w)) {
      cx = x;
      cy += pitch;
    }
    if (/^\s+$/.test(wd.w) && cx === x) continue;
    cx += nt(c, wd.w, cx, cy, { bold: wd.b, italic: wd.i, size });
  }
  return cy;
}

export function drawAttestation(doc: PDFDocument, fonts: Fonts, h: Holder, st: Stage, session: string): void {
  const page = doc.addPage(A4_PORTRAIT);
  const c = new Canvas(page, fonts);

  // --- en-tête
  c.text("ANNEXE III – 3", 48, 28.1, { font: "timesBold", size: 11 });
  c.rect(45.1, 30.8, 313.5 - 45.1, 80.1 - 30.8);
  nt(c, "Cachet de l’organisme d’accueil", 52.6, 44.3, { size: 10 });
  c.h(30.75, 335.8, 543.7);
  c.h(92.05, 335.8, 543.7);
  c.v(336.05, 30.5, 92.3);
  c.v(543.45, 30.5, 92.3);
  const cx = 439.7;
  const center = (s: string, y: number, bold = true) => {
    const w = nw(c, s, { bold, size: 10 });
    nt(c, s, cx - w / 2, y, { bold, size: 10 });
    return cx - w / 2 + w;
  };
  const endTitle = center("ATTESTATION DE STAGE", 41.3);
  c.text("1", endTitle + 1, 38.8, { font: "arialBold", size: 6.5, hscale: NARROW });
  center("BTS gestion de la PME", 52.8);
  center("À utiliser pour les unités U4 et U51", 64.6);
  center("À remettre au stagiaire à l’issue du stage", 76.7);

  // --- cadres
  const frame = (y0: number, y1: number) => {
    c.h(y0 + 0.25, 45.6, 543.2);
    c.h(y1 + 0.25, 45.6, 543.2);
    c.v(45.35, y0, y1 + 0.5);
    c.v(543.45, y0, y1 + 0.5);
  };
  frame(103.9, 168.6);
  frame(179.5, 281.1);
  frame(292.1, 521.6);
  c.h(479.9, 45.6, 543.2, 0.5);

  // --- organisme d'accueil
  const orgW = nw(c, "ORGANISME D’ACCUEIL", { bold: true });
  nt(c, "ORGANISME D’ACCUEIL", 250.5, 113.8, { bold: true });
  c.h(114.95, 250.5, 250.5 + orgW + 1.2, 0.6);
  nt(c, "Nom ou dénomination sociale :", L, 124.1);
  field(c, st.organisme, 147.3, 535.3, 124.1);
  nt(c, "Secteur d’activité :", L, 134.4);
  field(c, st.secteur, 106.3, 536.2, 134.4);
  nt(c, "Adresse :", L, 144.7);
  multi(c, st.adresse, [
    { x0: 81.3, x1: 535.5, y: 144.7 },
    { x0: L, x1: 535.9, y: 155.1 },
  ]);
  nt(c, "Tél. :", L, 166.1);
  c.dots(59.0 + 6, 193.9, 166.1);

  // --- le stagiaire
  nt(c, "Certifie que", L, 177.5, { bold: true });
  nt(c, "LE STAGIAIRE", L, 189.4, { bold: true });
  c.h(190.6, L, 99.7, 0.6);
  nt(c, "Nom :", L, 208.8);
  field(c, h.nom.toUpperCase(), 69.6, 158.3, 208.8);
  nt(c, "Prénom :", 160.4, 208.8);
  field(c, h.prenom, 192.3, 280.9, 208.8);
  nt(c, "Sexe :", 283.0, 208.8);
  nt(c, "F", 306.0, 208.8);
  checkbox(c, 312.5, 208.8, false);
  nt(c, "M", 320.0, 208.8);
  checkbox(c, 328.1, 208.8, false);
  nt(c, "Né(e) le", 343.8, 208.8);
  c.dots(372.1, 388.5, 208.8);
  nt(c, "/", 390.8, 208.8);
  c.dots(394.5, 409.5, 208.8);
  nt(c, "/", 411.6, 208.8);
  c.dots(416, 440, 208.8);
  nt(c, "Adresse :", L, 219.3);
  c.dots(77.2, 536.7, 219.3);
  c.dots(L, 535.1, 229.6);
  nt(c, "Tél. :", L, 240.5);
  c.dots(59.0 + 6, 193.9, 240.5);
  nt(c, "mél :", 195.9, 240.5);
  c.dots(214.0, 454.2, 240.5);
  nt(c, "ETUDIANT EN BTS Gestion de la PME", L, 251.5);
  nt(c, "AU SEIN DE (nom de l’établissement d’enseignement supérieur ou de l’organisme de formation) :", L, 267.9);
  field(c, h.etablissement, L, 527.7, 278.2);

  // --- durée
  nt(c, "A effectué un stage prévu dans le cadre de ses études", L, 290.1, { bold: true });
  nt(c, "DUREE DU STAGE", L, 301.8, { bold: true });
  c.h(303.1, L, 113.9, 0.6);
  const weeksTotal = st.semaines.trim();
  field(c, "", 115.9, 361.7, 301.8);
  nt(c, "Dates de début et de fin de stage : Du", L, 322.5);
  field(c, st.debut ? frDate(st.debut) : "", 174.4, 287.2, 322.5);
  nt(c, "au", 289.1, 322.5);
  field(c, st.fin ? frDate(st.fin) : "", 299.4, 454.3, 322.5);
  nt(c, "Représentant une", L, 343.1);
  nt(c, "durée  totale", 108.6, 343.1, { bold: true });
  nt(c, "de", 154.7, 343.1);
  field(c, weeksTotal, 164.9, 262, 343.1);
  nt(c, "nombre de semaines.", 264.3, 343.1);
  nt(c, "MISSIONS CONFIÉES AU STAGIAIRE (mention obligatoire)", L, 354.6, { bold: true });
  nt(c, " :", 254.4, 354.6);
  nt(c, "- Missions relevant de l’épreuve E4 (Gérer les relations avec les clients et les fournisseurs)", L, 366.6);
  multi(c, st.missionsE4, [
    { x0: L, x1: 534.8, y: 378.6 },
    { x0: L, x1: 534.9, y: 390.6 },
  ]);
  nt(c, "- Missions relevant de la sous-épreuve E51 (Participer à la gestion des risques de la PME)", L, 413.4);
  multi(c, st.missionsE51, [
    { x0: 50, x1: 535.9, y: 423.8 },
    { x0: L, x1: 535.1, y: 435.4 },
  ]);
  para(
    c,
    [
      {
        t: "La durée totale du stage est appréciée en tenant compte de la présence effective du stagiaire dans l’organisme, sous réserve des droits et congés et autorisations d’absence prévus à l’article L.124-13 du code de l’éducation (art. L. 124-18 du code de l’éducation). Chaque période au moins égale à 7 heures de présence consécutives ou non est considérée comme équivalente à un jour de stage et chaque période au moins égale à 22 jours de présence consécutifs ou non est considérée comme équivalente à un mois.",
      },
    ],
    L,
    446.2,
    495,
    10.3,
  );

  // --- gratification
  nt(c, "MONTANT DE LA GRATIFICATION VERSEE AU STAGIAIRE", L, 499.3, { bold: true });
  c.h(500.5, L, 255.9, 0.6);
  nt(c, "Le stagiaire a perçu une gratification de stage pour un", L, 509.6);
  nt(c, "montant total", 226.5, 509.6, { bold: true });
  nt(c, "de", 275.5, 509.6);
  field(c, st.gratification.trim(), 285.7, 385.7, 509.6);
  nt(c, "€", 387.7, 509.6);

  // --- bas de page : information retraite + signature
  c.h(531.6, 48.5, 544.8);
  c.h(645.75, 48.5, 544.8);
  c.v(48.25, 531.9, 645.5);
  c.v(311.1, 531.9, 645.5);
  c.v(545.05, 531.9, 645.5);
  const info: Seg[][] = [
    [{ t: "L’attestation de stage", bold: true }, { t: " est indispensable pour pouvoir, sous réserve du" }],
    [{ t: "versement d’une cotisation, faire prendre en compte le stage dans les droits à" }],
    [{ t: "la retraite. La législation sur les retraites (loi n°2014-40 du 20 janvier 2014)" }],
    [
      { t: "ouvre aux étudiants " },
      { t: "dont le stage a été gratifié", bold: true },
      { t: " la possibilité de faire valider" },
    ],
    [
      { t: "celui-ci dans la " },
      { t: "limite de deux trimestres", bold: true },
      { t: ", sous réserve du " },
      { t: "versement d’une ", bold: true },
    ],
    [
      { t: "cotisation", bold: true },
      { t: ". La " },
      { t: "demande est à faire par l’étudiant dans les deux années", bold: true },
    ],
    [{ t: "suivant la fin du stage et sur " }, { t: "présentation obligatoire de l’attestation de ", bold: true }],
    [{ t: "stage", bold: true }, { t: " mentionnant la durée totale du stage et le montant total de la" }],
    [{ t: "gratification perçue. Les informations précises sur la cotisation à verser et sur" }],
    [{ t: "la procédure à suivre sont à demander auprès de la Sécurité sociale (code de" }],
    [{ t: "la Sécurité sociale art. L351-17 / code de l’éducation art. D. 124-9)." }],
  ];
  const ys = [540.3, 550.6, 560.9, 571.3, 581.6, 591.9, 602.2, 612.7, 623.0, 633.3, 643.6];
  info.forEach((segs, i) => {
    let x = 53.6;
    for (const s of segs) x += nt(c, s.t, x, ys[i], { bold: s.bold });
  });
  nt(c, "FAIT À", 316.4, 550.6, { bold: true });
  field(c, "", 342.2, 417, 550.6);
  nt(c, "LE", 420.2, 550.6, { bold: true });
  field(c, "", 431.7, 537, 550.6);
  nt(c, "Nom, fonction et signature du représentant de l’organisme d’accueil", 316.4, 571.3);
  if (st.representant.trim()) nt(c, st.representant.trim(), 316.4, 584, { size: 8.5 });
  para(
    c,
    [
      {
        t: "Pour les candidats se présentant au titre de leur activité professionnelle, cette attestation sera remplacée par des certificats de travail ou contrats de travail.",
        bold: true,
        italic: true,
      },
    ],
    L,
    654.5,
    495,
    12.2,
  );

  // --- notes de bas de page
  c.h(749.25, 42.8, 186.9, 0.6);
  c.text("1", 42.8, 760.3, { font: "reg", size: 7 });
  c.text(
    "Remettre autant d’attestations que d’entreprises fréquentées pour couvrir les 12 semaines de stage réglementaires",
    51.6,
    764.3,
    {
      font: "times",
      size: 8,
    },
  );
  c.text(
    "Reproduire cette attestation renseignée en autant d’exemplaires que nécessaire pour constituer le dossier décrit pour chacune des épreuves auxquelles le candidat",
    42.8,
    774.2,
    {
      font: "times",
      size: 8,
    },
  );
  c.text("est inscrit", 42.8, 783.5, { font: "times", size: 8 });
  c.text(`BTS Gestion de la PME ${session}`, 42.8, 799.5, { font: "arial", size: 9 });
  void R;
}

export async function buildAttestationPdf(
  h: Holder,
  st: Stage,
  session: string,
  fontBytes: FontBytes | null,
): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc(fontBytes);
  doc.setTitle(`Attestation de stage — ${h.prenom} ${h.nom}`.trim());
  doc.setProducer("Elium");
  drawAttestation(doc, fonts, h, st, session);
  return doc.save();
}
