/**
 * Dossier de la sous-épreuve E51 « Participer à la gestion des risques de la PME » en PDF. L'annexe VI-2 ne
 * fournit pas de modèle de document (contrairement au passeport synoptique ou à la fiche d'analyse) : elle
 * liste les deux parties à produire (identification, puis dossier de l'épreuve) et leur contenu minimal. Ce
 * PDF reprend l'ordre exact de l'annexe et sa sobriété (Times New Roman, titres centrés en gras).
 */
import type { PDFDocument } from "pdf-lib";
import { activityById, E51_BODY_FIELDS, E51_SECTION_TITLES, FORMES_EVALUATION } from "../model";
import type { PassportData } from "../types";
import { appendAnnexes } from "./pdfAnnexes";
import { A4_PORTRAIT, Canvas, newDoc, wrap, type FontBytes, type Fonts } from "./pdfKit";

const LEFT = 56;
const RIGHT = A4_PORTRAIT[0] - 56;
const TOP = 56;
const BOTTOM = A4_PORTRAIT[1] - 60;

export function drawDossierE51(doc: PDFDocument, fonts: Fonts, data: PassportData): void {
  const h = data.holder;
  const e = data.dossierE51;
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
  const ensure = (y: number, need: number) => (y + need > BOTTOM ? newPage() : y);

  let y = TOP;
  const mid = A4_PORTRAIT[0] / 2;
  c.text(`BTS Gestion de la PME, session ${h.session}`, mid, y + 8, { font: "timesBold", size: 11, align: "center" });
  y += 13;
  c.text("E51 – Participer à la gestion des risques de la PME", mid, y + 8, {
    font: "timesBold",
    size: 11,
    align: "center",
  });
  y += 26;
  const who = `${h.nom.toUpperCase()} ${h.prenom}`.trim();
  if (who || h.numeroCandidat)
    c.text(`${who}${h.numeroCandidat ? ` — N° de candidat : ${h.numeroCandidat}` : ""}`, mid, y, {
      font: "times",
      size: 10.5,
      align: "center",
    });
  y += 22;

  // -------------------------------------------------------- partie 1 : identification
  const title1 = "IDENTIFICATION DU PROJET";
  const tw1 = c.measure(title1, { font: "timesBold", size: 10 });
  c.text(title1, mid, y, { font: "timesBold", size: 10, align: "center" });
  c.h(y + 1.6, mid - tw1 / 2, mid + tw1 / 2, 0.6);
  y += 20;

  const idLines: [string, string][] = [
    ["Forme d'évaluation", FORMES_EVALUATION.find((f) => f.id === e.formeEvaluation)?.label ?? ""],
    ["Intitulé du projet", e.intituleProjet || "(à compléter)"],
    [
      "Activités du domaine 2 mobilisées",
      e.activitesMobilisees.length
        ? e.activitesMobilisees.map((id) => `${id} — ${activityById(id)?.title ?? ""}`).join(" ; ")
        : "(aucune sélectionnée)",
    ],
    ["Période", e.periode || "(à compléter)"],
    ["Lieu", e.lieu || "(à compléter)"],
  ];
  const body = 10.5;
  const pitch = 14;
  for (const [label, value] of idLines) {
    const lines = wrap(fonts.times, body, value, RIGHT - LEFT - 150);
    y = ensure(y, Math.max(1, lines.length) * pitch + 4);
    c.text(`${label} :`, LEFT, y, { font: "timesBold", size: body });
    lines.forEach((t, i) => c.text(t, LEFT + 155, y + i * pitch, { font: "times", size: body }));
    y += Math.max(1, lines.length) * pitch + 6;
  }
  y += 10;

  // -------------------------------------------------------- partie 2 : dossier de l'épreuve
  const title2 = "DOSSIER DE L'ÉPREUVE";
  y = ensure(y, 30);
  const tw2 = c.measure(title2, { font: "timesBold", size: 10 });
  c.text(title2, mid, y, { font: "timesBold", size: 10, align: "center" });
  c.h(y + 1.6, mid - tw2 / 2, mid + tw2 / 2, 0.6);
  y += 10;
  y = ensure(y, 20);
  for (const t of wrap(
    fonts.times,
    9,
    "Présentation du contexte et évaluation globale : 12 pages maximum (annexe VI-2), hors annexes.",
    RIGHT - LEFT,
  )) {
    c.text(t, mid, y + 12, { font: "times", size: 9, align: "center", color: [0.4, 0.4, 0.4] });
    y += 13;
  }
  y += 14;

  for (const key of E51_BODY_FIELDS) {
    y = ensure(y, 24);
    c.text(E51_SECTION_TITLES[key], LEFT, y, { font: "timesBold", size: body + 0.5 });
    y += 16;
    const text = e[key].trim();
    const lines = text ? wrap(fonts.times, body, text, RIGHT - LEFT) : [];
    if (!lines.length) {
      y = ensure(y, pitch);
      c.text("(à rédiger)", LEFT, y, { font: "times", size: body - 1, color: [0.45, 0.45, 0.45] });
      y += pitch;
    }
    for (const t of lines) {
      y = ensure(y, pitch);
      c.text(t, LEFT, y, { font: "times", size: body });
      y += pitch;
    }
    y += 12;
  }
  footer();
}

export async function buildDossierE51Pdf(
  data: PassportData,
  fontBytes: FontBytes | null,
  opts: { annexes?: Map<string, Uint8Array> } = {},
): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc(fontBytes);
  doc.setTitle(`Dossier E51 — ${data.holder.prenom} ${data.holder.nom}`.trim());
  doc.setProducer("Elium");
  drawDossierE51(doc, fonts, data);
  const prods = data.dossierE51.productions;
  if (opts.annexes && prods.length)
    await appendAnnexes(doc, fonts, "Dossier E51 — productions", prods, (id) => opts.annexes!.get(id));
  return doc.save();
}
