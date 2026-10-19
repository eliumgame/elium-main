/**
 * Document synoptique des situations professionnelles (passeport) en PDF A4 paysage, calqué sur le
 * passeport officiel rempli : bandeau de titre, identité, attestation de l'équipe pédagogique, tableau
 * « bande verticale jaune · activités · solutions logicielles · compétences · quatre modalités · tâches ».
 * Les hauteurs de ligne suivent le texte ; les blocs d'activité ne sont jamais coupés entre deux pages.
 */
import { rgb, type PDFDocument } from "pdf-lib";
import { MODALITES } from "../model";
import { synopticRows, type SynopticOptions, type SynopticRow } from "../exportPasseport";
import type { PassportData } from "../types";
import { A4_LANDSCAPE, Canvas, newDoc, wrap, type FontBytes, type Fonts } from "./pdfKit";

const M = 14; // marge
const XB0 = M; // bande verticale
const XB1 = 34;
// Colonnes (bords droits) : activité | solutions | compétences | avant | établissement | PME | organisation | tâches
const XA = 192;
const XS = 272;
const XC = 326;
const X1 = 372;
const X2 = 422;
const X3 = 470;
const X4 = 546;
const XT = X4; // début de la colonne des tâches
const XR = A4_LANDSCAPE[0] - M;
const PAGE_BOTTOM = A4_LANDSCAPE[1] - 12;
const TOP = 12;
const YELLOW: [number, number, number] = [1, 1, 0];

const SZ_TASK = 5.6;
const SZ_ACT = 5.8;
const SZ_COMP = 5.2;
const SZ_BIG = 7.2;
const LH = (sz: number) => sz * 1.17;

function triangle(c: Canvas, x: number, y: number, right: boolean): void {
  // petite flèche pleine (▸ / ▾) : ces glyphes n'existent pas dans la police standard. (x, y) = centre.
  const s = 2.3;
  const H = c.page.getHeight();
  const path = right ? `M 0 0 L ${s * 1.5} ${s} L 0 ${s * 2} Z` : `M 0 0 L ${s * 2} 0 L ${s} ${s * 1.5} Z`;
  c.page.drawSvgPath(path, {
    x: right ? x - s * 0.75 : x - s,
    y: H - (right ? y - s : y - s * 0.75),
    color: rgb(0, 0, 0),
  });
}

interface Block {
  rows: SynopticRow[];
  height: number;
  taskHeights: number[];
  sol: string[];
  comp: string[];
  marks: string[][];
  act: string[];
}

function measure(f: Fonts, rows: SynopticRow[]): Block {
  const r0 = rows[0];
  const taskHeights = rows.map(
    (r) => Math.max(1, wrap(f.arial, SZ_TASK, `T.${r.taskId}. ${r.taskLabel}`, XR - XT - 4).length) * LH(SZ_TASK) + 3.2,
  );
  const sol = r0.solutions.trim() ? wrap(f.arial, SZ_BIG, r0.solutions, XS - XA - 4) : [];
  const comp = wrap(f.arial, SZ_COMP, r0.activity.competence, XC - XS - 4);
  const marks = MODALITES.map((m, i) => {
    const w = [X1 - XC, X2 - X1, X3 - X2, X4 - X3][i] - 4;
    return r0.marks[m.id] ? wrap(f.arial, SZ_BIG, r0.marks[m.id], w) : [];
  });
  const act = wrap(f.arial, SZ_ACT, r0.activityLabel, XA - XB1 - 4);
  const need = Math.max(
    taskHeights.reduce((a, b) => a + b, 0),
    sol.length * LH(SZ_BIG) + 3,
    comp.length * LH(SZ_COMP) + 3,
    ...marks.map((m) => m.length * LH(SZ_BIG) + 3),
    act.length * LH(SZ_ACT) + 3,
  );
  const sum = taskHeights.reduce((a, b) => a + b, 0);
  if (need > sum) taskHeights[taskHeights.length - 1] += need - sum; // la dernière tâche absorbe l'excédent
  return { rows, height: Math.max(need, sum), taskHeights, sol, comp, marks, act };
}

/** Dessine l'en-tête (titre, identité, attestation, entêtes du tableau) ; renvoie le y du bas des entêtes. */
function drawHead(c: Canvas, data: PassportData, fullHead: boolean): number {
  let y = TOP;
  const h = data.holder;
  if (fullHead) {
    // titre
    c.h(y, XB0, XR);
    c.h(y + 13, XB0, XR);
    c.v(XB0, y, y + 13);
    c.v(XB1, y, y + 13);
    c.v(XR, y, y + 13);
    c.text(`BTS GESTION DE LA PME - SESSION ${h.session} - PASSEPORT PROFESSIONNEL`, (XB1 + XR) / 2, y + 9.6, {
      font: "arial",
      size: 9.2,
      align: "center",
    });
    // libellés
    y += 13;
    c.h(y + 11, XB0, XR);
    for (const x of [XB0, XB1, XT, XR]) c.v(x, y, y + 11);
    c.text("NOM et Prénom du titulaire du passeport :", (XB1 + XT) / 2, y + 8, {
      font: "arial",
      size: 6.6,
      align: "center",
    });
    c.text("Numéro du candidat :", (XT + XR) / 2, y + 8, { font: "arial", size: 5.8, align: "center" });
    // valeurs
    y += 11;
    c.text(`${h.nom.toUpperCase()} ${h.prenom}`.trim(), XB1 + 4, y + 9, { font: "arial", size: 6.6 });
    c.text(h.numeroCandidat.trim() || "À compléter", XT + 4, y + 9, { font: "arial", size: 6.6 });
    y += 14;
    // attestation
    const ah = 34;
    c.h(y, XB0, XR);
    c.h(y + ah, XB0, XR);
    for (const x of [XB0, XB1, XT, XR]) c.v(x, y, y + ah);
    c.text(
      "L'équipe pédagogique représentée par les enseignants, en lycée ou centre de formation :",
      (XB1 + XT) / 2,
      y + 10.5,
      {
        font: "bold",
        size: 6.4,
        align: "center",
      },
    );
    const teachers = [h.enseignant1, h.enseignant2].filter(Boolean).join(", ");
    if (teachers) c.text(teachers, (XB1 + XT) / 2, y + 18.5, { font: "arial", size: 6.2, align: "center" });
    c.text(
      "atteste que le titulaire de ce passeport professionnel a bien effectué, en formation, les activités et missions présentées dans ce tableau.",
      (XB1 + XT) / 2,
      y + 27,
      {
        font: "bold",
        size: 6.4,
        align: "center",
      },
    );
    if (data.visa.date) {
      const d = data.visa.date.split("-").reverse().join("/");
      c.text(`Visé le ${d}${data.visa.note ? ` — ${data.visa.note}` : ""}`, (XB1 + XT) / 2, y + 32.2, {
        font: "arial",
        size: 5.4,
        align: "center",
      });
    }
    c.text("Signatures des enseignants de l'équipe", (XT + XR) / 2, y + 10.5, {
      font: "bold",
      size: 6.4,
      align: "center",
    });
    c.text("pédagogique", (XT + XR) / 2, y + 18.5, { font: "bold", size: 6.4, align: "center" });
    c.text("et cachet de l'établissement", (XT + XR) / 2, y + 26.5, { font: "bold", size: 6.4, align: "center" });
    y += ah + 14;
  }
  // entêtes du tableau (deux rangées : modalités en haut, intitulés en bas ; « Tâches » fusionné)
  const hA = 30;
  const hB = 17;
  const top = y;
  const cx = (a: number, b: number) => (a + b) / 2;
  c.h(top, XB0, XR);
  c.h(top + hA, XB1, X4);
  c.h(top + hA + hB, XB0, XR);
  for (const x of [XB0, XB1, XA, XS, XC, X4, XR]) c.v(x, top, top + hA + hB);
  for (const x of [X1, X2, X3]) c.v(x, top, top + hA);
  ["SITUATIONS", "VÉCUES OU", "OBSERVÉES"].forEach((t, i) =>
    c.text(t, cx(XS, XC), top + 8 + i * 7.2, { font: "arial", size: 5.6, align: "center" }),
  );
  triangle(c, XC - 6, top + 22.6, true);
  const modHead: [string[], number, number][] = [
    [["Avant la", "formation"], XC, X1],
    [["Pendant la", "formation en", "établissement"], X1, X2],
    [["Pendant la", "formation", "dans une PME"], X2, X3],
    [["Pendant la formation", "dans une organisation"], X3, X4],
  ];
  modHead.forEach(([ls, a, b]) => {
    const y0 = top + (hA - (ls.length - 1) * 7) / 2 + 2.2;
    ls.forEach((t, i) => c.text(t, cx(a, b), y0 + i * 7, { font: "bold", size: 5.6, align: "center" }));
  });
  c.text("Tâches des activités", cx(XT, XR), top + (hA + hB) / 2 + 2.4, {
    font: "bold",
    size: SZ_BIG,
    align: "center",
  });
  c.text("ACTIVITÉS", XB1 + 4, top + hA + 11.5, { font: "bold", size: 5.8 });
  triangle(c, XB1 + 4 + 33, top + hA + 9.6, true);
  c.text("SOLUTIONS LOGICIELLES", XA + 4, top + hA + 7, { font: "bold", size: 5.4 });
  c.text("ET FONCTIONNALITÉS", XA + 4, top + hA + 14, { font: "bold", size: 5.4 });
  c.text("COMPÉTENCES", XS + 4, top + hA + 11.5, { font: "bold", size: 5.4 });
  triangle(c, XS + 4 + 36, top + hA + 9.6, false);
  c.text("Périodes (Situations Professionnelles)", cx(XC, X4), top + hA + 11, {
    font: "bold",
    size: 5.8,
    align: "center",
  });
  return top + hA + hB;
}

export function drawSynoptic(doc: PDFDocument, fonts: Fonts, data: PassportData, opts: SynopticOptions = {}): void {
  const rows = synopticRows(data, opts);
  // regroupe par activité
  const groups: SynopticRow[][] = [];
  for (const r of rows) {
    if (r.first) groups.push([r]);
    else groups[groups.length - 1].push(r);
  }
  const blocks = groups.map((g) => measure(fonts, g));

  let page = doc.addPage(A4_LANDSCAPE);
  let c = new Canvas(page, fonts);
  let y = drawHead(c, data, true);
  let bandStart = y;
  let bandDomain = blocks[0]?.rows[0];
  const closeBand = (yEnd: number, r: SynopticRow | undefined, drawLabel: boolean) => {
    if (!r || yEnd <= bandStart) return;
    c.fillColor(XB0 + 0.3, bandStart + 0.3, XB1 - 0.3, yEnd - 0.3, YELLOW);
    c.v(XB0, bandStart, yEnd);
    c.v(XB1, bandStart, yEnd);
    if (drawLabel)
      c.textDownCentered(`DOMAINE D’ACTIVITÉS ${r.domainId} : ${r.domainTitle}`, XB0 + 12.5, bandStart, yEnd, {
        font: "bold",
        size: 5.4,
      });
    c.h(yEnd, XB0, XB1);
  };

  for (const b of blocks) {
    const r0 = b.rows[0];
    if (y + b.height > PAGE_BOTTOM) {
      closeBand(y, bandDomain, true);
      page = doc.addPage(A4_LANDSCAPE);
      c = new Canvas(page, fonts);
      y = drawHead(c, data, false);
      bandStart = y;
    }
    if (r0.firstOfDomain && y > bandStart) {
      closeBand(y, bandDomain, true);
      bandStart = y;
    }
    bandDomain = r0;
    // cellules fusionnées
    const top = y;
    const bottom = y + b.height;
    b.act.forEach((t, i) => c.text(t, XB1 + 3, top + 7.2 + i * LH(SZ_ACT), { font: "arial", size: SZ_ACT }));
    b.sol.forEach((t, i) => c.text(t, XA + 3, top + 8 + i * LH(SZ_BIG), { font: "arial", size: SZ_BIG }));
    b.comp.forEach((t, i) => c.text(t, XS + 3, top + 7 + i * LH(SZ_COMP), { font: "arial", size: SZ_COMP }));
    const mx = [XC, X1, X2, X3];
    b.marks.forEach((ls, mi) =>
      ls.forEach((t, i) => c.text(t, mx[mi] + 3, top + 8 + i * LH(SZ_BIG), { font: "arial", size: SZ_BIG })),
    );
    // tâches
    let ty = top;
    b.rows.forEach((r, i) => {
      const lines = wrap(fonts.arial, SZ_TASK, `T.${r.taskId}. ${r.taskLabel}`, XR - XT - 4);
      if (r.sps.length) c.fill(XT + 0.3, ty + 0.3, XR - 0.3, ty + b.taskHeights[i] - 0.3, 0.85);
      lines.forEach((t, k) => c.text(t, XT + 2.6, ty + 5.4 + k * LH(SZ_TASK), { font: "arial", size: SZ_TASK }));
      ty += b.taskHeights[i];
      c.h(ty, XT, XR);
    });
    c.h(bottom, XB1, XT);
    for (const x of [XA, XS, XC, X1, X2, X3, X4, XT, XR]) c.v(x, top, bottom);
    y = bottom;
  }
  closeBand(y, bandDomain, true);
  c.v(XR, y, y); // fin
}

export async function buildSynopticPdf(
  data: PassportData,
  fontBytes: FontBytes | null,
  opts: SynopticOptions = {},
): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc(fontBytes);
  doc.setTitle(`Passeport professionnel — ${data.holder.prenom} ${data.holder.nom}`.trim());
  doc.setProducer("Elium");
  drawSynoptic(doc, fonts, data, opts);
  return doc.save();
}
