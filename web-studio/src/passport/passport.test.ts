import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import {
  REFERENTIEL,
  activityCoverage,
  completion,
  coveredTasks,
  dossierChecklist,
  duplicateSituation,
  emptyPassport,
  isStale,
  newSituation,
  nextSituationId,
  normalizePassport,
  passportCells,
  situationCodes,
  CONTEXTE_ITEMS,
  newStage,
  stageSummary,
  stageWeeks,
  passportStats,
  situationState,
  toggleActivity,
  toggleTask,
  transferSituation,
} from "./model";
import { CONTEXTE_ANNEXE_LABELS } from "./pdf/pdfContexte";
import { buildFicheDocx, fillTemplateXml, ficheValues } from "./exportFiche";
import { activityLabelOf, backupJson, buildSynopticDocx, parseBackup, synopticRows } from "./exportPasseport";
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import { buildAttestationPdf, buildContextePdf, buildDossierPdf, buildFichePdf, buildSynopticPdf } from "./pdf";
import { woffToSfnt } from "./pdf/woff";
import type { PassportData, Situation, Stage } from "./types";

function filled(id: number): Situation {
  let s = newSituation(id, new Date("2025-03-10T10:00:00Z"));
  s = { ...s, mois: 3, annee: 2025, modalite: "pme", intitule: `Situation <${id}> & « test »` };
  s = toggleTask(s, "1.2.4");
  s = toggleTask(s, "1.2.1");
  return s;
}

describe("référentiel", () => {
  it("4 domaines, 22 activités, 102 tâches, E4 = domaine 1", () => {
    expect(REFERENTIEL.map((d) => d.activities.length)).toEqual([6, 6, 3, 7]);
    expect(REFERENTIEL.reduce((a, d) => a + d.activities.reduce((b, x) => b + x.tasks.length, 0), 0)).toBe(102);
    expect(REFERENTIEL[0].activities[0].id).toBe("1.1");
    expect(REFERENTIEL[0].activities[0].tasks[0].label).toContain("prospection");
  });
});

describe("situations", () => {
  it("numérote en comblant les trous", () => {
    expect(nextSituationId([])).toBe(1);
    expect(nextSituationId([{ id: 1 }, { id: 2 }, { id: 4 }])).toBe(3);
  });

  it("cocher une tâche coche son activité, décocher l'activité retire ses tâches", () => {
    let s = newSituation(1);
    s = toggleTask(s, "1.2.4");
    expect(s.activityIds).toEqual(["1.2"]);
    s = toggleTask(s, "1.2.1");
    expect(s.taskIds).toEqual(["1.2.1", "1.2.4"]);
    s = toggleActivity(s, "1.2");
    expect(s.activityIds).toEqual([]);
    expect(s.taskIds).toEqual([]);
  });

  it("le transfert exige une activité, puis fige un instantané ; une modification le rend périmé", () => {
    const empty = newSituation(1);
    expect(transferSituation(empty)).toBeNull();
    const t = transferSituation(filled(1))!;
    expect(situationState(t)).toBe("validee");
    expect(isStale(t)).toBe(false);
    const edited = toggleTask(t, "1.2.2");
    expect(isStale(edited)).toBe(true);
    expect(situationState(edited)).toBe("a-retransferer");
    expect(isStale({ ...t, intitule: "autre" })).toBe(false); // le texte ne change pas le passeport
  });

  it("la copie reprend le contenu mais pas le transfert", () => {
    const t = transferSituation(filled(1))!;
    const c = duplicateSituation(t, 6);
    expect(c.id).toBe(6);
    expect(c.transfer).toBeUndefined();
    expect(c.taskIds).toEqual(t.taskIds);
    expect(c.taskIds).not.toBe(t.taskIds);
  });

  it("avancement de rédaction", () => {
    expect(completion(newSituation(1))).toBe(0);
    const s = filled(1);
    expect(completion(s)).toBeGreaterThan(0);
    expect(completion(s)).toBeLessThan(100);
  });
});

describe("passeport synoptique", () => {
  const data: PassportData = {
    ...emptyPassport(),
    situations: [
      transferSituation(filled(2))!,
      transferSituation({ ...filled(1), modalite: "avant", mois: 9 })!,
      filled(3),
    ],
  };

  it("place chaque situation validée à l'intersection activité × modalité, triée par numéro", () => {
    const cells = passportCells(data);
    expect(cells.get("1.2|pme")).toEqual([{ spId: 2, period: "Mars 2025", code: "GRCF 2" }]);
    expect(cells.get("1.2|avant")).toEqual([{ spId: 1, period: "Septembre 2025", code: "GRCF 1" }]);
    expect(cells.get("1.2|etablissement")).toBeUndefined();
  });

  it("n'inclut pas les situations non validées (SP3)", () => {
    expect([...passportCells(data).values()].flat().some((m) => m.spId === 3)).toBe(false);
    expect(coveredTasks(data).get("1.2.4")).toEqual([1, 2]);
  });

  it("couverture et statistiques", () => {
    const cov = activityCoverage(data).find((c) => c.activity.id === "1.2")!;
    expect(cov.situations).toEqual([1, 2]);
    expect(cov.tasksCovered).toBe(2);
    const st = passportStats(data);
    expect(st.total).toBe(3);
    expect(st.validated).toBe(2);
    expect(st.e4TasksCovered).toBe(2);
  });

  it("liste de contrôle du dossier", () => {
    const items = dossierChecklist(data);
    expect(items.find((i) => i.id === "coverage")!.ok).toBe(false);
    expect(items.find((i) => i.id === "holder")!.ok).toBe(false);
    expect(items.find((i) => i.id === "validated")!.ok).toBe(true);
  });

  it("les identifiants (GRCF n, CE n, CO n) sont déduits de la nature et du rang, ou saisis", () => {
    const two = [
      { ...filled(1), natures: ["grcf"] as Situation["natures"] },
      { ...filled(2), natures: ["grcf", "ecrite"] as Situation["natures"] },
      { ...filled(3), natures: ["orale"] as Situation["natures"] },
    ];
    expect(situationCodes(two[0], two)).toEqual(["GRCF 1"]);
    expect(situationCodes(two[1], two)).toEqual(["GRCF 2", "CE1"]);
    expect(situationCodes(two[2], two)).toEqual(["CO1"]);
    expect(situationCodes({ ...two[0], code: "GRCF 3 ; CE2" }, two)).toEqual(["GRCF 3", "CE2"]);
  });

  it("le synoptique reprend le modèle officiel : domaine 1 par défaut, identifiants par modalité, solutions par activité", () => {
    const rows = synopticRows({ ...data, solutions: { "1.2": "Ypariéo ; Excel" } });
    expect(rows).toHaveLength(29); // 29 tâches du domaine 1
    expect(rows[0].firstOfDomain).toBe(true);
    expect(rows[0].activityLabel).toBe("Activité_1.1._Recherche_de_clientèle_et_contact");
    const r12 = rows.find((r) => r.activity.id === "1.2" && r.first)!;
    expect(r12.solutions).toBe("Ypariéo ; Excel");
    expect(r12.marks.pme).toBe("GRCF 2");
    expect(r12.marks.avant).toBe("GRCF 1");
    expect(synopticRows(data, { allDomains: true })).toHaveLength(102);
    expect(activityLabelOf(REFERENTIEL[0].activities[4])).toBe(
      "Activité_1.5._Suivi_et_contrôle_des_opérations_d_achats_et_d_investissement_de_la_PME",
    );
  });

  it("le Word synoptique est produit (paysage, bande jaune verticale)", () => {
    const files = unzipSync(buildSynopticDocx(data));
    const doc = strFromU8(files["word/document.xml"]);
    expect(doc).toContain("GRCF 1");
    expect(doc).toContain('w:orient="landscape"');
    expect(doc).toContain("FFFF00");
    expect(doc).toContain("btLr");
  });

  it("les PDF sont des PDF valides : fiche (2 pages), synoptique, dossier", async () => {
    const f = (n: string) => woffToSfnt(new Uint8Array(readFileSync(`src/passport/pdf/fonts/${n}`)));
    const fonts = { regular: f("carlito-latin-400-normal.woff"), bold: f("carlito-latin-700-normal.woff") };
    const holder = { ...emptyPassport().holder, nom: "Dupont", prenom: "Léa" };
    const long = { ...filled(1), analyse: "mot ".repeat(2500), cadre: "ligne\nsuivante ".repeat(80) };
    const fiche = await buildFichePdf(holder, long, fonts);
    expect(strFromU8(fiche.slice(0, 5))).toBe("%PDF-");
    const reread = await PDFDocument.load(fiche);
    expect(reread.getPageCount()).toBeGreaterThanOrEqual(3); // texte long : la rubrique passe à la page suivante
    const syn = await buildSynopticPdf({ ...data, holder }, fonts);
    expect((await PDFDocument.load(syn)).getPageCount()).toBeGreaterThanOrEqual(1);
    const dossier = await buildDossierPdf({ ...data, holder }, fonts, { onlyValidated: true });
    const n = (await PDFDocument.load(dossier)).getPageCount();
    expect(n).toBeGreaterThanOrEqual(1 + 2 * 2); // synoptique + 2 fiches validées (recto + verso)
    // sans polices Carlito : repli Helvetica, sans erreur
    expect((await PDFDocument.load(await buildFichePdf(holder, filled(1), null))).getPageCount()).toBe(2);
  });
});

describe("fiche d'analyse Word (modèle officiel)", () => {
  const holder = { ...emptyPassport().holder, nom: "Dupont", prenom: "Léa", numeroCandidat: "0123", session: "2026" };
  const s = {
    ...filled(7),
    natures: ["grcf", "orale"] as Situation["natures"],
    activityIds: ["1.2", "1.5"],
    analyse: "Ligne 1\nLigne 2 avec <balise> & esperluette",
  };

  it("remplace toutes les balises, même coupées entre plusieurs runs", () => {
    const files = unzipSync(buildFicheDocx(holder, s));
    const xml = strFromU8(files["word/document.xml"]);
    for (const k of Object.keys(ficheValues(holder, s))) expect(xml).not.toContain(`&lt;${k}&gt;`);
    const text = xml.replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "");
    expect(text).toContain("DUPONT Léa");
    expect(text).toContain("SP7");
    expect(text).toContain("Mars");
    expect(text).toContain("Situation &lt;7&gt; &amp; « test »");
    expect(text).toContain("Ligne 1\nLigne 2 avec &lt;balise&gt; &amp; esperluette");
    expect(text).toContain("☒ GRCF");
    expect(text).toContain("☐ Communication écrite");
    expect(text).toContain("☒ Pendant la formation en milieu professionnel");
    expect(text).toContain("☒  Activité 1.2");
    expect(text).toContain("☐  Activité 1.1");
  });

  it("le paquet reste un docx valide (parties conservées, XML bien formé)", () => {
    const files = unzipSync(buildFicheDocx(holder, s));
    expect(Object.keys(files)).toContain("[Content_Types].xml");
    expect(Object.keys(files)).toContain("word/styles.xml");
    const xml = strFromU8(files["word/document.xml"]);
    const opens = (xml.match(/<w:p(?:\s[^>]*?)?(?<!\/)>/g) ?? []).length;
    const closes = (xml.match(/<\/w:p>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("valeurs de balises et HTML d'impression", () => {
    expect(ficheValues(holder, s).Prob3).toBe("☐");
    expect(
      fillTemplateXml("<w:p><w:r><w:t>&lt;</w:t></w:r><w:r><w:t>X</w:t></w:r><w:r><w:t>&gt; fin</w:t></w:r></w:p>", {
        X: "ok",
      }),
    ).toContain("ok");
  });
});

describe("sauvegarde / import", () => {
  it("aller-retour et nettoyage des données invalides", () => {
    const data: PassportData = { ...emptyPassport(), situations: [transferSituation(filled(1))!] };
    data.holder.nom = "Martin";
    const back = normalizePassport(parseBackup(backupJson(data)))!;
    expect(back.holder.nom).toBe("Martin");
    expect(back.situations[0].transfer?.taskIds).toEqual(["1.2.1", "1.2.4"]);
    expect(back.contexte).toHaveLength(12);

    const dirty = normalizePassport({
      holder: { nom: 5 },
      situations: [{ id: 2, activityIds: ["9.9", "1.1"], taskIds: ["x"], mois: 99 }, { id: 2 }, { id: 0 }, null],
    })!;
    expect(dirty.situations).toHaveLength(1);
    expect(dirty.situations[0].activityIds).toEqual(["1.1"]);
    expect(dirty.situations[0].mois).toBe(12);
    expect(normalizePassport("n'importe quoi")).toBeNull();
  });
});

describe("périodes en entreprise (stage, alternance, activité salariée)", () => {
  const base = () => {
    const d = emptyPassport();
    d.holder.session = "2027";
    return d;
  };
  const st = (over: Partial<Stage>): Stage => ({ ...newStage("x"), ...over });

  it("durée : champ saisi, sinon calculée sur les dates", () => {
    expect(stageWeeks(st({ semaines: "6" }))).toBe(6);
    expect(stageWeeks(st({ semaines: "2,5" }))).toBe(2.5);
    expect(stageWeeks(st({ debut: "2026-05-04", fin: "2026-06-12" }))).toBe(5.7); // 40 jours
    expect(stageWeeks(st({ debut: "2026-06-12", fin: "2026-05-04" }))).toBe(0);
    expect(stageWeeks(st({}))).toBe(0);
  });

  it("répartit par nature et par année du cycle, et compte ce qu'il reste", () => {
    const d = base();
    d.stages = [
      st({ id: "a", type: "stage", debut: "2026-05-04", fin: "2026-06-12", semaines: "6" }), // 1re année (session 2027)
      st({ id: "b", type: "stage", debut: "2027-02-01", fin: "2027-03-05", semaines: "4" }), // 2e année
      st({ id: "c", type: "alternance", debut: "2027-03-08", fin: "2027-03-19", semaines: "2" }), // 2e année
      st({ id: "d", type: "emploi", debut: "", fin: "", semaines: "1" }), // sans date
    ];
    const s = stageSummary(d);
    expect(s.totalWeeks).toBe(13);
    expect(s.byType).toEqual({ stage: 10, alternance: 2, emploi: 1 });
    expect(s.year1).toBe(6);
    expect(s.year2).toBe(6);
    expect(s.longestYear2).toBe(4);
    expect(s.other).toBe(1);
    expect(s.required).toBe(12);
    expect(s.remaining).toBe(0);
    d.parcours.requiredWeeks = 14;
    expect(stageSummary(d).remaining).toBe(1);
  });

  it("alternance / salarié : aucune durée de stage exigée", () => {
    const d = base();
    d.parcours.voie = "apprentissage";
    d.stages = [st({ type: "alternance", semaines: "30", attestationRecue: true })];
    const s = stageSummary(d);
    expect(s.required).toBe(0);
    expect(s.remaining).toBe(0);
    const items = dossierChecklist(d);
    expect(items.find((i) => i.id === "stages")!.ok).toBe(true);
    expect(items.find((i) => i.id === "attestations")!.ok).toBe(true);
  });

  it("liste de contrôle voie scolaire : il manque des semaines", () => {
    const d = base();
    d.stages = [st({ semaines: "5" })];
    const it = dossierChecklist(d).find((i) => i.id === "stages")!;
    expect(it.ok).toBe(false);
    expect(it.detail).toContain("il en manque 7");
  });

  it("l'import réapplique les valeurs par défaut et rejette les natures inconnues", () => {
    const back = normalizePassport({
      situations: [],
      stages: [{ id: "z", type: "bizarre", semaines: "3" }],
      parcours: { voie: "inconnue", requiredWeeks: 999 },
    })!;
    expect(back.stages[0].type).toBe("stage");
    expect(back.parcours).toEqual({ voie: "scolaire", requiredWeeks: 60 });
  });
});

describe("attestation de stage et contexte commercial en PDF", () => {
  const f = (n: string) => woffToSfnt(new Uint8Array(readFileSync(`src/passport/pdf/fonts/${n}`)));
  const fonts = { regular: f("carlito-latin-400-normal.woff"), bold: f("carlito-latin-700-normal.woff") };

  it("l'attestation tient sur une page A4, remplie ou vide, avec des valeurs très longues", async () => {
    const h = { ...emptyPassport().holder, nom: "Sihl", prenom: "Ludovic", etablissement: "Lycée Exemple" };
    const st = {
      ...newStage("a"),
      organisme: "SARL " + "Très longue raison sociale ".repeat(12),
      missionsE4: "mot ".repeat(400),
      debut: "2026-05-04",
      fin: "2026-06-12",
    };
    const full = await PDFDocument.load(await buildAttestationPdf(h, st, "2026", fonts));
    expect(full.getPageCount()).toBe(1);
    expect(full.getPage(0).getSize()).toEqual({ width: 595.32, height: 841.92 });
    expect(
      (
        await PDFDocument.load(await buildAttestationPdf(emptyPassport().holder, newStage("b"), "2026", null))
      ).getPageCount(),
    ).toBe(1);
  });

  it("le contexte commercial reprend les 12 éléments de l'annexe V-3, dans l'ordre", async () => {
    expect(CONTEXTE_ANNEXE_LABELS).toHaveLength(12);
    expect(CONTEXTE_ANNEXE_LABELS).toHaveLength(CONTEXTE_ITEMS.length);
    const d = emptyPassport();
    d.contexte[0] = { id: "identite", done: true, notes: "SARL Exemple, 12 salariés.\n".repeat(60) };
    const pdf = await PDFDocument.load(await buildContextePdf(d, fonts));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2); // notes longues : passage à la page suivante
  });
});
