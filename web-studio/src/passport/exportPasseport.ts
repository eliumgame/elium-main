/**
 * Exports du passeport : document synoptique (annexe V-2 — Word et PDF), dossier
 * complet (synoptique + toutes les fiches), attestation de stage pré-remplie et
 * sauvegarde JSON complète (réimportable).
 */
import { strToU8, zipSync } from "fflate";
import { FICHE_CSS, PRINT_CSS } from "./exportFiche";
import { CONTEXTE_ITEMS, MODALITES, REFERENTIEL, coveredTasks, passportCells } from "./model";
import { esc, escMultiline } from "./print";
import type { Modalite, PassportData, RefActivity, Stage } from "./types";

// ------------------------------------------------------------ données communes

export interface SynopticOptions {
  /** Tous les domaines du référentiel (E51, RH, soutien) ; par défaut seul le domaine 1 (épreuve E4). */
  allDomains?: boolean;
}

export interface SynopticRow {
  domainId: string;
  domainTitle: string;
  /** Première ligne du domaine : porte la bande verticale. */
  firstOfDomain: boolean;
  /** Nombre total de lignes (tâches) du domaine. */
  domainSpan: number;
  activity: RefActivity;
  /** Libellé officiel de l'activité (« Activité_1.1._Recherche_de_clientèle_et_contact »). */
  activityLabel: string;
  /** Première ligne de l'activité (porte les cellules fusionnées). */
  first: boolean;
  span: number;
  taskId: string;
  taskLabel: string;
  /** Situations validées qui mobilisent cette tâche (grisée si non vide). */
  sps: number[];
  /** « Solutions logicielles et fonctionnalités » saisies pour l'activité. */
  solutions: string;
  /** Identifiants des situations par modalité (« GRCF 2 ; CE2 »). */
  marks: Record<Modalite, string>;
}

/** Libellé de l'activité tel qu'il apparaît dans le passeport officiel (underscores du classeur). */
export const activityLabelOf = (a: RefActivity): string => `Activité_${a.id}._${a.title.replace(/[\s’']+/g, "_")}`;

/** Lignes du passeport synoptique : une par tâche, activités regroupées par domaine. */
export function synopticRows(
  data: Pick<PassportData, "situations"> & { solutions?: Record<string, string> },
  opts: SynopticOptions = {},
): SynopticRow[] {
  const cells = passportCells(data);
  const tasks = coveredTasks(data);
  const rows: SynopticRow[] = [];
  for (const d of opts.allDomains ? REFERENTIEL : REFERENTIEL.slice(0, 1)) {
    const domainSpan = d.activities.reduce((n, a) => n + a.tasks.length, 0);
    let firstOfDomain = true;
    for (const a of d.activities) {
      const marks = {} as Record<Modalite, string>;
      for (const m of MODALITES) {
        const codes = (cells.get(`${a.id}|${m.id}`) ?? []).flatMap((x) => x.code.split(" ; "));
        marks[m.id] = [...new Set(codes)].join(" ; ");
      }
      a.tasks.forEach((t, i) => {
        rows.push({
          domainId: d.id,
          domainTitle: d.title,
          firstOfDomain,
          domainSpan,
          activity: a,
          activityLabel: activityLabelOf(a),
          first: i === 0,
          span: a.tasks.length,
          taskId: t.id,
          taskLabel: t.label,
          sps: tasks.get(t.id) ?? [],
          solutions: data.solutions?.[a.id] ?? "",
          marks,
        });
        firstOfDomain = false;
      });
    }
  }
  return rows;
}

export const fmtDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

const holderName = (data: PassportData) => `${data.holder.nom.toUpperCase()} ${data.holder.prenom}`.trim();
const teachers = (data: PassportData) => [data.holder.enseignant1, data.holder.enseignant2].filter(Boolean);

// -------------------------------------------------------------------- HTML/PDF

function wrapHtml(title: string, css: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}${FICHE_CSS}${css}</style></head><body>${body}</body></html>`;
}

export function stageHtml(data: PassportData, st: Stage): string {
  const h = data.holder;
  const row = (l: string, v: string) =>
    `<tr><th>${esc(l)}</th><td class="txt">${v ? escMultiline(v) : "&nbsp;"}</td></tr>`;
  const body = `<div class="head"><div><h1>ATTESTATION DE STAGE</h1><h2>BTS Gestion de la PME — unités U4 et U51</h2>
<div class="meta">À remettre au stagiaire à l'issue du stage</div></div></div>
<div class="band">Organisme d'accueil</div><table>${row("Nom ou dénomination sociale", st.organisme)}${row("Secteur d'activité", st.secteur)}${row("Adresse", st.adresse)}</table>
<div class="band">Le stagiaire</div><table>${row("Nom et prénom", `${h.nom.toUpperCase()} ${h.prenom}`.trim())}${row("Étudiant en BTS Gestion de la PME au sein de", h.etablissement)}</table>
<div class="band">Durée du stage</div><table>${row("Dates de début et de fin", st.debut || st.fin ? `Du ${fmtDate(st.debut) || "…"} au ${fmtDate(st.fin) || "…"}` : "")}${row("Durée totale (semaines)", st.semaines)}</table>
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

/** Document synoptique au format Word (A4 paysage) : même structure que le PDF et le passeport officiel. */
export function buildSynopticDocx(data: PassportData, opts: SynopticOptions = {}): Uint8Array {
  const h = data.holder;
  const W = [400, 2700, 1500, 1000, 800, 1000, 800, 1300, 6204]; // total 15704
  const TOTAL = W.reduce((a, b) => a + b, 0);
  const grid = `<w:tblGrid>${W.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
  const span = (from: number, n: number) => W.slice(from, from + n).reduce((a, b) => a + b, 0);
  const hc = (txt: string, i: number, o: { n?: number; vm?: "restart" | "continue"; left?: boolean } = {}) =>
    cell(txt ? par(txt, { bold: true, center: !o.left, size: 13 }) : "", span(i, o.n ?? 1), {
      span: o.n,
      vmerge: o.vm,
    });
  const head =
    "<w:tr>" +
    hc("", 0, { vm: "restart" }) +
    hc("", 1) +
    hc("", 2) +
    hc("SITUATIONS VÉCUES OU OBSERVÉES ▸", 3) +
    hc("Avant la formation", 4) +
    hc("Pendant la formation en établissement", 5) +
    hc("Pendant la formation dans une PME", 6) +
    hc("Pendant la formation dans une organisation", 7) +
    hc("Tâches des activités", 8, { vm: "restart" }) +
    "</w:tr><w:tr>" +
    hc("", 0, { vm: "continue" }) +
    hc("ACTIVITÉS ▸", 1, { left: true }) +
    hc("SOLUTIONS LOGICIELLES ET FONCTIONNALITÉS", 2) +
    hc("COMPÉTENCES ▾", 3) +
    hc("Périodes (Situations Professionnelles)", 4, { n: 4 }) +
    hc("", 8, { vm: "continue" }) +
    "</w:tr>";
  const band = (r: SynopticRow, first: boolean) =>
    first
      ? `<w:tc><w:tcPr><w:tcW w:w="${W[0]}" w:type="dxa"/><w:vMerge w:val="restart"/><w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/><w:textDirection w:val="btLr"/><w:vAlign w:val="center"/></w:tcPr>${par(`DOMAINE D’ACTIVITÉS ${r.domainId} : ${r.domainTitle}`, { bold: true, center: true, size: 12 })}</w:tc>`
      : `<w:tc><w:tcPr><w:tcW w:w="${W[0]}" w:type="dxa"/><w:vMerge/><w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/></w:tcPr><w:p/></w:tc>`;
  const body = synopticRows(data, opts)
    .map((r) => {
      const vm = r.first ? "restart" : "continue";
      const lead = [
        cell(r.first ? par(r.activityLabel, { size: 12 }) : "", W[1], { vmerge: vm }),
        cell(r.first && r.solutions.trim() ? par(r.solutions, { size: 16 }) : "", W[2], { vmerge: vm }),
        cell(r.first ? par(r.activity.competence, { size: 11 }) : "", W[3], { vmerge: vm }),
        ...MODALITES.map((m, i) =>
          cell(r.first && r.marks[m.id] ? par(r.marks[m.id], { size: 16 }) : "", W[4 + i], { vmerge: vm }),
        ),
      ].join("");
      const label = `T.${r.taskId}. ${r.taskLabel}`;
      return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${band(r, r.firstOfDomain)}${lead}${cell(par(label, { size: 11 }), W[8], { fill: r.sps.length ? "D9D9D9" : undefined })}</w:tr>`;
    })
    .join("");
  const idTable =
    `<w:tbl><w:tblPr><w:tblW w:w="${TOTAL}" w:type="dxa"/>${BORDERS}<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="400"/><w:gridCol w:w="${TOTAL - 400 - W[8]}"/><w:gridCol w:w="${W[8]}"/></w:tblGrid>` +
    `<w:tr>${cell("", 400)}${cell(par(`BTS GESTION DE LA PME - SESSION ${h.session} - PASSEPORT PROFESSIONNEL`, { bold: true, center: true, size: 24 }), TOTAL - 400, { span: 2 })}</w:tr>` +
    `<w:tr>${cell("", 400)}${cell(par("NOM et Prénom du titulaire du passeport :", { bold: true, center: true, size: 18 }), TOTAL - 400 - W[8])}${cell(par("Numéro du candidat :", { bold: true, center: true, size: 16 }), W[8])}</w:tr></w:tbl>` +
    par(`${holderName(data)}\t\t\t${h.numeroCandidat.trim() || "À compléter"}`, { size: 18 }) +
    `<w:tbl><w:tblPr><w:tblW w:w="${TOTAL}" w:type="dxa"/>${BORDERS}<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="400"/><w:gridCol w:w="${TOTAL - 400 - W[8]}"/><w:gridCol w:w="${W[8]}"/></w:tblGrid>` +
    `<w:tr>${cell("", 400)}${cell(
      par("L'équipe pédagogique représentée par les enseignants, en lycée ou centre de formation :", {
        bold: true,
        center: true,
        size: 18,
      }) +
        (teachers(data).length ? par(teachers(data).join(", "), { center: true, size: 17 }) : "") +
        par(
          "atteste que le titulaire de ce passeport professionnel a bien effectué, en formation, les activités et missions présentées dans ce tableau.",
          { bold: true, center: true, size: 18 },
        ) +
        (data.visa.date
          ? par(`Visé le ${fmtDate(data.visa.date)}${data.visa.note ? ` — ${data.visa.note}` : ""}`, {
              center: true,
              size: 16,
            })
          : ""),
      TOTAL - 400 - W[8],
    )}${cell(par("Signatures des enseignants de l'équipe pédagogique\net cachet de l'établissement", { bold: true, center: true, size: 18 }), W[8])}</w:tr></w:tbl>` +
    par("", { size: 10 });
  return docxPackage(
    `${idTable}<w:tbl><w:tblPr><w:tblW w:w="${TOTAL}" w:type="dxa"/>${BORDERS}<w:tblLayout w:type="fixed"/></w:tblPr>${grid}${head}${body}</w:tbl>`,
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
