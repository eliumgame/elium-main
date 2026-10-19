/**
 * Fiche d'analyse de situation professionnelle (annexe V-4) en PDF — reproduction fidèle du modèle
 * officiel `ficheAnalyseSPVierge.docx` : toutes les cotes (traits, remplissages, lignes de base) ont été
 * relevées sur le rendu Word du modèle. Les rubriques libres s'agrandissent avec le texte et passent à
 * la page suivante comme dans Word.
 */
import type { PDFDocument } from "pdf-lib";
import { MOIS, activityById, spLabel } from "../model";
import type { Holder, Situation } from "../types";
import { A4_PORTRAIT, Canvas, newDoc, wrap, width, type FontBytes, type Fonts } from "./pdfKit";

const X0 = 39.8; // trait gauche du tableau
const X1 = 555.7; // trait droit
const COL1 = 149.1; // fin de la colonne des libellés
const MID = 184.95; // centre de la colonne « SP1 / mois »
const GREY = 0.85;
const LINE = 12.22; // interligne Calibri 10 pt dans le modèle
const PAGE_BOTTOM = 790;
const CONT_TOP = 51.2; // haut du tableau sur une page de suite

interface FreeRow {
  /** Lignes du libellé : texte, taille, gras, ligne de base relative au haut de la rangée. */
  label: { t: string; sz: number; dy: number; x?: number }[];
  value: string;
}

const L10 = (t: string, dy: number) => ({ t, sz: 10, dy });

function freeRows(s: Situation): FreeRow[] {
  return [
    { label: [L10("Intitulé de la situation", 9.6), L10("professionnelle", 21.85)], value: s.intitule },
    { label: [L10("Lieu, période et durée", 9.6), L10("de réalisation", 21.85)], value: s.lieuPeriodeDuree },
    { label: [L10("Cadre de la Situation", 9.6), L10("professionnelle", 21.85)], value: s.cadre },
  ];
}

function freeRowsAfter(s: Situation): FreeRow[] {
  return [
    { label: [L10("Acteurs et relation", 9.6), L10("entre les acteurs", 21.85)], value: s.acteurs },
    { label: [L10("Objectif", 9.6)], value: s.objectif },
    {
      label: [
        L10("Conditions de", 9.6),
        L10("réalisation :", 21.8),
        { t: "contraintes", sz: 9, dy: 21.8, x: 96.5 },
        { t: "dont le processus et", sz: 9, dy: 33.0 },
        { t: "organisation comptable,", sz: 9, dy: 44.1 },
        { t: "environnement", sz: 9, dy: 55.0 },
        { t: "numérique", sz: 9, dy: 66.0 },
      ],
      value: s.conditions,
    },
    { label: [L10("Ressources à", 9.6), L10("disposition", 21.85)], value: s.ressources },
    {
      label: [
        L10("Solutions logicielles", 9.6),
        L10("choisies et", 21.85),
        L10("fonctionnalités", 34.1),
        L10("mobilisées", 46.35),
      ],
      value: s.solutions,
    },
    { label: [L10("Productions réalisées", 9.6)], value: s.productions },
    { label: [L10("Ecrits professionnels", 9.6), L10("produits", 21.85)], value: s.ecrits },
    { label: [L10("Oraux professionnels", 9.6)], value: s.oraux },
  ];
}

const labelBottom = (r: FreeRow): number => Math.max(...r.label.map((l) => l.dy)) + 2.4;
const valueBottom = (n: number): number => 9.6 + Math.max(0, n - 1) * LINE + 2.6;

class Cursor {
  page!: ReturnType<PDFDocument["addPage"]>;
  c!: Canvas;
  /** Haut de la prochaine rangée sur la page courante. */
  y = 0;
  /** Début des bordures verticales de la page courante (0 = pas de trait en cours). */
  edgeFrom = 0;
  /** Verticales à tracer en plus des bords (x) : colonne des libellés. */
  mid: number | null = COL1;

  constructor(
    private doc: PDFDocument,
    private fonts: Fonts,
  ) {}

  newPage(): void {
    this.page = this.doc.addPage(A4_PORTRAIT);
    this.c = new Canvas(this.page, this.fonts);
  }

  /** Ferme les bordures verticales ouvertes jusqu'à `y`. */
  flushEdges(y: number): void {
    if (this.edgeFrom && y > this.edgeFrom) {
      this.c.v(X0, this.edgeFrom, y, 0.5);
      this.c.v(X1, this.edgeFrom, y, 0.5);
    }
  }
}

/** Dessine une rubrique libre (libellé + valeur), avec coupure de page ligne à ligne. */
function drawFreeRow(cur: Cursor, row: FreeRow): void {
  const f = cur.c.fonts;
  const lines = wrap(f.reg, 10, row.value, X1 - 5.1 - 154.6);
  let from = 0;
  let first = true;
  do {
    const room = PAGE_BOTTOM - cur.y;
    const need = Math.max(first ? labelBottom(row) : 0, valueBottom(lines.length - from));
    let take = lines.length - from;
    if (need > room) {
      take = Math.max(1, Math.floor((room - 9.6 - 2.6) / LINE) + 1);
      // pas la place d'une seule ligne : page suivante
      if (room < 9.6 + 2.6 + 0.1 || (first && room < labelBottom(row))) take = 0;
    }
    if (take > 0 || lines.length === 0) {
      const part = lines.slice(from, from + take);
      const h = Math.max(first ? labelBottom(row) : 0, valueBottom(Math.max(part.length, 1)));
      const top = cur.y;
      if (first) for (const l of row.label) cur.c.text(l.t, l.x ?? 45.2, top + l.dy, { font: "bold", size: l.sz });
      part.forEach((t, i) => cur.c.text(t, 154.6, top + 9.6 + i * LINE, { size: 10 }));
      cur.y = top + h;
      cur.c.h(cur.y + 0.25, X0, X1);
      cur.c.v(COL1, top, cur.y + 0.25);
      from += take;
      first = false;
    }
    if (from < lines.length) {
      cur.flushEdges(cur.y);
      cur.newPage();
      cur.y = CONT_TOP;
      cur.c.h(cur.y - 0.25, X0, X1);
      cur.edgeFrom = cur.y;
    }
  } while (from < lines.length);
}

/** Verso : tableau ANALYSE (libellés verticaux), une rubrique à la fois. */
function drawAnalyse(doc: PDFDocument, fonts: Fonts, s: Situation): void {
  const rows = [
    { label: "Analyse de la situation", value: s.analyse, min: 125.9 },
    {
      label: "Contribution de la  situation professionnelle à la professionnalisation",
      value: s.contribution,
      min: 307.2,
    },
  ];
  const XL = 70.95;
  const VX = 76.3;
  const VW = X1 - 5.6 - VX;
  const PITCH = 11.0;
  let page = doc.addPage(A4_PORTRAIT);
  let c = new Canvas(page, fonts);
  let y = 51.5;
  const band = (yy: number) => {
    c.fill(39.5, yy + 0.1, 556, yy + 19.7, GREY);
    c.h(yy, 39.3, 556.2);
    c.h(yy + 20.2, 39.3, 556.2);
    c.text("ANALYSE", 297.65, yy + 13.5, { font: "bold", size: 14, align: "center" });
    return yy + 20.2;
  };
  y = band(y);
  let rowTop = y;
  const closeRow = (bottom: number, labelTxt: string | null) => {
    c.h(bottom, 39.3, 556.2);
    c.v(39.25, rowTop, bottom);
    c.v(XL, rowTop, bottom);
    c.v(556.2, rowTop, bottom);
    if (labelTxt) {
      const w = width(fonts.bold, 10, labelTxt);
      c.textUp(labelTxt, 60.3, (rowTop + bottom) / 2 + w / 2, { font: "bold", size: 10 });
    }
  };
  for (const row of rows) {
    const lines = wrap(fonts.reg, 9, row.value, VW);
    let from = 0;
    let first = true;
    do {
      const room = PAGE_BOTTOM - rowTop;
      const fit = Math.max(1, Math.floor((room - 8.7 - 2.6) / PITCH) + 1);
      const part = lines.slice(from, from + fit);
      const h = Math.max(first ? row.min : 20, 8.7 + Math.max(0, part.length - 1) * PITCH + 3);
      part.forEach((t, i) => c.text(t, VX, rowTop + 8.7 + i * PITCH, { size: 9 }));
      const bottom = rowTop + (from + part.length >= lines.length ? h : PAGE_BOTTOM - rowTop);
      closeRow(bottom, first ? row.label : null);
      from += part.length;
      first = false;
      if (from < lines.length) {
        page = doc.addPage(A4_PORTRAIT);
        c = new Canvas(page, fonts);
        rowTop = CONT_TOP;
        c.h(rowTop - 0.25, 39.3, 556.2);
      } else rowTop = bottom + 0.4;
    } while (from < lines.length);
  }
}

export function drawFiche(doc: PDFDocument, fonts: Fonts, h: Holder, s: Situation): void {
  const cur = new Cursor(doc, fonts);
  cur.newPage();
  const c = cur.c;
  const sz = (t: string, size: number, bold = false) => width(bold ? fonts.bold : fonts.reg, size, t);
  void sz;
  // Métadonnées invisibles : l'ordre de lecture des cases varie d'un extracteur à l'autre, celles-ci sont sans ambiguïté.
  c.hiddenText(
    `ELIUMFICHE;sp=${s.id};mod=${s.modalite};cond=${s.condition};nat=${s.natures.join(",")};act=${s.activityIds.join(",")};`,
    30,
    20,
  );

  // --- en-tête
  c.text(`BTS Gestion de la PME - Session ${h.session}`, 297.7, 62.4, { font: "bold", size: 12, align: "center" });
  c.text("E4 - Gérer les relations avec les clients et les fournisseurs", 299.1, 77.1, {
    font: "bold",
    size: 12,
    align: "center",
  });
  const box = (x0: number, x1: number, label: string, value: string) => {
    c.h(80.65, x0, x1, 0.5);
    c.v(x0 + 0.2, 80.4, 108.7, 0.4);
    c.v(x1 - 0.7, 80.4, 109.5, 1.4);
    c.h(108.75, x0, x1, 1.5);
    c.text(label, (x0 + x1) / 2, 91.6, { size: 11, align: "center" });
    c.text(value, (x0 + x1) / 2, 105.0, { font: "bold", size: 11, align: "center" });
  };
  box(41.8, 337.1, "NOM et prénom du candidat", `${h.nom.toUpperCase()} ${h.prenom}`.trim());
  box(348.0, 554.2, "Numéro de candidat", h.numeroCandidat);

  // --- titre
  c.fill(40.1, 121.2, 555.4, 144.3, GREY);
  c.text("Fiche d’analyse de situation professionnelle", 297.7, 137.5, { font: "bold", size: 14, align: "center" });
  c.h(120.95, X0, X1);
  c.h(144.5, X0, X1);

  // --- nature
  const nat = (cx: number, label: string, on: boolean) => {
    const w = sz(label, 11) + 6.6 + 4;
    c.checkbox(cx - w / 2, 155.1, on);
    c.text(label, cx - w / 2 + 6.6 + 4, 155.2, { size: 11 });
  };
  nat(94.5, "GRCF", s.natures.includes("grcf"));
  nat(251.5, "Communication orale", s.natures.includes("orale"));
  nat(455, "Communication écrite", s.natures.includes("ecrite"));
  c.v(COL1, 144.7, 318.25);
  c.v(353.7, 144.7, 158.2);
  c.h(158.45, X0, X1);

  // --- identification (4 lignes) + période (4 lignes)
  const opt = (x: number, base: number, label: string, on: boolean) => {
    c.checkbox(x, base, on);
    c.text(label, x + 10.5, base, { size: 10 });
  };
  for (const y of [170.95, 183.85, 196.55]) c.h(y, 221, X1);
  c.h(209.3, X0, X1);
  c.v(220.75, 158.7, 259.8);
  ["Identification de la", "situation", "professionnelle"].forEach((t, i) =>
    c.text(t, 45.2, [175.1, 187.3, 199.6][i], { font: "bold", size: 10 }),
  );
  c.text(spLabel(s.id), MID, 187.4, { font: "bold", size: 10, align: "center" });
  c.text("Modalité de réalisation", 226, 168.3, { font: "bold", size: 10 });
  opt(226, 181.0, "Avant la formation", s.modalite === "avant");
  opt(226, 193.7, "Pendant la formation en établissement", s.modalite === "etablissement");
  opt(
    226,
    206.4,
    "Pendant la formation en milieu professionnel",
    s.modalite === "pme" || s.modalite === "organisation",
  );

  for (const y of [222.05, 234.75, 247.45]) c.h(y, 221, X1);
  c.h(260.05, X0, X1);
  c.text("Période de réalisation", 45.2, 238.2, { font: "bold", size: 10 });
  c.text(MOIS[Math.min(11, Math.max(0, s.mois - 1))], MID, 232.1, { font: "bold", size: 10, align: "center" });
  c.text(String(s.annee), MID, 244.3, { font: "bold", size: 10, align: "center" });
  c.text("Condition de réalisation", 226, 219.1, { font: "bold", size: 10 });
  opt(226, 231.9, "En autonomie", s.condition === "autonomie");
  opt(226, 244.6, "Accompagnée", s.condition === "accompagnee");
  opt(226, 257.2, "En observation", s.condition === "observation");

  // --- activités concernées
  c.text("Activités concernées", 45.2, 292.7, { font: "bold", size: 10 });
  ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"].forEach((id, i) => {
    const base = 267.8 + i * 9.7;
    c.checkbox(154.6, base, s.activityIds.includes(id), 6);
    c.text(`Activité ${id} ${activityById(id)?.title ?? ""}`, 154.6 + 6 + 4.2, base, { font: "arial", size: 8 });
    if (i < 5) c.h(269.8 + i * 9.7, COL1 + 0.3, X1);
  });
  c.h(318.25, X0, X1);

  // --- rubriques libres (début)
  cur.y = 318.5;
  cur.edgeFrom = 121.2;
  for (const r of freeRows(s)) drawFreeRow(cur, r);

  // --- enjeux : bandeau + 3 colonnes (rangée minimale 42,6 pt)
  const probs = [s.problemeGestion, s.problemeOral, s.problemeEcrit];
  const colX = [40.1, 212.1, 383.9, 555.4];
  const wraps = probs.map((p, i) => wrap(fonts.reg, 10, p, colX[i + 1] - colX[i] - 10.2));
  const nLines = Math.max(1, ...wraps.map((w) => w.length));
  const hProb = Math.max(42.6, valueBottom(nLines));
  const blockH = 12.7 + 13.5 + hProb;
  if (cur.y + blockH > PAGE_BOTTOM) {
    cur.flushEdges(cur.y);
    cur.newPage();
    cur.y = CONT_TOP;
    cur.edgeFrom = cur.y;
    cur.c.h(cur.y - 0.25, X0, X1);
  }
  const cc = cur.c;
  const by = cur.y;
  cc.fill(40.1, by + 0.5, 555.4, by + 12.7, GREY);
  cc.text("Problème de gestion soulevé et enjeux de la situation", 297.7, by + 10.1, {
    font: "bold",
    size: 10,
    align: "center",
  });
  cc.h(by + 12.95, X0, X1);
  [0, 1, 2].forEach((i) => {
    cc.fill(colX[i] + (i ? 0.5 : 0), by + 13.2, colX[i + 1] - 0.3, by + 26.2, GREY);
    cc.text(
      ["De GRCF", "De communication orale", "De communication écrite"][i],
      (colX[i] + colX[i + 1]) / 2,
      by + 23.2,
      {
        font: "bold",
        size: 10,
        align: "center",
      },
    );
    wraps[i].forEach((t, k) => cc.text(t, colX[i] + 5.1, by + 26.7 + 9.6 + k * LINE, { size: 10 }));
  });
  cc.h(by + 26.5, X0, X1);
  const rowEnd = by + 26.7 + hProb;
  cc.v(212.35, by + 13.2, rowEnd);
  cc.v(383.7, by + 13.2, rowEnd);
  cc.h(rowEnd + 0.25, X0, X1);
  cur.y = rowEnd + 0.5;
  cur.mid = COL1;

  for (const r of freeRowsAfter(s)) drawFreeRow(cur, r);
  cur.flushEdges(cur.y);

  drawAnalyse(doc, fonts, s);
}

export async function buildFichePdf(h: Holder, s: Situation, fontBytes: FontBytes | null): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc(fontBytes);
  doc.setTitle(`Fiche d'analyse ${spLabel(s.id)} — ${h.prenom} ${h.nom}`.trim());
  doc.setProducer("Elium");
  drawFiche(doc, fonts, h, s);
  return doc.save();
}
