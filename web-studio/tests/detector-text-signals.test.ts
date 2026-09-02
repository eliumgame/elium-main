import { describe, it, expect } from "vitest";
import { analyzeTextSignals } from "../src/detector/textSignals";
import type { ParagraphModel } from "../src/detector/types";

function para(index: number, text: string, overrides: Partial<ParagraphModel> = {}): ParagraphModel {
  return { index, text, runs: [{ text }], ...overrides };
}

function bySignal(paragraphs: ParagraphModel[], signal: string) {
  return analyzeTextSignals(paragraphs).filter((f) => f.signal === signal);
}

// ---- 1 & 2. Burstiness / uniformité de paragraphes -------------------------

describe("analyzeTextSignals — burstiness (régularité de longueur de phrase)", () => {
  // Un récit humain typique : phrases très courtes ("Non." "Bon.") mêlées à des
  // phrases longues et digressives — un rythme irrégulier par construction.
  const HUMAN_BURSTY = [
    para(
      0,
      "Bon. On y va. Le projet a démarré dans la confusion la plus totale, avec une équipe réduite à trois " +
        "personnes et un budget qu'il a fallu renégocier deux fois avant même le premier comité de pilotage. " +
        "Franchement, personne n'y croyait vraiment. Pourtant, contre toute attente, et malgré des retards " +
        "successifs qui ont mis à rude épreuve la patience de tout le monde, y compris la mienne, le résultat " +
        "final a fini par surprendre à peu près tous ceux qui avaient suivi le dossier de près. Pas mal, non ? " +
        "On continue comme ça. Il reste encore beaucoup à faire, notamment sur la partie documentation, mais " +
        "on tient le bon bout.",
    ),
  ];

  // Un texte gabarité : chaque phrase fait quasiment la même longueur (10-12
  // mots), un motif que l'écriture humaine spontanée ne produit presque jamais.
  const AI_UNIFORM = [
    para(
      0,
      "Ce projet a été mené avec beaucoup de rigueur par toute l'équipe impliquée. " +
        "Chaque étape a été planifiée avec soin afin de respecter les délais fixés. " +
        "Les membres de l'équipe ont collaboré efficacement tout au long du processus. " +
        "Des points d'avancement réguliers ont permis de suivre les progrès réalisés. " +
        "Les objectifs fixés au départ ont été globalement atteints dans les temps. " +
        "La communication entre les différentes parties prenantes est restée fluide. " +
        "Chaque décision a été prise après une analyse approfondie des options possibles. " +
        "Le résultat final reflète fidèlement les attentes exprimées au démarrage.",
    ),
  ];

  it("does not flag naturally bursty human-like prose", () => {
    const hits = bySignal(HUMAN_BURSTY, "burstiness_faible");
    expect(hits).toHaveLength(0);
  });

  it("flags a document whose sentence lengths are abnormally uniform, citing CV and mean length", () => {
    const hits = bySignal(AI_UNIFORM, "burstiness_faible");
    expect(hits).toHaveLength(1);
    const f = hits[0]!;
    expect(f.category).toBe("texte");
    expect(f.location.label).toBe("Ensemble du document");
    expect(f.weight).toBeGreaterThan(0);
    expect(f.explanation).toMatch(/coefficient de variation de 0[.,]\d+/);
    expect(f.explanation).toMatch(/moyenne de \d+([.,]\d+)? mots par phrase/);
  });

  it("stays silent below the 8-sentence floor even for uniform sentences", () => {
    const tooShort = [para(0, "Ceci est un test court. Encore un autre test court. Un dernier test court ici.")];
    expect(bySignal(tooShort, "burstiness_faible")).toHaveLength(0);
  });
});

describe("analyzeTextSignals — uniformité de longueur des paragraphes", () => {
  const wordsOf = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ") + ".";

  it("does not flag paragraphs of irregular, human-like length", () => {
    const lengths = [12, 340, 45, 210, 8, 150, 60, 400, 25];
    const paragraphs = lengths.map((n, i) => para(i, wordsOf(n, "motirregulier")));
    expect(bySignal(paragraphs, "paragraphes_uniformes")).toHaveLength(0);
  });

  it("flags paragraphs whose word counts are abnormally uniform", () => {
    const lengths = [80, 82, 79, 84, 81, 83, 80, 78, 85, 82];
    const paragraphs = lengths.map((n, i) => para(i, wordsOf(n, "mot")));
    const hits = bySignal(paragraphs, "paragraphes_uniformes");
    expect(hits).toHaveLength(1);
    const f = hits[0]!;
    expect(f.location.label).toBe("Ensemble du document");
    expect(f.explanation).toMatch(/coefficient de variation de 0[.,]\d+/);
    expect(f.explanation).toContain(`${lengths.length} paragraphes`);
  });
});

// ---- 3. Lexique de tournures stéréotypées d'IA -----------------------------

describe("analyzeTextSignals — clichés d'IA", () => {
  it("does not flag plain prose without stock phrases", () => {
    const paragraphs = [
      para(
        0,
        "Le chantier a repris lundi matin après une semaine d'arrêt due aux intempéries. Les ouvriers ont " +
          "d'abord vérifié l'état des fondations avant de reprendre le coulage du béton. Le chef de chantier " +
          "espère rattraper une partie du retard accumulé avant la fin du mois. " +
          "Plusieurs fournisseurs ont confirmé leurs livraisons pour la semaine prochaine.",
      ),
    ];
    expect(bySignal(paragraphs, "cliches_ia")).toHaveLength(0);
  });

  it("emits one document-level finding listing the stock phrases found, above the 3-per-1000-words rate", () => {
    // ~110 words, 5 cliché occurrences => well above 3/1000.
    const filler = Array.from({ length: 90 }, (_, i) => `mot${i}`).join(" ");
    const text =
      `Il est important de noter que ${filler} en outre, ce point mérite d'être creusé. ` +
      "Par ailleurs, il convient de souligner un second aspect. En résumé, la situation reste ouverte.";
    const paragraphs = [para(0, text)];
    const hits = bySignal(paragraphs, "cliches_ia");
    const docLevel = hits.filter((f) => f.location.label === "Ensemble du document");
    expect(docLevel).toHaveLength(1);
    const f = docLevel[0]!;
    expect(f.explanation).toContain("il est important de noter que");
    expect(f.explanation).toContain("en outre,");
    expect(f.explanation).toMatch(/pour 1000 mots/);
  });

  it("emits a lower-weight paragraph-level finding for a paragraph combining 2+ distinct stock phrases", () => {
    const paragraphs = [
      para(0, "Un paragraphe tout à fait ordinaire, sans aucune tournure remarquable."),
      para(1, "Il est important de noter que ce sujet est complexe. Par ailleurs, plusieurs facteurs entrent en jeu."),
      para(2, "Encore un paragraphe neutre, qui ne contient rien de particulier."),
    ];
    const hits = bySignal(paragraphs, "cliches_ia");
    const paraLevel = hits.find((f) => f.location.paragraphIndex === 1);
    expect(paraLevel).toBeDefined();
    expect(paraLevel!.location.label).toBe("Paragraphe 2");
    expect(paraLevel!.severity).toBe("faible");
    expect(paraLevel!.explanation).toContain("il est important de noter que");
    expect(paraLevel!.explanation).toContain("par ailleurs,");
  });

  it("detects the English stock phrases too", () => {
    const filler = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
    const text =
      `It is important to note that ${filler} furthermore, this deserves attention. ` +
      "Moreover, a second aspect boasts real significance here. In conclusion, the matter stays open.";
    const paragraphs = [para(0, text)];
    const hits = bySignal(paragraphs, "cliches_ia").filter((f) => f.location.label === "Ensemble du document");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.explanation).toContain("furthermore,");
  });

  it("detects the correlative pair 'd'une part... d'autre part' as one stock phrase", () => {
    const paragraphs = [
      para(
        0,
        "Il est important de noter que le dossier est sensible. D'une part, les délais sont contraints ; " +
          "d'autre part, les ressources manquent cruellement pour tenir les engagements pris.",
      ),
    ];
    const hits = bySignal(paragraphs, "cliches_ia");
    const paraLevel = hits.find((f) => f.location.paragraphIndex === 0);
    expect(paraLevel).toBeDefined();
    expect(paraLevel!.explanation).toContain("d'une part... d'autre part");
  });
});

// ---- 4. Amorces de phrase répétées -----------------------------------------

describe("analyzeTextSignals — amorces de phrase répétées", () => {
  it("does not flag varied sentence openers", () => {
    const openers = [
      "Le rapport souligne",
      "Plusieurs experts estiment",
      "La direction a annoncé",
      "Un porte-parole précise",
      "Les chiffres montrent",
      "Cette hypothèse reste",
      "L'équipe a constaté",
      "Rien ne permet",
      "Les prochaines semaines",
      "Un second facteur",
      "Le comité recommande",
      "Cette approche suppose",
      "Les résultats confirment",
      "Aucune décision n'a",
      "Le calendrier prévoit",
    ];
    const paragraphs = openers.map((o, i) =>
      para(i, `${o} des éléments nouveaux sur ce dossier complexe et suivi de près.`),
    );
    expect(bySignal(paragraphs, "amorces_repetees")).toHaveLength(0);
  });

  it("flags a document where one opener dominates at least 15% of sentences", () => {
    // 18 sentences total, 4 opening with "Il est important" => share = 4/18 ≈ 22.2%.
    const repeated = Array.from(
      { length: 4 },
      (_, i) => `Il est important de considérer le facteur numéro ${i} dans cette analyse détaillée.`,
    );
    const varied = [
      "Le rapport souligne plusieurs points de vigilance pour la suite du projet.",
      "Plusieurs experts estiment que la situation devrait évoluer favorablement.",
      "La direction a annoncé un changement de cap pour le trimestre prochain.",
      "Un porte-parole précise que rien n'est encore définitivement arrêté.",
      "Les chiffres montrent une tendance à la baisse depuis trois mois.",
      "Cette hypothèse reste à confirmer par des données complémentaires solides.",
      "L'équipe a constaté des écarts significatifs entre les deux mesures.",
      "Rien ne permet pour l'instant d'exclure une révision du calendrier.",
      "Les prochaines semaines seront décisives pour la suite du dossier.",
      "Un second facteur explique en partie ce résultat inattendu et notable.",
      "Le comité recommande une prudence accrue avant toute annonce publique.",
      "Cette approche suppose une coordination étroite entre les équipes concernées.",
      "Les résultats confirment globalement les projections faites en début d'année.",
      "Aucune décision n'a encore été prise sur ce sujet sensible et suivi.",
    ];
    const paragraphs = [...repeated, ...varied].map((s, i) => para(i, s));
    const hits = bySignal(paragraphs, "amorces_repetees");
    expect(hits).toHaveLength(1);
    const f = hits[0]!;
    expect(f.location.label).toBe("Ensemble du document");
    expect(f.explanation).toContain("Il est important");
    expect(f.explanation).toMatch(/4 phrases sur 18/);
    expect(f.explanation).toMatch(/22[.,]2 %/);
  });
});

// ---- 5. Tiret cadratin ------------------------------------------------------

describe("analyzeTextSignals — usage du tiret cadratin", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(" ");

  it("does not flag prose with rare or no em dashes", () => {
    const paragraphs = [para(0, `${filler(200)} — une seule occurrence isolée ici.`)];
    expect(bySignal(paragraphs, "tirets_cadratins_frequents")).toHaveLength(0);
  });

  it("flags a document overusing the em dash relative to its word count", () => {
    // 200 words, 4 dashes => 20 per 1000 words, well above the 3/1000 threshold.
    const text = `${filler(50)} — un point — un autre point — encore un point — dernier point ${filler(150)}`;
    const paragraphs = [para(0, text)];
    const hits = bySignal(paragraphs, "tirets_cadratins_frequents");
    expect(hits).toHaveLength(1);
    const f = hits[0]!;
    expect(f.explanation).toMatch(/apparaît 4 fois/);
    expect(f.explanation).toMatch(/pour 1000 mots/);
    expect(f.location.label).toBe("Ensemble du document");
  });
});

// ---- 6. Densité de listes ----------------------------------------------------

describe("analyzeTextSignals — densité de listes à puces", () => {
  it("does not flag a long document made mostly of continuous prose", () => {
    const paragraphs = Array.from({ length: 24 }, (_, i) =>
      para(i, `Ce paragraphe numéro ${i} développe une idée en prose continue, sans mise en forme de liste.`, {
        listItem: i % 10 === 0,
      }),
    );
    expect(bySignal(paragraphs, "densite_listes_elevee")).toHaveLength(0);
  });

  it("flags a document that is mostly bullet points despite being long enough to be prose", () => {
    const paragraphs = Array.from({ length: 25 }, (_, i) =>
      para(i, `Élément de liste numéro ${i} avec un contenu bref.`, { listItem: i % 5 !== 0 }),
    );
    const hits = bySignal(paragraphs, "densite_listes_elevee");
    expect(hits).toHaveLength(1);
    const f = hits[0]!;
    expect(f.location.label).toBe("Ensemble du document");
    expect(f.explanation).toMatch(/20 des 25 paragraphes/);
    expect(f.explanation).toMatch(/80 %/);
  });

  it("does not flag a short document even at 100% list density", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => para(i, `Puce ${i}.`, { listItem: true }));
    expect(bySignal(paragraphs, "densite_listes_elevee")).toHaveLength(0);
  });
});

// ---- Robustesse générale ----------------------------------------------------

describe("analyzeTextSignals — cas limites", () => {
  it("returns an empty array for an empty document", () => {
    expect(analyzeTextSignals([])).toEqual([]);
  });

  it("every finding carries a French location label and a category of texte", () => {
    const filler = Array.from({ length: 90 }, (_, i) => `mot${i}`).join(" ");
    const text = `Il est important de noter que ${filler} en outre, ce point mérite d'être creusé.`;
    const findings = analyzeTextSignals([para(0, text)]);
    for (const f of findings) {
      expect(f.category).toBe("texte");
      expect(f.location.label.length).toBeGreaterThan(0);
      expect(f.explanation).toMatch(/\d/);
    }
  });
});
