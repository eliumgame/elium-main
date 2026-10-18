/**
 * Exports du passeport : document synoptique (annexe V-2 — Word et PDF), dossier
 * complet (synoptique + toutes les fiches), attestation de stage pré-remplie et
 * sauvegarde JSON complète (réimportable).
 */
import { strToU8, zipSync } from "fflate";
import { PRINT_CSS, ficheBody } from "./exportFiche";
import { CONTEXTE_ITEMS, MODALITES, REFERENTIEL, coveredTasks, passportCells, spLabel } from "./model";
import { esc, escMultiline } from "./print";
import type { Modalite, PassportData, RefActivity, Stage } from "./types";

// ------------------------------------------------------------ données communes

export type SynopticRow =
  | { kind: "domain"; title: string }
  | {
      kind: "task";
      activity: RefActivity;
      /** Première ligne de l'activité (porte les cellules fusionnées). */
      first: boolean;
      span: number;
      taskId: string;
      taskLabel: string;
      /** Situations validées qui mobilisent cette tâche (grisée si non vide). */
      sps: number[];
      marks: Record<Modalite, string[]>;
    };

/** Lignes du passeport synoptique : une par tâche, activités regroupées par domaine. */
export function synopticRows(data: Pick<PassportData, "situations">): SynopticRow[] {
  const cells = passportCells(data);
  const tasks = coveredTasks(data);
  const rows: SynopticRow[] = [];
  for (const d of REFERENTIEL) {
    rows.push({ kind: "domain", title: `DOMAINE D’ACTIVITÉS ${d.id} : ${d.title}` });
    for (const a of d.activities) {
      const marks = {} as Record<Modalite, string[]>;
      for (const m of MODALITES)
        marks[m.id] = (cells.get(`${a.id}|${m.id}`) ?? []).map((x) => `${spLabel(x.spId)} – ${x.period}`);
      a.tasks.forEach((t, i) =>
        rows.push({
          kind: "task",
          activity: a,
          first: i === 0,
          span: a.tasks.length,
          taskId: t.id,
          taskLabel: t.label,
          sps: tasks.get(t.id) ?? [],
          marks,
        }),
      );
    }
  }
  return rows;
}

const holderName = (data: PassportData) => `${data.holder.nom.toUpperCase()} ${data.holder.prenom}`.trim();
const teachers = (data: PassportData) => [data.holder.enseignant1, data.holder.enseignant2].filter(Boolean);

// -------------------------------------------------------------------- HTML/PDF

const SYNOPTIC_CSS = `
@page { size: A4 landscape; margin: 10mm; }
.syn { font-size: 7.5pt; }
.syn h1 { font-size: 12pt; margin: 0 0 2mm; }
.syn .id { display: flex; justify-content: space-between; gap: 6mm; margin-bottom: 2mm; }
.syn .att { border: 1px solid #555; padding: 2mm 3mm; margin-bottom: 3mm; display: flex; justify-content: space-between; gap: 6mm; }
.syn table { margin: 0; }
.syn th { width: auto; font-size: 7.5pt; text-align: center; }
.syn td { padding: 1mm 1.5mm; font-size: 7.5pt; }
.syn tr { page-break-inside: avoid; }
.syn td.dom { background: #1a3a6e; color: #fff; font-weight: bold; }
.syn td.act { background: #f3f5fa; font-weight: bold; }
.syn td.mark { text-align: center; background: #e9f6ec; font-weight: bold; }
.syn td.grey, .syn td.task.grey { background: #c8c8c8; }
`;

export function synopticBody(data: PassportData): string {
  const h = data.holder;
  const rows = synopticRows(data)
    .map((r) => {
      if (r.kind === "domain") return `<tr><td class="dom" colspan="7">${esc(r.title)}</td></tr>`;
      const act = r.first
        ? `<td class="act" rowspan="${r.span}">${esc(`Activité ${r.activity.id} — ${r.activity.title}`)}</td><td rowspan="${r.span}">${esc(
            r.activity.competence,
          )}</td>` +
          MODALITES.map((m) => `<td class="mark" rowspan="${r.span}">${r.marks[m.id].map(esc).join("<br>")}</td>`).join(
            "",
          )
        : "";
      return `<tr>${act}<td class="task${r.sps.length ? " grey" : ""}">T.${esc(r.taskId)} ${esc(r.taskLabel)}${
        r.sps.length ? ` <b>(${r.sps.map(spLabel).join(", ")})</b>` : ""
      }</td></tr>`;
    })
    .join("");
  return `<div class="syn"><div class="id"><div><h1>BTS Gestion de la PME — Session ${esc(h.session)} — Passeport professionnel</h1>
<b>${esc(holderName(data) || "Candidat")}</b> — N° de candidat : ${esc(h.numeroCandidat)}<br>${esc(h.etablissement)}${
    h.ville ? `, ${esc(h.ville)}` : ""
  }${h.academie ? ` (académie de ${esc(h.academie)})` : ""}</div></div>
<div class="att"><div>L'équipe pédagogique${teachers(data).length ? ` (${teachers(data).map(esc).join(", ")})` : ""} atteste que le titulaire de ce passeport professionnel a bien effectué, en formation, les activités et missions présentées dans ce tableau.${
    data.visa.date
      ? `<br><b>Visé le ${esc(data.visa.date)}</b>${data.visa.note ? ` — ${esc(data.visa.note)}` : ""}`
      : ""
  }</div><div style="min-width:60mm">Signatures des enseignants<br>et cachet de l'établissement<br><br><br></div></div>
<table><thead><tr><th>Activités</th><th>Compétences</th>${MODALITES.map((m) => `<th>${esc(m.short)}</th>`).join("")}<th>Tâches des activités</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function wrapHtml(title: string, css: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}${css}</style></head><body>${body}</body></html>`;
}

export function synopticHtml(data: PassportData): string {
  return wrapHtml(`Passeport professionnel ${holderName(data)}`, SYNOPTIC_CSS, synopticBody(data));
}

/** Synoptique + fiches d'analyse validées (ou toutes) dans un seul document imprimable. */
export function dossierHtml(data: PassportData, onlyValidated: boolean): string {
  const fiches = data.situations
    .filter((s) => !onlyValidated || s.transfer)
    .sort((a, b) => a.id - b.id)
    .map((s) => `<section style="page-break-before:always">${ficheBody(data.holder, s)}</section>`)
    .join("");
  const css = `${SYNOPTIC_CSS.replace(/@page \{[^}]*\}/, "")}`;
  return wrapHtml(`Dossier E4 ${holderName(data)}`, css, synopticBody(data) + fiches);
}

export function stageHtml(data: PassportData, st: Stage): string {
  const h = data.holder;
  const row = (l: string, v: string) =>
    `<tr><th>${esc(l)}</th><td class="txt">${v ? escMultiline(v) : "&nbsp;"}</td></tr>`;
  const body = `<div class="head"><div><h1>ATTESTATION DE STAGE</h1><h2>BTS Gestion de la PME — unités U4 et U51</h2>
<div class="meta">À remettre au stagiaire à l'issue du stage</div></div></div>
<div class="band">Organisme d'accueil</div><table>${row("Nom ou dénomination sociale", st.organisme)}${row("Secteur d'activité", st.secteur)}${row("Adresse", st.adresse)}</table>
<div class="band">Le stagiaire</div><table>${row("Nom et prénom", `${h.nom.toUpperCase()} ${h.prenom}`.trim())}${row("Étudiant en BTS Gestion de la PME au sein de", h.etablissement)}</table>
<div class="band">Durée du stage</div><table>${row("Dates de début et de fin", st.debut || st.fin ? `Du ${st.debut || "…"} au ${st.fin || "…"}` : "")}${row("Durée totale (semaines)", st.semaines)}</table>
<div class="band">Missions confiées au stagiaire</div><table>${row("Missions relevant de l'épreuve E4 (Gérer les relations avec les clients et les fournisseurs)", st.missionsE4)}${row("Missions relevant de la sous-épreuve E51 (Participer à la gestion des risques de la PME)", st.missionsE51)}</table>
<div class="band">Gratification</div><table>${row("Montant total versé au stagiaire (€)", st.gratification)}</table>
<p style="font-size:8.5pt">La durée totale du stage est appréciée en tenant compte de la présence effective du stagiaire dans l'organisme (art. L.124-18 du code de l'éducation). Chaque période au moins égale à 7 heures de présence consécutives ou non équivaut à un jour de stage, et chaque période d'au moins 22 jours de présence à un mois.</p>
<p>Fait à ……………………… le ………………………<br><br>Nom, fonction et signature du représentant de l'organisme d'accueil${st.representant ? ` : ${esc(st.representant)}` : ""}</p>`;
  return wrapHtml("Attestation de stage", "", body);
}

export function contexteHtml(data: PassportData): string {
  const h = data.holder;
  const items = CONTEXTE_ITEMS.map((c, i) => {
    const it = data.contexte.find((x) => x.id === c.id);
    return `<div class="band">${i + 1}. ${esc(c.label)} ${it?.done ? "☒" : "☐"}</div><table><tr><td class="txt">${
      it?.notes ? escMultiline(it.notes) : "&nbsp;"
    }</td></tr></table>`;
  }).join("");
  return wrapHtml(
    "Contexte commercial",
    "",
    `<div class="head"><div><h1>BTS Gestion de la PME — Session ${esc(h.session)}</h1><h2>E4 — Présentation du contexte commercial</h2></div><div class="meta"><b>${esc(
      holderName(data),
    )}</b><br>N° de candidat : ${esc(h.numeroCandidat)}</div></div>${items}`,
  );
}

// ------------------------------------------------------------------ Word (.docx)

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function par(text: string, o: { bold?: boolean; size?: number; color?: string; center?: boolean } = {}): string {
  const rpr = `<w:rPr>${o.bold ? "<w:b/>" : ""}${o.color ? `<w:color w:val="${o.color}"/>` : ""}<w:sz w:val="${o.size ?? 14}"/><w:szCs w:val="${o.size ?? 14}"/></w:rPr>`;
  const runs = text
    .split("\n")
    .map((l, i) => `${i ? "<w:r><w:br/></w:r>" : ""}<w:r>${rpr}<w:t xml:space="preserve">${xml(l)}</w:t></w:r>`)
    .join("");
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/>${o.center ? '<w:jc w:val="center"/>' : ""}</w:pPr>${runs}</w:p>`;
}

function cell(
  content: string,
  w: number,
  o: { span?: number; vmerge?: "restart" | "continue"; fill?: string } = {},
): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${o.span ? `<w:gridSpan w:val="${o.span}"/>` : ""}${
    o.vmerge === "restart" ? '<w:vMerge w:val="restart"/>' : o.vmerge === "continue" ? "<w:vMerge/>" : ""
  }${o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : ""}</w:tcPr>${content || "<w:p/>"}</w:tc>`;
}

function docxPackage(body: string, landscape: boolean): Uint8Array {
  const sect = landscape
    ? '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="567" w:right="567" w:bottom="567" w:left="567" w:header="284" w:footer="284" w:gutter="0"/></w:sectPr>'
    : '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="851" w:right="851" w:bottom="851" w:left="851" w:header="284" w:footer="284" w:gutter="0"/></w:sectPr>';
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    "word/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="16"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`,
    ),
  };
  return zipSync(files, { level: 6 });
}

const BORDERS =
  '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="555555"/><w:left w:val="single" w:sz="4" w:color="555555"/><w:bottom w:val="single" w:sz="4" w:color="555555"/><w:right w:val="single" w:sz="4" w:color="555555"/><w:insideH w:val="single" w:sz="4" w:color="555555"/><w:insideV w:val="single" w:sz="4" w:color="555555"/></w:tblBorders>';

/** Document synoptique au format Word (paysage, tâches grisées). */
export function buildSynopticDocx(data: PassportData): Uint8Array {
  const h = data.holder;
  const W = [2300, 2300, 1350, 1350, 1350, 1350, 5700]; // total 15700
  const grid = `<w:tblGrid>${W.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
  const head =
    "<w:tr>" +
    ["Activités", "Compétences", ...MODALITES.map((m) => m.short), "Tâches des activités"]
      .map((t, i) => cell(par(t, { bold: true, center: true }), W[i], { fill: "E8EDF5" }))
      .join("") +
    "</w:tr>";
  const body = synopticRows(data)
    .map((r) => {
      if (r.kind === "domain")
        return `<w:tr>${cell(par(r.title, { bold: true, color: "FFFFFF" }), 15700, { span: 7, fill: "1A3A6E" })}</w:tr>`;
      const vm = r.first ? "restart" : "continue";
      const lead = [
        cell(r.first ? par(`Activité ${r.activity.id} — ${r.activity.title}`, { bold: true }) : "", W[0], {
          vmerge: vm,
          fill: "F3F5FA",
        }),
        cell(r.first ? par(r.activity.competence) : "", W[1], { vmerge: vm }),
        ...MODALITES.map((m, i) => {
          const txt = r.marks[m.id].join("\n");
          return cell(r.first && txt ? par(txt, { bold: true, center: true }) : "", W[2 + i], {
            vmerge: vm,
            fill: txt ? "E9F6EC" : undefined,
          });
        }),
      ].join("");
      const label = `T.${r.taskId} ${r.taskLabel}${r.sps.length ? ` (${r.sps.map(spLabel).join(", ")})` : ""}`;
      return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${lead}${cell(par(label), W[6], { fill: r.sps.length ? "C8C8C8" : undefined })}</w:tr>`;
    })
    .join("");
  const intro =
    par(`BTS Gestion de la PME — Session ${h.session} — Passeport professionnel`, { bold: true, size: 26 }) +
    par(
      `${holderName(data) || "Candidat"} — N° de candidat : ${h.numeroCandidat}\n${[h.etablissement, h.ville].filter(Boolean).join(", ")}${h.academie ? ` (académie de ${h.academie})` : ""}`,
      { size: 18 },
    ) +
    par(
      `L'équipe pédagogique${teachers(data).length ? ` (${teachers(data).join(", ")})` : ""} atteste que le titulaire de ce passeport professionnel a bien effectué, en formation, les activités et missions présentées dans ce tableau.${data.visa.date ? `\nVisé le ${data.visa.date}${data.visa.note ? ` — ${data.visa.note}` : ""}` : ""}\nSignatures des enseignants et cachet de l'établissement :`,
      { size: 16 },
    ) +
    par("", { size: 16 });
  return docxPackage(
    `${intro}<w:tbl><w:tblPr><w:tblW w:w="15700" w:type="dxa"/>${BORDERS}<w:tblLayout w:type="fixed"/></w:tblPr>${grid}${head}${body}</w:tbl>`,
    true,
  );
}

// ------------------------------------------------------------- sauvegarde JSON

export function backupJson(data: PassportData): string {
  return JSON.stringify({ format: "elium-passeport-gpme", exportedAt: new Date().toISOString(), data }, null, 2);
}

/** Lit une sauvegarde `backupJson` (ou un PassportData nu). */
export function parseBackup(text: string): unknown {
  const j = JSON.parse(text) as unknown;
  if (j && typeof j === "object" && (j as { format?: unknown }).format === "elium-passeport-gpme")
    return (j as { data: unknown }).data;
  return j;
}
