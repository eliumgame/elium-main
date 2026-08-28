import "./pdfjs-node-shim";
import { describe, expect, it } from "vitest";
import { createEliumFile } from "../src/format/document";
import { docToDocx } from "../src/format/docx";
import { writeEliumPackage } from "../src/format/elium-package";
import { EliumPasswordRequired, loadDocumentModel } from "../src/detector/ingest/loadFile";
import { runAnalysis } from "../src/detector/runAnalysis";
import type { ProseMirrorNode } from "../src/format/types";
import type { SearchProvider, SearchResult } from "../src/detector/types";

function fakeFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

function paragraph(text: string): ProseMirrorNode {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

const HUMAN_PARAGRAPHS = [
  "Ce chapitre revient sur trois expériences distinctes menées entre 2019 et 2021, avec des résultats parfois contradictoires.",
  "On note d'abord une chose : les premiers essais n'ont pas donné grand-chose. Puis, en creusant, une piste est apparue.",
  "Le tableau 4 résume ça. Il manque encore deux séries de mesures pour conclure vraiment quoi que ce soit de solide ici.",
  "Un doute subsiste sur la méthode employée en 2020 — plusieurs relectures n'ont pas permis de trancher la question posée.",
];

function docWithParagraphs(paragraphs: string[]): ProseMirrorNode {
  return { type: "doc", content: paragraphs.map(paragraph) };
}

describe("Détecteur — intégration loadFile + runAnalysis", () => {
  it("charge un .elium non protégé et produit un rapport complet", async () => {
    const doc = docWithParagraphs(HUMAN_PARAGRAPHS);
    const file = await createEliumFile({ title: "Mémoire test", profile: "standard", doc });
    const bytes = await writeEliumPackage(file);

    const model = await loadDocumentModel(fakeFile("memoire.elium", bytes));
    expect(model.paragraphs.length).toBe(HUMAN_PARAGRAPHS.length);
    expect(model.metadata.sourceFormat).toBe("elium");
    expect(model.metadata.title).toBe("Mémoire test");

    const stages: string[] = [];
    const report = await runAnalysis(model, {
      generatedAt: "2026-01-01T00:00:00.000Z",
      onProgress: (p) => stages.push(p.stage),
    });

    expect(report.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(report.disclaimer.length).toBeGreaterThan(0);
    expect(report.categories.map((c) => c.category).sort()).toEqual(
      ["texte", "mise_en_forme", "metadonnees", "image"].sort(),
    );
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(100);
    expect(report.plagiarism).toBeUndefined();
    expect(stages).toEqual(expect.arrayContaining(["texte", "mise_en_forme", "metadonnees", "image", "score"]));
  });

  it("réclame le mot de passe d'un .elium protégé puis réussit avec le bon mot de passe", async () => {
    const doc = docWithParagraphs(HUMAN_PARAGRAPHS);
    const file = await createEliumFile({ title: "Confidentiel", profile: "encrypted", doc });
    const bytes = await writeEliumPackage(file, { password: "correct horse battery staple" });
    const wrapped = fakeFile("confidentiel.elium", bytes);

    await expect(loadDocumentModel(wrapped)).rejects.toBeInstanceOf(EliumPasswordRequired);

    const model = await loadDocumentModel(wrapped, { password: "correct horse battery staple" });
    expect(model.paragraphs.length).toBe(HUMAN_PARAGRAPHS.length);
  });

  it("charge un .docx et en extrait le texte", async () => {
    const doc = docWithParagraphs(HUMAN_PARAGRAPHS);
    const file = await createEliumFile({ title: "Rapport Word", profile: "standard", doc });
    const bytes = docToDocx(file);

    const model = await loadDocumentModel(fakeFile("rapport.docx", bytes));
    expect(model.metadata.sourceFormat).toBe("docx");
    // docToDocx may prepend a title paragraph/heading — assert the body text
    // survived the round-trip rather than an exact paragraph count.
    expect(model.paragraphs.length).toBeGreaterThanOrEqual(HUMAN_PARAGRAPHS.length);
    const joined = model.paragraphs.map((p) => p.text).join("\n");
    expect(joined).toContain("expériences distinctes");
  });

  it("passe le scan de plagiat uniquement quand un provider est fourni, jamais mélangé au score global", async () => {
    const doc = docWithParagraphs(HUMAN_PARAGRAPHS);
    const file = await createEliumFile({ title: "Avec plagiat", profile: "standard", doc });
    const bytes = await writeEliumPackage(file);
    const model = await loadDocumentModel(fakeFile("plagiat.elium", bytes));

    const withoutProvider = await runAnalysis(model, { generatedAt: "2026-01-01T00:00:00.000Z" });
    expect(withoutProvider.plagiarism).toBeUndefined();

    const results: SearchResult[] = [
      { title: "Source suspecte", url: "https://example.org/a", snippet: HUMAN_PARAGRAPHS[0] },
    ];
    const provider: SearchProvider = { name: "Faux moteur", search: async () => results };

    const withProvider = await runAnalysis(model, {
      generatedAt: "2026-01-01T00:00:00.000Z",
      plagiarism: { provider, maxQueries: 5 },
    });
    expect(withProvider.plagiarism).toBeDefined();
    expect(withProvider.plagiarism!.provider).toBe("Faux moteur");
    expect(withProvider.overallScore).toBe(withoutProvider.overallScore);
  });

  it("annule proprement une analyse déjà en cours via AbortSignal", async () => {
    const doc = docWithParagraphs(HUMAN_PARAGRAPHS);
    const file = await createEliumFile({ title: "Annulation", profile: "standard", doc });
    const bytes = await writeEliumPackage(file);
    const model = await loadDocumentModel(fakeFile("annulation.elium", bytes));

    const controller = new AbortController();
    controller.abort();
    await expect(runAnalysis(model, { generatedAt: "2026-01-01T00:00:00.000Z", signal: controller.signal })).rejects.toThrow();
  });
});
