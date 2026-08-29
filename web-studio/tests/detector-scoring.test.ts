import { describe, it, expect } from "vitest";
import { computeReport, type FindingsByCategory, type ScoringDocumentModel } from "../src/detector/scoring";
import type { DocumentMetadata, Finding, ParagraphModel, PlagiarismScanResult, SignalCategory, SignalSeverity } from "../src/detector/types";
import { REPORT_DISCLAIMER } from "../src/detector/types";

const metadata: DocumentMetadata = { sourceFormat: "docx", title: "Rapport annuel", author: "M. Dupont" };

function makeFinding(overrides: Partial<Finding> & { category: SignalCategory }): Finding {
  return {
    id: `f-${Math.random().toString(36).slice(2)}-${overrides.signal ?? "x"}`,
    signal: "signal_test",
    label: "Anomalie détectée",
    explanation: "Valeur mesurée hors norme.",
    severity: "moyen",
    weight: 0.7,
    location: { paragraphIndex: 0, label: "Paragraphe 1" },
    ...overrides,
  };
}

function paragraphsOfWords(count: number, words: number): ParagraphModel[] {
  const text = Array.from({ length: words }, (_, i) => `mot${i}`).join(" ");
  return Array.from({ length: count }, (_, i) => ({ index: i, text, runs: [{ text }] }));
}

function emptyFindings(): FindingsByCategory {
  return { texte: [], mise_en_forme: [], metadonnees: [], image: [] };
}

const baseModel = (paragraphs: ParagraphModel[]): ScoringDocumentModel => ({
  paragraphs,
  images: [],
  metadata,
});

describe("computeReport — cas vide", () => {
  it("toutes les catégories sont présentes à score 0, overallScore à 0, disclaimer présent", () => {
    const model = baseModel(paragraphsOfWords(10, 30));
    const report = computeReport(model, emptyFindings(), undefined, "2026-08-28T10:00:00.000Z");

    expect(report.categories).toHaveLength(4);
    const byCat = Object.fromEntries(report.categories.map((c) => [c.category, c]));
    expect(byCat.texte.score).toBe(0);
    expect(byCat.mise_en_forme.score).toBe(0);
    expect(byCat.metadonnees.score).toBe(0);
    expect(byCat.image.score).toBe(0);
    expect(byCat.texte.findings).toEqual([]);
    expect(report.overallScore).toBe(0);
    expect(report.disclaimer).toBe(REPORT_DISCLAIMER);
    expect(report.plagiarism).toBeUndefined();
    expect(report.documentMetadata).toBe(metadata);
    expect(report.generatedAt).toBe("2026-08-28T10:00:00.000Z");
  });
});

describe("computeReport — sévérité 'info' n'a aucun poids", () => {
  it("des findings 'info', même avec un poids élevé, donnent un score de catégorie à 0", () => {
    const findings = emptyFindings();
    findings.texte = [
      makeFinding({
        category: "texte",
        signal: "vocabulaire_varie",
        severity: "info",
        weight: 1,
        explanation: "Richesse lexicale dans la moyenne observée.",
      }),
    ];
    const model = baseModel(paragraphsOfWords(10, 30));
    const report = computeReport(model, findings, undefined, "2026-08-28T10:00:00.000Z");
    const texte = report.categories.find((c) => c.category === "texte")!;
    expect(texte.score).toBe(0);
    expect(report.overallScore).toBe(0);
  });
});

describe("computeReport — findings 'eleve' élèvent le score sans le saturer immédiatement", () => {
  const findings = emptyFindings();
  findings.texte = [
    makeFinding({
      category: "texte",
      signal: "burstiness_faible",
      severity: "eleve",
      weight: 0.7,
      label: "Longueur de phrase anormalement régulière",
      explanation: "Écart-type de la longueur des phrases de 1.8 mots (attendu : 6-10 mots pour un texte humain).",
      location: { paragraphIndex: 2, label: "Paragraphe 3" },
      evidence: "Cette solution permet d'optimiser. Cette approche permet d'améliorer. Cette méthode permet de renforcer.",
    }),
    makeFinding({
      category: "texte",
      signal: "transitions_stock",
      severity: "eleve",
      weight: 0.8,
      label: "Usage excessif de connecteurs stéréotypés",
      explanation: "12 occurrences de connecteurs type « en conclusion », « il est important de noter » pour 300 mots.",
      location: { paragraphIndex: 5, label: "Paragraphe 6" },
    }),
    makeFinding({
      category: "texte",
      signal: "perplexite_basse",
      severity: "eleve",
      weight: 0.9,
      label: "Perplexité lexicale anormalement basse",
      explanation: "Score de perplexité de 12.4 (seuil habituel humain > 35).",
      location: { paragraphIndex: 8, label: "Paragraphe 9" },
    }),
  ];

  const model = baseModel(paragraphsOfWords(30, 200));
  const report = computeReport(model, findings, undefined, "2026-08-28T10:00:00.000Z");
  const texte = report.categories.find((c) => c.category === "texte")!;

  it("le score de la catégorie texte est élevé mais strictement sous 100", () => {
    expect(texte.score).toBeGreaterThan(70);
    expect(texte.score).toBeLessThan(100);
  });

  it("deux findings 'eleve' seuls ne suffisent pas à saturer à 100", () => {
    const two = emptyFindings();
    two.texte = findings.texte.slice(0, 2);
    const r = computeReport(model, two, undefined, "2026-08-28T10:00:00.000Z");
    const t = r.categories.find((c) => c.category === "texte")!;
    expect(t.score).toBeLessThan(90);
    expect(t.score).toBeGreaterThan(30);
  });

  it("overallScore est significativement élevé (poids texte 0.45) mais reste sous 100", () => {
    expect(report.overallScore).toBeGreaterThan(25);
    expect(report.overallScore).toBeLessThan(60);
  });

  it("les autres catégories, sans findings, restent à 0 et n'affectent que par leur poids nul", () => {
    const mef = report.categories.find((c) => c.category === "mise_en_forme")!;
    const meta = report.categories.find((c) => c.category === "metadonnees")!;
    const img = report.categories.find((c) => c.category === "image")!;
    expect(mef.score).toBe(0);
    expect(meta.score).toBe(0);
    expect(img.score).toBe(0);
  });

  it("le score croît de façon monotone avec davantage de findings 'eleve'", () => {
    const one = emptyFindings();
    one.texte = findings.texte.slice(0, 1);
    const twoF = emptyFindings();
    twoF.texte = findings.texte.slice(0, 2);
    const threeF = emptyFindings();
    threeF.texte = findings.texte.slice(0, 3);

    const s1 = computeReport(model, one, undefined, "x").categories.find((c) => c.category === "texte")!.score;
    const s2 = computeReport(model, twoF, undefined, "x").categories.find((c) => c.category === "texte")!.score;
    const s3 = computeReport(model, threeF, undefined, "x").categories.find((c) => c.category === "texte")!.score;
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
    expect(s3).toBeLessThan(100);
  });
});

describe("computeReport — toutes catégories combinées pèsent correctement", () => {
  it("les 4 catégories contribuent selon leur poids (texte 0.45, mise_en_forme 0.20, metadonnees 0.15, image 0.20)", () => {
    const findings = emptyFindings();
    const highSeverity = (category: SignalCategory, signal: string): Finding =>
      makeFinding({ category, signal, severity: "eleve", weight: 1, location: { label: "Document" } });
    findings.texte = [highSeverity("texte", "s1"), highSeverity("texte", "s2"), highSeverity("texte", "s3")];
    findings.mise_en_forme = [highSeverity("mise_en_forme", "s1"), highSeverity("mise_en_forme", "s2"), highSeverity("mise_en_forme", "s3")];
    findings.metadonnees = [highSeverity("metadonnees", "s1"), highSeverity("metadonnees", "s2"), highSeverity("metadonnees", "s3")];
    findings.image = [highSeverity("image", "s1"), highSeverity("image", "s2"), highSeverity("image", "s3")];

    const model = baseModel(paragraphsOfWords(30, 200));
    const report = computeReport(model, findings, undefined, "x");
    // Identical raw findings per category => identical category scores.
    const scores = report.categories.map((c) => c.score);
    expect(new Set(scores).size).toBe(1);
    const score = scores[0];
    const expectedOverall = Math.round(score * 0.45 + score * 0.2 + score * 0.15 + score * 0.2);
    expect(report.overallScore).toBe(expectedOverall);
    expect(report.overallScore).toBe(score); // weights sum to 1
  });
});

describe("computeReport — repondération sans paragraphe (image seule)", () => {
  it("exclut texte/mise_en_forme du score global quand paragraphs est vide, sans y toucher pour les scores par catégorie", () => {
    const findings = emptyFindings();
    findings.image = [makeFinding({ category: "image", severity: "eleve", weight: 1, location: { label: "Image 1" } })];
    findings.metadonnees = [
      makeFinding({ category: "metadonnees", severity: "moyen", weight: 0.5, location: { label: "Document" } }),
    ];

    const model: ScoringDocumentModel = { paragraphs: [], images: [], metadata: { sourceFormat: "image" } };
    const report = computeReport(model, findings, undefined, "x");

    const imageScore = report.categories.find((c) => c.category === "image")!.score;
    const metaScore = report.categories.find((c) => c.category === "metadonnees")!.score;
    // Les catégories elles-mêmes restent calculées normalement — seule la
    // moyenne pondérée globale change.
    expect(imageScore).toBeGreaterThan(0);
    expect(report.categories.find((c) => c.category === "texte")!.score).toBe(0);

    const expected = Math.round((metaScore * 0.15 + imageScore * 0.2) / 0.35);
    expect(report.overallScore).toBe(expected);
  });

  it("ne change rien dès qu'il y a au moins un paragraphe, même vide de findings texte", () => {
    const findings = emptyFindings();
    findings.image = [makeFinding({ category: "image", severity: "eleve", weight: 1, location: { label: "Image 1" } })];

    const withText = computeReport(baseModel(paragraphsOfWords(1, 3)), findings, undefined, "x");
    const imageScore = withText.categories.find((c) => c.category === "image")!.score;
    expect(withText.overallScore).toBe(Math.round(imageScore * 0.2));
  });

  it("renvoie 0 (jamais NaN) quand aucun signal n'existe pour une image seule", () => {
    const model: ScoringDocumentModel = { paragraphs: [], images: [], metadata: { sourceFormat: "image" } };
    const report = computeReport(model, emptyFindings(), undefined, "x");
    expect(report.overallScore).toBe(0);
    expect(Number.isNaN(report.overallScore)).toBe(false);
  });
});

describe("computeReport — confiance selon la taille du document", () => {
  const findings = emptyFindings();

  it("document court (peu de mots ou peu de paragraphes) => confiance faible", () => {
    const shortByWords = baseModel(paragraphsOfWords(8, 20)); // 160 words, 8 paragraphs
    expect(computeReport(shortByWords, findings, undefined, "x").confidence).toBe("faible");

    const shortByParagraphs = baseModel(paragraphsOfWords(3, 200)); // 600 words but only 3 paragraphs
    expect(computeReport(shortByParagraphs, findings, undefined, "x").confidence).toBe("faible");
  });

  it("document de taille moyenne => confiance moyenne", () => {
    const medium = baseModel(paragraphsOfWords(10, 100)); // 1000 words, 10 paragraphs
    expect(computeReport(medium, findings, undefined, "x").confidence).toBe("moyenne");
  });

  it("document long (beaucoup de mots ET beaucoup de paragraphes) => confiance haute", () => {
    const long = baseModel(paragraphsOfWords(25, 150)); // 3750 words, 25 paragraphs
    expect(computeReport(long, findings, undefined, "x").confidence).toBe("haute");
  });

  it("beaucoup de mots mais trop peu de paragraphes ne suffit pas à atteindre 'haute'", () => {
    const fewParagraphsManyWords = baseModel(paragraphsOfWords(10, 500)); // 5000 words, 10 paragraphs
    expect(computeReport(fewParagraphsManyWords, findings, undefined, "x").confidence).toBe("moyenne");
  });
});

describe("computeReport — le plagiat traverse tel quel, jamais mélangé au score", () => {
  it("plagiarism est retransmis strictement identique (même référence) et exclu du calcul de overallScore", () => {
    const plagiarism: PlagiarismScanResult = {
      checkedPassages: 5,
      failedPassages: 0,
      matches: [
        {
          paragraphIndex: 2,
          passage: "Le changement climatique constitue un défi majeur pour les générations futures.",
          url: "https://exemple.fr/article-42",
          sourceTitle: "Article exemple sur le climat",
          similarity: 0.87,
        },
      ],
      provider: "exemple-search",
    };

    const findings = emptyFindings();
    const model = baseModel(paragraphsOfWords(10, 200));
    const withPlagiarism = computeReport(model, findings, plagiarism, "x");
    const withoutPlagiarism = computeReport(model, findings, undefined, "x");

    expect(withPlagiarism.plagiarism).toBe(plagiarism);
    expect(withoutPlagiarism.plagiarism).toBeUndefined();
    // Presence of a high-similarity plagiarism result must not move overallScore.
    expect(withPlagiarism.overallScore).toBe(withoutPlagiarism.overallScore);
  });
});

describe("computeReport — champs transmis tels quels", () => {
  it("documentMetadata et generatedAt sont transmis sans transformation", () => {
    const model = baseModel(paragraphsOfWords(10, 200));
    const report = computeReport(model, emptyFindings(), undefined, "2026-08-28T12:34:56.000Z");
    expect(report.documentMetadata).toEqual(metadata);
    expect(report.generatedAt).toBe("2026-08-28T12:34:56.000Z");
  });

  it("chaque CategoryReport conserve exactement les findings fournis", () => {
    const findings = emptyFindings();
    const f = makeFinding({ category: "image", signal: "exif_incoherent", severity: "faible" });
    findings.image = [f];
    const model = baseModel(paragraphsOfWords(10, 200));
    const report = computeReport(model, findings, undefined, "x");
    const image = report.categories.find((c) => c.category === "image")!;
    expect(image.findings).toEqual([f]);
  });
});
