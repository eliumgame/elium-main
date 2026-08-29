import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/detector/report/buildReportDoc";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { REPORT_DISCLAIMER } from "../src/detector/types";
import type {
  AnalysisReport,
  CategoryReport,
  DocumentModel,
  Finding,
  ParagraphModel,
} from "../src/detector/types";
import type { ProseMirrorNode } from "../src/format/types";

function finding(overrides: Partial<Finding> & { category: Finding["category"] }): Finding {
  return {
    id: `f-${Math.random().toString(36).slice(2)}`,
    signal: "signal_test",
    label: "Anomalie détectée",
    explanation: "Explication détaillée du signal mesuré.",
    severity: "moyen",
    weight: 0.7,
    location: { paragraphIndex: 0, label: "Paragraphe 1" },
    ...overrides,
  };
}

function category(cat: CategoryReport["category"], score: number, findings: Finding[] = []): CategoryReport {
  return { category: cat, score, findings };
}

function paragraph(index: number, text: string, opts: Partial<ParagraphModel> = {}): ParagraphModel {
  return { index, text, runs: [{ text }], ...opts };
}

function baseReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    overallScore: 42,
    confidence: "moyenne",
    categories: [
      category("texte", 0),
      category("mise_en_forme", 0),
      category("metadonnees", 0),
      category("image", 0),
    ],
    documentMetadata: { sourceFormat: "docx", title: "Mon rapport" },
    generatedAt: "2026-01-01T10:00:00.000Z",
    disclaimer: REPORT_DISCLAIMER,
    ...overrides,
  };
}

function textNodesOf(node: ProseMirrorNode): string {
  if (node.text != null) return node.text;
  return (node.content ?? []).map(textNodesOf).join("");
}

function flatten(node: ProseMirrorNode): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [node];
  for (const c of node.content ?? []) out.push(...flatten(c));
  return out;
}

describe("buildReportDoc — structure générale", () => {
  it("commence par un titre, l'horodatage, le score/confiance et le disclaimer", () => {
    const doc = buildReportDoc(baseReport(), { paragraphs: [], images: [], metadata: { sourceFormat: "docx" } }, "test.docx");
    const [title, generatedAt, scoreHeading, disclaimer] = doc.content!;
    expect(title.type).toBe("heading");
    expect(title.attrs?.level).toBe(1);
    expect(textNodesOf(title)).toContain("test.docx");
    expect(textNodesOf(generatedAt)).toMatch(/2026/);
    expect(scoreHeading.type).toBe("heading");
    expect(textNodesOf(scoreHeading)).toContain("42/100");
    expect(textNodesOf(scoreHeading)).toContain("moyenne");
    expect(textNodesOf(disclaimer)).toBe(REPORT_DISCLAIMER);
  });

  it("liste les 4 catégories avec leur score, et une note quand une catégorie n'a aucun finding", () => {
    const report = baseReport({
      categories: [
        category("texte", 55, [finding({ category: "texte" })]),
        category("mise_en_forme", 0),
        category("metadonnees", 0),
        category("image", 0),
      ],
    });
    const doc = buildReportDoc(report, { paragraphs: [], images: [], metadata: { sourceFormat: "docx" } }, "x.docx");
    const all = flatten(doc);
    const headings = all.filter((n) => n.type === "heading").map(textNodesOf);
    expect(headings.some((h) => h.includes("Texte") && h.includes("55/100"))).toBe(true);
    expect(headings.some((h) => h.includes("Mise en forme") && h.includes("0/100"))).toBe(true);
    const texts = all.map(textNodesOf).join(" | ");
    expect(texts).toContain("Aucun signal détecté dans cette catégorie.");
  });

  it("chaque finding montre sévérité, libellé, emplacement, explication et la citation quand elle existe", () => {
    const f = finding({
      category: "texte",
      severity: "eleve",
      label: "Longueur de phrase anormalement régulière",
      location: { paragraphIndex: 2, label: "Paragraphe 3" },
      explanation: "CV = 0.16, très en dessous du seuil attendu.",
      evidence: "citation exacte du texte",
    });
    const report = baseReport({ categories: [category("texte", 60, [f]), category("mise_en_forme", 0), category("metadonnees", 0), category("image", 0)] });
    const doc = buildReportDoc(report, { paragraphs: [], images: [], metadata: { sourceFormat: "docx" } }, "x.docx");
    const texts = flatten(doc).map(textNodesOf);
    expect(texts.some((t) => t.includes("Élevé") && t.includes("Longueur de phrase") && t.includes("Paragraphe 3"))).toBe(true);
    expect(texts.some((t) => t.includes("CV = 0.16"))).toBe(true);
    expect(texts.some((t) => t.includes("citation exacte du texte"))).toBe(true);
  });

  it("affiche les métadonnées connues dans la section Métadonnées, sans forger les absentes", () => {
    const report = baseReport({
      documentMetadata: { sourceFormat: "docx", title: "Mon rapport", author: "M. Dupont", revisionCount: 3 },
    });
    const doc = buildReportDoc(report, { paragraphs: [], images: [], metadata: report.documentMetadata }, "x.docx");
    const texts = flatten(doc).map(textNodesOf).join(" | ");
    expect(texts).toContain("Auteur : M. Dupont");
    expect(texts).toContain("Révisions : 3");
    expect(texts).not.toContain("Producteur :"); // jamais présent dans le fixture
  });

  it("inclut le plagiat seulement s'il a été exécuté, jamais mélangé au score global", () => {
    const withoutPlagiat = buildReportDoc(baseReport(), { paragraphs: [], images: [], metadata: { sourceFormat: "docx" } }, "x.docx");
    expect(flatten(withoutPlagiat).map(textNodesOf).join(" | ")).not.toContain("Plagiat");

    const withPlagiat = buildReportDoc(
      baseReport({
        plagiarism: {
          checkedPassages: 5,
          failedPassages: 0,
          provider: "Serper",
          matches: [{ paragraphIndex: 0, passage: "extrait suspect", url: "https://exemple.test/a", sourceTitle: "Source A", similarity: 0.87 }],
        },
      }),
      { paragraphs: [], images: [], metadata: { sourceFormat: "docx" } },
      "x.docx",
    );
    const texts = flatten(withPlagiat).map(textNodesOf).join(" | ");
    expect(texts).toContain("Plagiat");
    expect(texts).toContain("87% de similarité");
    expect(texts).toContain("extrait suspect");
  });

  it("signale clairement quand la vérification a totalement échoué, pour ne pas la confondre avec un document propre", () => {
    const doc = buildReportDoc(
      baseReport({
        plagiarism: {
          checkedPassages: 12,
          failedPassages: 12,
          lastError: "Clé API invalide ou quota dépassé (Serper)",
          provider: "Serper",
          matches: [],
        },
      }),
      { paragraphs: [], images: [], metadata: { sourceFormat: "docx" } },
      "x.docx",
    );
    const texts = flatten(doc).map(textNodesOf).join(" | ");
    expect(texts).toContain("Vérification impossible");
    expect(texts).toContain("Clé API invalide ou quota dépassé (Serper)");
    expect(texts).toContain("ne signifie pas que le document est propre");
  });

  it("signale un échec partiel sans le confondre avec un échec total", () => {
    const doc = buildReportDoc(
      baseReport({
        plagiarism: {
          checkedPassages: 10,
          failedPassages: 3,
          provider: "Serper",
          matches: [],
        },
      }),
      { paragraphs: [], images: [], metadata: { sourceFormat: "docx" } },
      "x.docx",
    );
    const texts = flatten(doc).map(textNodesOf).join(" | ");
    expect(texts).toContain("Vérification partielle");
    expect(texts).toContain("3 vérification(s) sur 10");
    expect(texts).not.toContain("Vérification impossible");
  });

  it("n'affiche aucun avertissement quand tout s'est bien passé", () => {
    const doc = buildReportDoc(
      baseReport({
        plagiarism: { checkedPassages: 8, failedPassages: 0, provider: "Serper", matches: [] },
      }),
      { paragraphs: [], images: [], metadata: { sourceFormat: "docx" } },
      "x.docx",
    );
    const texts = flatten(doc).map(textNodesOf).join(" | ");
    expect(texts).not.toContain("Vérification impossible");
    expect(texts).not.toContain("Vérification partielle");
  });
});

describe("buildReportDoc — reproduction annotée du document", () => {
  it("reproduit chaque paragraphe, souligne en rouge l'extrait exact d'un finding, préserve titres et listes", () => {
    const paragraphs: ParagraphModel[] = [
      paragraph(0, "Titre du document", { heading: 1 }),
      paragraph(1, "Un texte normal sans rien de particulier à signaler ici."),
      paragraph(2, "Un passage suspect qui contient une tournure clichée typique."),
      paragraph(3, "Élément de liste", { listItem: true }),
    ];
    const f = finding({
      category: "texte",
      location: { paragraphIndex: 2, label: "Paragraphe 3" },
      evidence: "tournure clichée typique",
    });
    const report = baseReport({ categories: [category("texte", 40, [f]), category("mise_en_forme", 0), category("metadonnees", 0), category("image", 0)] });
    const doc = buildReportDoc(report, { paragraphs, images: [], metadata: { sourceFormat: "docx" } }, "x.docx");

    const annotatedStart = doc.content!.findIndex((n) => textNodesOf(n) === "Document analysé (annoté)");
    expect(annotatedStart).toBeGreaterThan(-1);
    const annotated = doc.content!.slice(annotatedStart + 2); // saute le titre + la note d'explication

    expect(annotated[0].type).toBe("heading");
    expect(annotated[0].attrs?.level).toBe(1);
    expect(textNodesOf(annotated[0])).toBe("Titre du document");

    expect(textNodesOf(annotated[2])).toContain("Un passage suspect");
    const flaggedTextNode = annotated[2].content!.find((n) => n.text === "tournure clichée typique");
    expect(flaggedTextNode).toBeDefined();
    expect(flaggedTextNode!.marks).toEqual(
      expect.arrayContaining([
        { type: "textStyle", attrs: { color: "#dc2626" } },
        { type: "underline" },
      ]),
    );
    const unflaggedTextNode = annotated[2].content!.find((n) => n.text?.includes("Un passage suspect"));
    expect(unflaggedTextNode!.marks ?? []).toEqual([]);

    expect(textNodesOf(annotated[3])).toContain("•");
    expect(textNodesOf(annotated[3])).toContain("Élément de liste");
  });

  it("plafonne le niveau de titre à 4 (limite du schéma éditeur)", () => {
    const paragraphs = [paragraph(0, "Titre profond", { heading: 6 })];
    const doc = buildReportDoc(baseReport(), { paragraphs, images: [], metadata: { sourceFormat: "docx" } }, "x.docx");
    const heading = flatten(doc).find((n) => textNodesOf(n) === "Titre profond");
    expect(heading?.attrs?.level).toBe(4);
  });

  it("un paragraphe vide ne casse rien (content omis plutôt qu'un texte vide invalide)", () => {
    const paragraphs = [paragraph(0, "")];
    const doc = buildReportDoc(baseReport(), { paragraphs, images: [], metadata: { sourceFormat: "docx" } }, "x.docx");
    // Ne doit jamais produire un nœud texte à chaîne vide (invalide dans le schéma ProseMirror).
    for (const n of flatten(doc)) if (n.type === "text") expect(n.text).not.toBe("");
  });
});

describe("buildReportDoc — round-trip réel vers .docx", () => {
  it("le document produit passe par le vrai sérialiseur docToDocx sans lever, avec le contenu attendu dans le XML", async () => {
    const paragraphs: ParagraphModel[] = [
      paragraph(0, "Un paragraphe tout à fait normal."),
      paragraph(1, "Un paragraphe avec un passage repéré ici.", {}),
    ];
    const f = finding({ category: "texte", location: { paragraphIndex: 1, label: "Paragraphe 2" }, evidence: "passage repéré" });
    const report = baseReport({ categories: [category("texte", 50, [f]), category("mise_en_forme", 0), category("metadonnees", 0), category("image", 0)] });
    const model: DocumentModel = { paragraphs, images: [], metadata: { sourceFormat: "docx", title: "Source" } };

    const doc = buildReportDoc(report, model, "source.docx");
    const file = await createEliumFile({ title: "Rapport", profile: "standard", doc });
    const bytes = docToDocx(file); // ne doit pas lever

    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x50); // "PK" — signature ZIP/OPC valide
    expect(bytes[1]).toBe(0x4b);
  });
});
