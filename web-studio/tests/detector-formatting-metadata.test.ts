import { describe, it, expect } from "vitest";
import { analyzeFormattingSignals } from "../src/detector/formattingSignals";
import { analyzeMetadataSignals } from "../src/detector/metadataSignals";
import type { DocumentMetadata, ParagraphModel, RunFormat } from "../src/detector/types";

function run(text: string, overrides: Partial<RunFormat> = {}): RunFormat {
  return { text, ...overrides };
}

function para(index: number, runs: RunFormat[], overrides: Partial<ParagraphModel> = {}): ParagraphModel {
  return {
    index,
    text: runs.map((r) => r.text).join(""),
    runs,
    ...overrides,
  };
}

const TIMES_12: Partial<RunFormat> = { fontFamily: "Times New Roman", fontSize: 12 };
const CALIBRI_11: Partial<RunFormat> = { fontFamily: "Calibri", fontSize: 11 };

const NORMAL_SENTENCE =
  "Le bailleur informe le preneur que les travaux de rénovation débuteront au mois de mars prochain. ";

describe("analyzeFormattingSignals — police incohérente", () => {
  it("flags a paragraph whose font family and size diverge from the document majority", () => {
    const paragraphs: ParagraphModel[] = [
      para(0, [run(NORMAL_SENTENCE, TIMES_12)]),
      para(1, [run(NORMAL_SENTENCE, TIMES_12)]),
      para(2, [run("Ce paragraphe provient visiblement d'un autre document source. ", CALIBRI_11)]),
      para(3, [run(NORMAL_SENTENCE, TIMES_12)]),
      para(4, [run(NORMAL_SENTENCE, TIMES_12)]),
    ];

    const findings = analyzeFormattingSignals(paragraphs);
    const hit = findings.find((f) => f.signal === "police_incoherente");
    expect(hit).toBeDefined();
    expect(hit!.location.paragraphIndex).toBe(2);
    expect(hit!.category).toBe("mise_en_forme");
    expect(hit!.explanation).toContain("Calibri 11pt");
    expect(hit!.explanation).toContain("Times New Roman 12pt");
    expect(hit!.weight).toBeGreaterThan(0);
  });

  it("does not flag when every paragraph shares the same font", () => {
    const paragraphs: ParagraphModel[] = Array.from({ length: 6 }, (_, i) => para(i, [run(NORMAL_SENTENCE, TIMES_12)]));
    const findings = analyzeFormattingSignals(paragraphs);
    expect(findings.filter((f) => f.signal === "police_incoherente")).toHaveLength(0);
  });

  it("skips very short paragraphs (titles/captions) to avoid noise", () => {
    const paragraphs: ParagraphModel[] = [
      para(0, [run(NORMAL_SENTENCE, TIMES_12)]),
      para(1, [run(NORMAL_SENTENCE, TIMES_12)]),
      para(2, [run("Titre", CALIBRI_11)]), // under 5 words
      para(3, [run(NORMAL_SENTENCE, TIMES_12)]),
    ];
    const findings = analyzeFormattingSignals(paragraphs);
    expect(findings.filter((f) => f.signal === "police_incoherente")).toHaveLength(0);
  });

  it("flags a font-size jump even when the family stays the same", () => {
    const paragraphs: ParagraphModel[] = [
      para(0, [run(NORMAL_SENTENCE, TIMES_12)]),
      para(1, [run(NORMAL_SENTENCE, TIMES_12)]),
      para(2, [run("Ce paragraphe a une taille de police nettement différente du reste. ", { fontFamily: "Times New Roman", fontSize: 16 })]),
      para(3, [run(NORMAL_SENTENCE, TIMES_12)]),
    ];
    const findings = analyzeFormattingSignals(paragraphs);
    expect(findings.some((f) => f.signal === "police_incoherente" && f.location.paragraphIndex === 2)).toBe(true);
  });
});

describe("analyzeFormattingSignals — guillemets incohérents", () => {
  it("flags a paragraph using curly quotes when the document is overwhelmingly straight-quoted", () => {
    const paragraphs: ParagraphModel[] = [
      para(0, [run('Le contrat mentionne "la clause de non-concurrence" en détail. ')]),
      para(1, [run('Il précise également "les modalités de résiliation" applicables. ')]),
      para(2, [run('Le document évoque enfin "la durée de préavis" prévue. ')]),
      para(3, [run("Ce paragraphe cite “une source externe” avec des guillemets courbes. ")]),
    ];
    const findings = analyzeFormattingSignals(paragraphs);
    const hit = findings.find((f) => f.signal === "guillemets_incoherents");
    expect(hit).toBeDefined();
    expect(hit!.location.paragraphIndex).toBe(3);
    expect(hit!.explanation).toContain("courbes");
  });

  it("does not flag when quote style is consistent throughout", () => {
    const paragraphs: ParagraphModel[] = [
      para(0, [run('Le contrat mentionne "la clause de non-concurrence" en détail. ')]),
      para(1, [run('Il précise également "les modalités de résiliation" applicables. ')]),
      para(2, [run('Le document évoque enfin "la durée de préavis" prévue. ')]),
    ];
    const findings = analyzeFormattingSignals(paragraphs);
    expect(findings.filter((f) => f.signal === "guillemets_incoherents")).toHaveLength(0);
  });
});

describe("analyzeFormattingSignals — niveaux de titres", () => {
  it("flags a heading level jump as a low-severity informational finding", () => {
    const paragraphs: ParagraphModel[] = [
      para(0, [run("Introduction générale")], { heading: 1 }),
      para(1, [run(NORMAL_SENTENCE, TIMES_12)]),
      para(2, [run("Sous-partie technique détaillée")], { heading: 4 }),
    ];
    const findings = analyzeFormattingSignals(paragraphs);
    const hit = findings.find((f) => f.signal === "niveau_titre_irregulier");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("info");
    expect(hit!.weight).toBe(0);
    expect(hit!.explanation).toContain("niveau 4");
    expect(hit!.explanation).toContain("niveau 1");
  });

  it("does not flag a normal, sequential heading structure", () => {
    const paragraphs: ParagraphModel[] = [
      para(0, [run("Introduction générale")], { heading: 1 }),
      para(1, [run("Contexte du projet")], { heading: 2 }),
      para(2, [run("Détails techniques")], { heading: 3 }),
    ];
    const findings = analyzeFormattingSignals(paragraphs);
    expect(findings.filter((f) => f.signal === "niveau_titre_irregulier")).toHaveLength(0);
  });
});

function words(n: number): string {
  return Array.from({ length: n }, () => "mot").join(" ") + ". ";
}

function paragraphsWithWords(count: number, wordsEach: number): ParagraphModel[] {
  return Array.from({ length: count }, (_, i) => para(i, [run(words(wordsEach))]));
}

describe("analyzeMetadataSignals — nombre de révisions", () => {
  it("flags an anormally low revision count on a large document", () => {
    const paragraphs = paragraphsWithWords(50, 100); // 50 paragraphs, 5000 words
    const metadata: DocumentMetadata = { sourceFormat: "docx", revisionCount: 1 };
    const findings = analyzeMetadataSignals(metadata, paragraphs);
    const hit = findings.find((f) => f.signal === "revisions_basses");
    expect(hit).toBeDefined();
    expect(hit!.category).toBe("metadonnees");
    expect(hit!.explanation).toContain("1 révision");
    expect(hit!.explanation).toContain("50 paragraphes");
    expect(hit!.weight).toBeGreaterThan(0);
  });

  it("does not flag a low revision count on a small document", () => {
    const paragraphs = paragraphsWithWords(3, 20);
    const metadata: DocumentMetadata = { sourceFormat: "docx", revisionCount: 1 };
    const findings = analyzeMetadataSignals(metadata, paragraphs);
    expect(findings.filter((f) => f.signal === "revisions_basses")).toHaveLength(0);
  });

  it("does not flag a healthy revision count on a large document", () => {
    const paragraphs = paragraphsWithWords(50, 100);
    const metadata: DocumentMetadata = { sourceFormat: "docx", revisionCount: 40 };
    const findings = analyzeMetadataSignals(metadata, paragraphs);
    expect(findings.filter((f) => f.signal === "revisions_basses")).toHaveLength(0);
  });
});

describe("analyzeMetadataSignals — temps d'édition", () => {
  it("flags editing time far too low for the document's length", () => {
    const paragraphs = paragraphsWithWords(10, 500); // 5000 words
    const metadata: DocumentMetadata = { sourceFormat: "docx", editingMinutes: 2 };
    const findings = analyzeMetadataSignals(metadata, paragraphs);
    const hit = findings.find((f) => f.signal === "temps_edition_bas");
    expect(hit).toBeDefined();
    expect(hit!.explanation).toContain("2 minutes");
    expect(hit!.weight).toBeGreaterThan(0);
  });

  it("does not flag editing time proportional to document length", () => {
    const paragraphs = paragraphsWithWords(10, 500); // 5000 words
    const metadata: DocumentMetadata = { sourceFormat: "docx", editingMinutes: 240 };
    const findings = analyzeMetadataSignals(metadata, paragraphs);
    expect(findings.filter((f) => f.signal === "temps_edition_bas")).toHaveLength(0);
  });
});

describe("analyzeMetadataSignals — jamais modifié après création", () => {
  it("flags identical creation/modification timestamps on a large document as informational", () => {
    const paragraphs = paragraphsWithWords(50, 100);
    const metadata: DocumentMetadata = {
      sourceFormat: "docx",
      createdAt: "2026-08-01T10:00:00.000Z",
      modifiedAt: "2026-08-01T10:00:30.000Z",
    };
    const findings = analyzeMetadataSignals(metadata, paragraphs);
    const hit = findings.find((f) => f.signal === "jamais_modifie");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("info");
  });

  it("does not flag when creation and modification are far apart", () => {
    const paragraphs = paragraphsWithWords(50, 100);
    const metadata: DocumentMetadata = {
      sourceFormat: "docx",
      createdAt: "2026-08-01T10:00:00.000Z",
      modifiedAt: "2026-08-15T18:00:00.000Z",
    };
    const findings = analyzeMetadataSignals(metadata, paragraphs);
    expect(findings.filter((f) => f.signal === "jamais_modifie")).toHaveLength(0);
  });
});

describe("analyzeMetadataSignals — champs informatifs", () => {
  it("surfaces creator/producer/title/author as weight-0 informational findings, not accusations", () => {
    const paragraphs = paragraphsWithWords(3, 20);
    const metadata: DocumentMetadata = {
      sourceFormat: "docx",
      creator: "Microsoft Word",
      producer: "Word pour Microsoft 365",
      title: "Rapport annuel",
      author: "Jean Dupont",
    };
    const findings = analyzeMetadataSignals(metadata, paragraphs);
    const infoFindings = findings.filter((f) =>
      ["creator_info", "producer_info", "title_info", "author_info"].includes(f.signal),
    );
    expect(infoFindings).toHaveLength(4);
    for (const f of infoFindings) {
      expect(f.severity).toBe("info");
      expect(f.weight).toBe(0);
      expect(f.category).toBe("metadonnees");
    }
    const creatorFinding = infoFindings.find((f) => f.signal === "creator_info")!;
    expect(creatorFinding.explanation).toContain("Microsoft Word");
    expect(creatorFinding.explanation.toLowerCase()).toContain("pas en soi une preuve");
  });

  it("emits no findings at all for bare metadata on a tiny document", () => {
    const paragraphs = paragraphsWithWords(1, 10);
    const metadata: DocumentMetadata = { sourceFormat: "elium" };
    const findings = analyzeMetadataSignals(metadata, paragraphs);
    expect(findings).toHaveLength(0);
  });
});
