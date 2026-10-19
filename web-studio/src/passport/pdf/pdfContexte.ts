/**
 * Présentation du contexte commercial (annexe V-3) en PDF. L'annexe officielle ne fournit PAS de modèle de
 * document : elle liste les douze éléments minimaux à présenter. Ce PDF en reprend la typographie (Times New
 * Roman, titres centrés en gras, puces de l'annexe) et l'ordre exact des douze éléments, chacun suivi du texte rédigé.
 */
import { CONTEXTE_ITEMS } from "../model";
import type { PassportData } from "../types";
import { A4_PORTRAIT, Canvas, newDoc, wrap, type FontBytes, type Fonts } from "./pdfKit";
import type { PDFDocument } from "pdf-lib";

/** Libellés exacts de l'annexe V-3, dans l'ordre. */
export const CONTEXTE_ANNEXE_LABELS = [
  "La fiche de l’identité de l’entreprise",
  "La présentation du marché sur lequel elle évolue et ses grandes tendances",
  "Le chiffre d’affaires et son évolution",
  "Des informations sur le type de clientèle et sa répartition, voire sa segmentation",
  "Des informations sur la concurrence : les prix, les atouts des concurrents et la position de l’entreprise",
  "La présentation du processus d’achat et de vente intégrant les activités comptables",
  "Des informations sur les types de fournisseurs en fonction des achats, ainsi que leur pouvoir de négociation",
  "Les délais de paiement des clients et des fournisseurs",
  "Des informations sur la politique de communication de l’entreprise",
  "La présentation des principes généraux de fixation des prix",
  "La présentation de l’organisation de la fonction commerciale",
  "La description des ressources technologiques mises à disposition",
];

const LEFT = 56;
const RIGHT = A4_PORTRAIT[0] - 56;
const TOP = 56;
const BOTTOM = A4_PORTRAIT[1] - 60;

export function drawContexte(doc: PDFDocument, fonts: Fonts, data: PassportData): void {
  const h = data.holder;
  let page = doc.addPage(A4_PORTRAIT);
  let c = new Canvas(page, fonts);
  let pageNo = 1;
  const footer = () => {
    c.text(`BTS Gestion de la PME ${h.session}`, 42.8, 799.5, { font: "arial", size: 9 });
    c.text(String(pageNo), A4_PORTRAIT[0] - 56, 799.5, { font: "arial", size: 9, align: "right" });
  };
  const newPage = () => {
    footer();
    page = doc.addPage(A4_PORTRAIT);
    c = new Canvas(page, fonts);
    pageNo++;
    return TOP;
  };

  let y = TOP;
  const mid = A4_PORTRAIT[0] / 2;
  c.text(`BTS Gestion de la PME, session ${h.session}`, mid, y + 8, { font: "timesBold", size: 11, align: "center" });
  y += 13;
  c.text("E4 – Gérer les relations avec les clients et les fournisseurs", mid, y + 8, {
    font: "timesBold",
    size: 11,
    align: "center",
  });
  y += 30;
  const who = `${h.nom.toUpperCase()} ${h.prenom}`.trim();
  if (who || h.numeroCandidat)
    c.text(`${who}${h.numeroCandidat ? ` — N° de candidat : ${h.numeroCandidat}` : ""}`, mid, y, {
      font: "times",
      size: 10.5,
      align: "center",
    });
  y += 22;
  const title = "PRÉSENTATION DU CONTEXTE COMMERCIAL";
  const tw = c.measure(title, { font: "timesBold", size: 10 });
  c.text(title, mid, y, { font: "timesBold", size: 10, align: "center" });
  c.h(y + 1.6, mid - tw / 2, mid + tw / 2, 0.6);
  y += 24;

  const body = 11;
  const pitch = 14.2;
  const ensure = (need: number) => {
    if (y + need > BOTTOM) y = newPage();
  };

  CONTEXTE_ANNEXE_LABELS.forEach((label, i) => {
    const it = data.contexte.find((x) => x.id === CONTEXTE_ITEMS[i].id);
    const lines = wrap(fonts.timesBold, body, `${i + 1}. ${label}`, RIGHT - LEFT - 18);
    const notes = (it?.notes ?? "").trim();
    const noteLines = notes ? wrap(fonts.times, body, notes, RIGHT - LEFT - 18) : [];
    ensure(lines.length * pitch + Math.min(noteLines.length, 3) * pitch + 12);
    c.checkbox(LEFT, y, !!it?.done, 7.4);
    lines.forEach((t, k) => c.text(t, LEFT + 17, y + k * pitch, { font: "timesBold", size: body }));
    y += lines.length * pitch + 1;
    if (!noteLines.length) {
      c.text("(à rédiger)", LEFT + 17, y, { font: "times", size: body - 1, color: [0.45, 0.45, 0.45] });
      y += pitch;
    }
    for (const t of noteLines) {
      ensure(pitch);
      c.text(t, LEFT + 17, y, { font: "times", size: body });
      y += pitch;
    }
    y += 9;
  });
  footer();
}

export async function buildContextePdf(data: PassportData, fontBytes: FontBytes | null): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc(fontBytes);
  doc.setTitle(`Contexte commercial — ${data.holder.prenom} ${data.holder.nom}`.trim());
  doc.setProducer("Elium");
  drawContexte(doc, fonts, data);
  return doc.save();
}
