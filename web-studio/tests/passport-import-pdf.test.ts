// Doit rester le tout premier import — voir pdfjs-node-shim.ts.
import "./pdfjs-node-shim";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
// Évalue `pdf/core/engine` (qui fixe son worker) AVANT que ce test ne le redirige vers le fichier réel.
import "../src/detector/ingest/loadFile";
import { importFicheFile } from "../src/passport/ficheImport";
import { emptyPassport, newSituation, toggleTask } from "../src/passport/model";
import { buildFichePdf } from "../src/passport/pdf";
import { woffToSfnt } from "../src/passport/pdf/woff";
import type { Situation } from "../src/passport/types";

// Sous vitest simple, le worker pdf.js (chemin `?url` de Vite) n'est pas résoluble : on le pointe sur le fichier réel.
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

describe("import d'une fiche PDF produite par Elium", () => {
  const f = (n: string) => woffToSfnt(new Uint8Array(readFileSync(`src/passport/pdf/fonts/${n}`)));
  const fonts = { regular: f("carlito-latin-400-normal.woff"), bold: f("carlito-latin-700-normal.woff") };
  const holder = { ...emptyPassport().holder, nom: "Sihl", prenom: "Ludovic", numeroCandidat: "0123", session: "2027" };

  it("retrouve le texte, le numéro et les cases cochées (marqueurs invisibles)", async () => {
    let s: Situation = newSituation(3, new Date("2026-03-02"));
    s = toggleTask(toggleTask(s, "1.2.4"), "1.6.2");
    s = {
      ...s,
      modalite: "pme",
      condition: "accompagnee",
      natures: ["grcf", "ecrite"],
      intitule: "Relance des factures impayées",
      lieuPeriodeDuree: "SARL Exemple, Paris — mars 2026",
      cadre: "L'entreprise vend des fournitures de bureau.",
      problemeGestion: "Réduire les retards de paiement.",
      problemeEcrit: "Rédiger des relances graduées.",
      acteurs: "Le gérant et la comptable.",
      objectif: "Passer à 45 jours de délai moyen.",
      analyse: "J'ai analysé les retards puis relancé.",
      contribution: "J'ai appris à relancer.",
    };
    const imp = await importFicheFile(new File([(await buildFichePdf(holder, s, fonts)) as BlobPart], "fiche.pdf"));
    expect(imp.number).toBe(3);
    expect(imp.situation.intitule).toBe("Relance des factures impayées");
    expect(imp.situation.cadre).toContain("fournitures de bureau");
    expect(imp.situation.problemeGestion).toContain("retards de paiement");
    expect(imp.situation.problemeEcrit).toContain("relances graduées");
    expect(imp.situation.analyse).toContain("analysé les retards");
    expect(imp.situation.modalite).toBe("pme");
    expect(imp.situation.condition).toBe("accompagnee");
    expect(imp.situation.activityIds).toEqual(["1.2", "1.6"]);
    expect([...imp.situation.natures].sort()).toEqual(["ecrite", "grcf"]);
  });
});
