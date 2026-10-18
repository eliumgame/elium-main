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
  passportStats,
  situationState,
  toggleActivity,
  toggleTask,
  transferSituation,
} from "./model";
import { buildFicheDocx, fillTemplateXml, ficheHtml, ficheValues } from "./exportFiche";
import { backupJson, buildSynopticDocx, parseBackup, synopticHtml, synopticRows } from "./exportPasseport";
import type { PassportData, Situation } from "./types";

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
    expect(cells.get("1.2|pme")).toEqual([{ spId: 2, period: "Mars 2025" }]);
    expect(cells.get("1.2|avant")).toEqual([{ spId: 1, period: "Septembre 2025" }]);
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

  it("les exports synoptiques sont produits (HTML + Word)", () => {
    expect(synopticRows(data).filter((r) => r.kind === "task")).toHaveLength(102);
    const html = synopticHtml(data);
    expect(html).toContain("SP2 – Mars 2025");
    const files = unzipSync(buildSynopticDocx(data));
    const doc = strFromU8(files["word/document.xml"]);
    expect(doc).toContain("SP1 – Septembre 2025");
    expect(doc).toContain('w:orient="landscape"');
    expect((doc.match(/<w:tr[ >]/g) ?? []).length).toBe(102 + 4 + 1);
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
    expect(ficheHtml(holder, s)).toContain("Situation &lt;7&gt; &amp; « test »");
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
