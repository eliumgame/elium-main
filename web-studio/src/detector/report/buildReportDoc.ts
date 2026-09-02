/**
 * Construit le rapport d'analyse comme un document ProseMirror — le même
 * format que l'éditeur natif, ce qui permet de le faire passer tel quel dans
 * `docToDocx`/`exportPdf` (déjà utilisés partout ailleurs dans l'app pour
 * l'export .docx/PDF d'un document texte) au lieu de réinventer un moteur de
 * mise en page. Contient le score/la confiance/le disclaimer, chaque
 * catégorie avec ses points relevés, le plagiat le cas échéant, puis une
 * reproduction intégrale du document analysé où les passages repérés sont
 * soulignés en rouge — le même principe que `DocumentPreview.tsx`, mais en
 * un document imprimable/éditable plutôt qu'un panneau à l'écran.
 *
 * Reproduction volontairement simplifiée : seule la structure de bloc
 * (titre/paragraphe/liste) est reconstituée, pas la mise en forme d'origine
 * caractère par caractère (gras/italique/police) — l'objectif de cette
 * annexe est de montrer QUOI a été repéré et OÙ, pas de ré-éditer le
 * document à l'identique.
 */
import type { ProseMirrorNode } from "../../format/types";
import {
  CATEGORY_TITLES,
  buildPreviewFlags,
  confidenceExplanation,
  severityLabel,
  sortedFindings,
} from "../reportPresentation";
import { flagsByParagraph, segmentParagraph, type PreviewFlag } from "../ui/previewFlags";
import type {
  AnalysisReport,
  DocumentMetadata,
  DocumentModel,
  Finding,
  ParagraphModel,
  PlagiarismMatch,
} from "../types";

const FLAG_COLOR = "#dc2626";

function heading(level: number, text: string): ProseMirrorNode {
  return { type: "heading", attrs: { level }, content: text ? [{ type: "text", text }] : undefined };
}

function paragraph(text: string, opts?: { italic?: boolean; muted?: boolean }): ProseMirrorNode {
  if (!text) return { type: "paragraph" };
  const marks: Array<{ type: string; attrs?: Record<string, unknown> }> = [];
  if (opts?.italic) marks.push({ type: "italic" });
  if (opts?.muted) marks.push({ type: "textStyle", attrs: { color: "#6b7280" } });
  return { type: "paragraph", content: [{ type: "text", text, ...(marks.length ? { marks } : {}) }] };
}

function bold(text: string): ProseMirrorNode["content"] {
  return [{ type: "text", text, marks: [{ type: "bold" }] }];
}

function findingBlock(f: Finding): ProseMirrorNode[] {
  const blocks: ProseMirrorNode[] = [
    {
      type: "paragraph",
      content: [
        ...bold(`[${severityLabel(f.severity)}] `)!,
        { type: "text", text: `${f.label} — ${f.location.label}` },
      ],
    },
    paragraph(f.explanation),
  ];
  if (f.evidence) blocks.push(paragraph(`« ${f.evidence} »`, { italic: true, muted: true }));
  return blocks;
}

function metadataParagraphs(meta: DocumentMetadata): ProseMirrorNode[] {
  const rows: [string, string][] = [];
  if (meta.title) rows.push(["Titre", meta.title]);
  if (meta.author) rows.push(["Auteur", meta.author]);
  if (meta.creator) rows.push(["Application créatrice", meta.creator]);
  if (meta.producer) rows.push(["Producteur", meta.producer]);
  if (meta.createdAt) rows.push(["Créé le", new Date(meta.createdAt).toLocaleString("fr-FR")]);
  if (meta.modifiedAt) rows.push(["Modifié le", new Date(meta.modifiedAt).toLocaleString("fr-FR")]);
  if (meta.editingMinutes != null) rows.push(["Temps d'édition cumulé", `${meta.editingMinutes} min`]);
  if (meta.revisionCount != null) rows.push(["Révisions", String(meta.revisionCount)]);
  if (meta.pageCount != null) rows.push(["Pages", String(meta.pageCount)]);
  if (rows.length === 0) return [];
  return rows.map(([k, v]) => ({ type: "paragraph", content: [...bold(`${k} : `)!, { type: "text", text: v }] }));
}

function plagiarismMatchBlock(m: PlagiarismMatch): ProseMirrorNode[] {
  return [
    {
      type: "paragraph",
      content: [
        ...bold(`${Math.round(m.similarity * 100)}% de similarité — `)!,
        { type: "text", text: m.sourceTitle || m.url, marks: [{ type: "link", attrs: { href: m.url } }] },
      ],
    },
    paragraph(`« ${m.passage} »`, { italic: true, muted: true }),
  ];
}

/** Reconstitue un paragraphe/titre du document analysé, en soulignant en
 *  rouge les segments que `segmentParagraph` identifie comme repérés — même
 *  logique que `DocumentPreview.tsx`, appliquée à un `text` qui reste sans
 *  frontières de run puisque la fidélité de mise en forme d'origine n'est pas
 *  reproduite ici (voir le commentaire d'en-tête du fichier). */
function annotatedParagraphNode(p: ParagraphModel, flags: PreviewFlag[]): ProseMirrorNode {
  const segments = flags.length > 0 ? segmentParagraph(p.text, flags) : [{ text: p.text, flagged: false as const }];
  const content = segments
    .filter((s) => s.text)
    .map((s) => ({
      type: "text",
      text: s.text,
      ...(s.flagged ? { marks: [{ type: "textStyle", attrs: { color: FLAG_COLOR } }, { type: "underline" }] } : {}),
    }));
  const prefix = p.listItem ? "•  " : "";
  if (prefix && content.length > 0) content[0] = { ...content[0], text: prefix + content[0].text };
  else if (prefix) content.push({ type: "text", text: prefix.trimEnd() });

  const node: ProseMirrorNode = {
    type: p.heading ? "heading" : "paragraph",
    content: content.length ? content : undefined,
  };
  if (p.heading) node.attrs = { level: Math.min(p.heading, 4) };
  return node;
}

export function buildReportDoc(report: AnalysisReport, model: DocumentModel, fileName: string): ProseMirrorNode {
  const content: ProseMirrorNode[] = [];

  content.push(heading(1, `Rapport Détecteur — ${fileName}`));
  content.push(paragraph(`Généré le ${new Date(report.generatedAt).toLocaleString("fr-FR")}`, { muted: true }));
  content.push(heading(2, `Score global : ${report.overallScore}/100 — Confiance : ${report.confidence}`));
  content.push(paragraph(report.disclaimer, { italic: true }));
  content.push(paragraph(confidenceExplanation(report.confidence), { muted: true }));

  for (const cat of report.categories) {
    content.push(heading(2, `${CATEGORY_TITLES[cat.category]} — score ${cat.score}/100`));
    if (cat.category === "metadonnees") content.push(...metadataParagraphs(report.documentMetadata));
    const findings = sortedFindings(cat.findings);
    if (findings.length === 0) content.push(paragraph("Aucun signal détecté dans cette catégorie.", { muted: true }));
    for (const f of findings) content.push(...findingBlock(f));
  }

  if (report.plagiarism) {
    const { checkedPassages, failedPassages, lastError, matches: plagiarismMatches, provider } = report.plagiarism;
    const allFailed = failedPassages > 0 && failedPassages === checkedPassages;
    const somePassagesFailed = failedPassages > 0 && !allFailed;

    content.push(heading(2, `${CATEGORY_TITLES.plagiat}`));
    if (allFailed) {
      content.push({
        type: "paragraph",
        content: [
          ...bold(
            `[Vérification impossible] Les ${failedPassages} tentative(s) ont toutes échoué${lastError ? ` (${lastError})` : ""}. `,
          )!,
          {
            type: "text",
            text: "« Aucune correspondance » ci-dessous ne signifie pas que le document est propre : il n'a en réalité pas pu être vérifié.",
          },
        ],
      });
    } else if (somePassagesFailed) {
      content.push({
        type: "paragraph",
        content: bold(
          `[Vérification partielle] ${failedPassages} vérification(s) sur ${checkedPassages} ont échoué${lastError ? ` (${lastError})` : ""} et ne sont pas prises en compte ci-dessous.`,
        ),
      });
    }
    content.push(
      paragraph(
        `${checkedPassages} passage(s) vérifié(s), ${plagiarismMatches.length} correspondance(s) trouvée(s) via ${provider}.`,
      ),
    );
    if (plagiarismMatches.length === 0) {
      content.push(paragraph("Aucune correspondance trouvée sur le web.", { muted: true }));
    }
    for (const m of plagiarismMatches) content.push(...plagiarismMatchBlock(m));
  }

  content.push(heading(1, "Document analysé (annoté)"));
  content.push(
    paragraph(
      "Les passages soulignés en rouge correspondent aux points relevés ci-dessus. La mise en forme d'origine (police, gras, italique) n'est pas reproduite ici — seul le texte et sa structure (titres, listes) le sont.",
      { muted: true },
    ),
  );
  const flagsByPara = flagsByParagraph(buildPreviewFlags(report));
  for (const p of model.paragraphs) {
    content.push(annotatedParagraphNode(p, flagsByPara.get(p.index) ?? []));
  }

  return { type: "doc", content };
}
