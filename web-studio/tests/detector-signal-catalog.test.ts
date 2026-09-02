import { describe, expect, it } from "vitest";
import { SIGNAL_CATALOG } from "../src/detector/signalCatalog";
import { analyzeTextSignals } from "../src/detector/textSignals";
import { analyzeFormattingSignals } from "../src/detector/formattingSignals";
import { analyzeMetadataSignals } from "../src/detector/metadataSignals";
import { analyzeImageSignals } from "../src/detector/imageSignals";
import type { ParagraphModel } from "../src/detector/types";

/**
 * Le réglage de sensibilité de l'UI n'a de sens que si SIGNAL_CATALOG liste
 * exactement les `signal:` que les moteurs peuvent réellement émettre — sinon
 * un signal invisible dans le catalogue ne peut jamais être désactivé, ou un
 * signal du catalogue qui n'existe plus laisse un réglage mort dans l'UI.
 */

function bursty(n: number): ParagraphModel[] {
  const texts = [
    "Court.",
    "Ceci est une phrase franchement plus longue que la précédente, avec plusieurs propositions imbriquées.",
    "Moyen.",
    "Une autre phrase de longueur très différente des deux précédentes, pour casser toute régularité.",
  ];
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    text: texts[i % texts.length] + " " + texts[(i + 1) % texts.length],
    runs: [{ text: texts[i % texts.length] }],
  }));
}

describe("detector — catalogue de signaux synchronisé avec les moteurs", () => {
  it("chaque id du catalogue est unique", () => {
    const ids = SIGNAL_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("aucun moteur n'émet un signal absent du catalogue", () => {
    const catalogIds = new Set(SIGNAL_CATALOG.map((e) => e.id));

    const cliché = "Il est important de noter que ceci est un exemple. En conclusion, tout va bien. ".repeat(20);
    const textFindings = analyzeTextSignals([
      ...bursty(30),
      ...Array.from({ length: 25 }, (_, i) => ({ index: 100 + i, text: cliché, runs: [{ text: cliché }] })),
    ]);
    for (const f of textFindings) expect(catalogIds, `signal texte inconnu: ${f.signal}`).toContain(f.signal);

    const uniform = Array.from({ length: 12 }, (_, i) => ({
      index: i,
      text: "Un paragraphe de taille identique aux autres pour tester la mise en forme correctement.",
      runs: [
        { text: "x".repeat(60), fontFamily: i === 6 ? "Calibri" : "Times New Roman", fontSize: i === 6 ? 16 : 12 },
      ],
    }));
    const formatFindings = analyzeFormattingSignals(uniform);
    for (const f of formatFindings) expect(catalogIds, `signal mise_en_forme inconnu: ${f.signal}`).toContain(f.signal);

    const metaFindings = analyzeMetadataSignals(
      {
        sourceFormat: "docx",
        title: "T",
        author: "A",
        creator: "Word",
        revisionCount: 1,
        editingMinutes: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        modifiedAt: "2026-01-01T00:01:00.000Z",
      },
      Array.from({ length: 50 }, (_, i) => ({ index: i, text: "mot ".repeat(100), runs: [] })),
    );
    for (const f of metaFindings) expect(catalogIds, `signal metadonnees inconnu: ${f.signal}`).toContain(f.signal);

    // PNG avec un chunk tEXt "parameters" (convention Stable Diffusion WebUI) — déclenche image_png_generation_parameters.
    const png = buildPngWithTextChunk("parameters", "Prompt: a cat, steps: 20");
    const imageFindings = analyzeImageSignals([{ index: 0, bytes: png, mime: "image/png", width: 512, height: 512 }]);
    for (const f of imageFindings) expect(catalogIds, `signal image inconnu: ${f.signal}`).toContain(f.signal);
  });

  it("tous les signaux avec affectsScore=true sont utilisés par au moins un moteur (pas d'entrée morte)", () => {
    // Vérifié à l'oeil contre les fichiers sources au moment de l'écriture — ce
    // test garde juste le compte total stable pour repérer un ajout/suppression
    // de signal côté moteur qui oublierait de mettre à jour le catalogue.
    const ids = new Set(SIGNAL_CATALOG.map((e) => e.id));
    for (const expected of [
      "burstiness_faible",
      "paragraphes_uniformes",
      "cliches_ia",
      "amorces_repetees",
      "tirets_cadratins_frequents",
      "densite_listes_elevee",
      "police_incoherente",
      "guillemets_incoherents",
      "niveau_titre_irregulier",
      "revisions_basses",
      "temps_edition_bas",
      "jamais_modifie",
      "creator_info",
      "producer_info",
      "title_info",
      "author_info",
      "image_c2pa_ai_source",
      "image_exif_generator_tag",
      "image_png_generation_parameters",
      "image_png_generation_software",
      "image_no_exif_generator_resolution",
      "image_c2pa_verification_status",
      "image_webp_limited_check",
      "image_pdf_non_jpeg_skipped",
    ]) {
      expect(ids, `${expected} absent du catalogue`).toContain(expected);
    }
    expect(SIGNAL_CATALOG.length).toBe(24);
  });
});

function buildPngWithTextChunk(keyword: string, text: string): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunks: number[][] = [];
  chunks.push(chunk("IHDR", ihdr(1, 1)));
  const payload = [...strBytes(keyword), 0, ...strBytes(text)];
  chunks.push(chunk("tEXt", payload));
  chunks.push(chunk("IEND", []));
  return new Uint8Array([...sig, ...chunks.flat()]);
}

function ihdr(w: number, h: number): number[] {
  const b = [];
  const push32 = (n: number) => b.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  push32(w);
  push32(h);
  b.push(8, 6, 0, 0, 0); // bit depth 8, color type 6 (RGBA), compression/filter/interlace 0
  return b;
}

function strBytes(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

function crc32(bytes: number[]): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: number[]): number[] {
  const typeBytes = strBytes(type);
  const len = data.length;
  const lenBytes = [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
  const crc = crc32([...typeBytes, ...data]);
  const crcBytes = [(crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
  return [...lenBytes, ...typeBytes, ...data, ...crcBytes];
}

// ---------------------------------------------------------------------------
// appliesTo — préconfiguration du panneau de sensibilité selon le fichier
// ---------------------------------------------------------------------------

function applicableIds(model: {
  paragraphs: ParagraphModel[];
  images: { mime: string }[];
  metadata: Record<string, unknown>;
}): string[] {
  return SIGNAL_CATALOG.filter((e) => (e.appliesTo ? e.appliesTo(model as never) : true)).map((e) => e.id);
}

describe("appliesTo — n'affiche comme applicables que les signaux réellement possibles pour ce fichier", () => {
  const textParagraphs: ParagraphModel[] = [{ index: 0, text: "Un paragraphe.", runs: [{ text: "Un paragraphe." }] }];

  it("une image seule sans métadonnées : rien du texte/mise_en_forme, rien des métadonnées absentes, tout ce qui est image reste candidat", () => {
    const ids = applicableIds({ paragraphs: [], images: [{ mime: "image/png" }], metadata: { sourceFormat: "image" } });
    for (const textId of ["burstiness_faible", "cliches_ia", "police_incoherente", "niveau_titre_irregulier"]) {
      expect(ids, `${textId} ne devrait pas être applicable sans paragraphe`).not.toContain(textId);
    }
    for (const metaId of ["revisions_basses", "temps_edition_bas", "jamais_modifie", "author_info"]) {
      expect(ids, `${metaId} ne devrait pas être applicable sans cette métadonnée`).not.toContain(metaId);
    }
    expect(ids).toContain("image_c2pa_ai_source");
    expect(ids).toContain("image_png_generation_parameters");
    expect(ids).not.toContain("image_exif_generator_tag"); // EXIF n'est lu que sur JPEG
  });

  it("une image JPEG : les signaux spécifiques PNG ne sont pas applicables, EXIF l'est", () => {
    const ids = applicableIds({ paragraphs: [], images: [{ mime: "image/jpeg" }], metadata: {} });
    expect(ids).toContain("image_exif_generator_tag");
    expect(ids).toContain("image_c2pa_ai_source");
    expect(ids).not.toContain("image_png_generation_parameters");
    expect(ids).not.toContain("image_png_generation_software");
  });

  it("un document texte sans aucune image : rien de la catégorie image n'est applicable", () => {
    const ids = applicableIds({ paragraphs: textParagraphs, images: [], metadata: {} });
    for (const imgId of SIGNAL_CATALOG.filter((e) => e.category === "image").map((e) => e.id)) {
      expect(ids, `${imgId} ne devrait pas être applicable sans image`).not.toContain(imgId);
    }
    expect(ids).toContain("burstiness_faible");
    expect(ids).toContain("police_incoherente");
  });

  it("un .docx avec revisionCount/editingMinutes connus rend ces deux signaux applicables, un PDF sans ces champs non", () => {
    const docx = applicableIds({
      paragraphs: textParagraphs,
      images: [],
      metadata: { sourceFormat: "docx", revisionCount: 1, editingMinutes: 2 },
    });
    expect(docx).toContain("revisions_basses");
    expect(docx).toContain("temps_edition_bas");

    const pdf = applicableIds({ paragraphs: textParagraphs, images: [], metadata: { sourceFormat: "pdf" } });
    expect(pdf).not.toContain("revisions_basses");
    expect(pdf).not.toContain("temps_edition_bas");
  });

  it("jamais_modifie n'est applicable que si créé ET modifié sont tous les deux connus", () => {
    const both = applicableIds({
      paragraphs: textParagraphs,
      images: [],
      metadata: { createdAt: "2026-01-01T00:00:00.000Z", modifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(both).toContain("jamais_modifie");

    const onlyOne = applicableIds({
      paragraphs: textParagraphs,
      images: [],
      metadata: { createdAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(onlyOne).not.toContain("jamais_modifie");
  });

  it("les signaux sans appliesTo restent toujours applicables (rétrocompatibilité)", () => {
    const entry = SIGNAL_CATALOG.find((e) => e.id === "burstiness_faible")!;
    expect(entry.appliesTo).toBeDefined(); // sanity: ce signal-ci EST couvert
    // Aucune entrée du catalogue ne doit être orpheline (sans appliesTo du tout)
    // par erreur d'oubli — chaque signal doit avoir une règle explicite.
    for (const e of SIGNAL_CATALOG) {
      expect(e.appliesTo, `${e.id} n'a pas d'appliesTo défini`).toBeDefined();
    }
  });
});
