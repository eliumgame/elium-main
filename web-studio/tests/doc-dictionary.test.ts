import { describe, it, expect } from "vitest";
import { embeddedDictionary, listDictionary, mergeDictionaries } from "../src/editor/dict";
import {
  adjectiveForms, adverbsFr, conjugateEr, conjugateFamily, conjugateIr2, femininesFr, nounForms,
  pluralsFr, splitCompound,
} from "../src/editor/dict/morphology-fr";
import { enForms } from "../src/editor/dict/lexicon-en";

const fr = embeddedDictionary("fr");
const en = embeddedDictionary("en");

describe("Morphologie française — pluriels et féminins", () => {
  it("applique les règles de pluriel", () => {
    expect(pluralsFr("table")).toContain("tables");
    expect(pluralsFr("bureau")).toContain("bureaux");
    expect(pluralsFr("cheval")).toContain("chevaux");
    expect(pluralsFr("travail")).toContain("travaux");
    // Un mot déjà terminé par s/x/z est invariable.
    expect(pluralsFr("cas")).toEqual(["cas"]);
    expect(pluralsFr("croix")).toEqual(["croix"]);
  });

  it("accepte les deux formes quand l'usage hésite", () => {
    // « pneus » et non « pneux » : la règle générale donnerait le second, donc les
    // deux sont produits plutôt que d'en souligner un correct.
    expect(pluralsFr("pneu")).toContain("pneus");
    expect(pluralsFr("festival")).toContain("festivals");
    expect(pluralsFr("bijou")).toContain("bijoux");
  });

  it("forme les féminins par famille", () => {
    expect(femininesFr("heureux")).toContain("heureuse");
    expect(femininesFr("actif")).toContain("active");
    expect(femininesFr("léger")).toContain("légère");
    expect(femininesFr("cruel")).toContain("cruelle");
    expect(femininesFr("ancien")).toContain("ancienne");
    expect(femininesFr("acteur")).toContain("actrice");
    expect(femininesFr("public")).toContain("publique");
    expect(femininesFr("rouge")).toEqual(["rouge"]);
  });

  it("accorde un adjectif aux quatre formes", () => {
    const forms = adjectiveForms("heureux");
    expect(forms).toContain("heureux");
    expect(forms).toContain("heureuse");
    expect(forms).toContain("heureuses");
  });

  it("dérive les adverbes en -ment", () => {
    expect(adverbsFr("lent")).toContain("lentement");
    expect(adverbsFr("prudent")).toContain("prudemment");
    expect(adverbsFr("constant")).toContain("constamment");
    expect(adverbsFr("vrai")).toContain("vraiment");
  });

  it("rend un nom avec ses pluriels", () => {
    expect(nounForms("dossier")).toEqual(["dossier", "dossiers"]);
  });
});

describe("Morphologie française — conjugaisons", () => {
  it("conjugue le 1er groupe, alternances comprises", () => {
    const parler = conjugateEr("parler");
    for (const f of ["parle", "parles", "parlons", "parlez", "parlent", "parlais", "parlerai", "parlé", "parlant"]) {
      expect(parler).toContain(f);
    }
    // Alternances orthographiques : ç, ge, è, doublement, y → i.
    expect(conjugateEr("placer")).toContain("plaçons");
    expect(conjugateEr("manger")).toContain("mangeons");
    expect(conjugateEr("manger")).toContain("mangeait");
    expect(conjugateEr("acheter")).toContain("achète");
    expect(conjugateEr("appeler")).toContain("appelle");
    expect(conjugateEr("employer")).toContain("emploie");
    expect(conjugateEr("préférer")).toContain("préfère");
    // Le futur suit l'alternance : j'achèterai, j'emploierai.
    expect(conjugateEr("acheter")).toContain("achèterai");
    expect(conjugateEr("employer")).toContain("emploierai");
  });

  it("conjugue le 2e groupe", () => {
    const finir = conjugateIr2("finir");
    for (const f of ["finis", "finit", "finissons", "finissez", "finissent", "finissait", "finirai", "fini", "finissant"]) {
      expect(finir).toContain(f);
    }
  });

  it("conjugue chaque famille du 3e groupe", () => {
    const cases: [string, string[]][] = [
      ["attendre", ["attends", "attend", "attendons", "attendu", "attendrai", "attendant", "attendis"]],
      ["prendre", ["prends", "prend", "prenons", "prennent", "pris", "prendrai", "prenne"]],
      ["mettre", ["mets", "met", "mettons", "mis", "mettrai", "mettant"]],
      ["venir", ["viens", "vient", "venons", "viennent", "venu", "viendrai", "vienne", "vinrent"]],
      ["partir", ["pars", "part", "partons", "partent", "parti", "partirai", "partant"]],
      ["dormir", ["dors", "dort", "dormons", "dormi", "dormirai"]],
      ["servir", ["sers", "sert", "servons", "servi"]],
      ["conduire", ["conduis", "conduit", "conduisons", "conduisant", "conduirai"]],
      ["craindre", ["crains", "craint", "craignons", "craignant", "craindrai"]],
      ["peindre", ["peins", "peint", "peignons", "peint"]],
      ["connaître", ["connais", "connaît", "connaissons", "connu", "connaîtrai"]],
      ["recevoir", ["reçois", "reçoit", "recevons", "reçoivent", "reçu", "recevrai"]],
      ["écrire", ["écris", "écrit", "écrivons", "écrivant", "écrirai"]],
      ["vivre", ["vis", "vit", "vivons", "vécu", "vivrai"]],
      ["suivre", ["suis", "suit", "suivons", "suivi"]],
      ["ouvrir", ["ouvre", "ouvres", "ouvrons", "ouvert", "ouvrirai"]],
      ["courir", ["cours", "court", "courons", "couru", "courrai"]],
      ["lire", ["lis", "lit", "lisons", "lu", "lirai"]],
      ["rire", ["ris", "rit", "rions", "ri"]],
      ["conclure", ["conclus", "conclut", "concluons", "conclurai"]],
      ["rompre", ["romps", "rompt", "rompons", "rompu"]],
    ];
    for (const [inf, forms] of cases) {
      const got = conjugateFamily(inf);
      expect(got, inf).not.toBeNull();
      for (const f of forms) expect(got, `${inf} → ${f}`).toContain(f);
    }
  });

  it("refuse d'inventer une conjugaison hors famille", () => {
    // Mieux vaut ne rien produire qu'une forme fausse : l'appelant retombe alors
    // sur le seul infinitif.
    expect(conjugateFamily("aller")).toBeNull();
    expect(conjugateFamily("finir")).toBeNull();
  });

  it("reconnaît élisions et enclises", () => {
    expect(splitCompound("qu'il")).toEqual(["il"]);
    expect(splitCompound("c'est")).toEqual(["est"]);
    expect(splitCompound("jusqu'ici")).toEqual(["ici"]);
    expect(splitCompound("allons-y")).toEqual(["allons"]);
    expect(splitCompound("donne-le-moi")).toEqual(["donne"]);
    expect(splitCompound("porte-manteau")).toBeNull();
  });
});

describe("Dictionnaire français embarqué", () => {
  it("couvre un vrai vocabulaire", () => {
    // Un lexique trop petit ne servirait à rien ; l'ordre de grandeur compte.
    expect(fr.size).toBeGreaterThan(60000);
  });

  it("connaît les mots les plus courants", () => {
    const common = `le la les un une des de du et ou mais donc car pour dans sur avec sans
      être avoir faire dire aller voir savoir pouvoir vouloir devoir venir prendre
      bonjour merci monsieur madame document page texte tableau réunion projet client
      entreprise facture contrat rapport travail temps jour semaine mois année`.split(/\s+/);
    for (const w of common) expect(fr.known(w), w).toBe(true);
  });

  it("connaît les formes fléchies, pas seulement les entrées", () => {
    for (const w of [
      "sommes", "étaient", "aurons", "fîmes", "mangeons", "appelle", "achèterai",
      "finissaient", "partirions", "prendrons", "connaîtra", "reçoivent", "écrivait",
      "vécu", "ouvert", "courrai", "chevaux", "heureuses", "publiques", "lentement",
    ]) {
      expect(fr.known(w), w).toBe(true);
    }
  });

  it("accepte les élisions, les enclises et les mots composés", () => {
    for (const w of ["qu'il", "c'est", "d'accord", "aujourd'hui", "allons-y", "rendez-vous", "week-end"]) {
      expect(fr.known(w), w).toBe(true);
    }
  });

  it("accepte les préfixes productifs sur un verbe connu", () => {
    // « redemander » ne figure dans aucun lexique raisonnable, et se forme librement.
    for (const w of ["redemander", "réécrire", "recalculer", "reprogrammer", "désactiver"]) {
      expect(fr.known(w), w).toBe(true);
    }
    // Mais le préfixe ne suffit pas : le reste doit être un verbe connu.
    expect(fr.known("rexyzabc")).toBe(false);
  });

  it("tolère les capitales sans accent", () => {
    // « ECOLE » et « ELEVE » s'écrivent sans accent par convention typographique.
    expect(fr.known("ECOLE")).toBe(true);
    expect(fr.known("REUNION")).toBe(true);
    // En minuscules, l'accent manquant reste une faute.
    expect(fr.known("reunion")).toBe(false);
  });

  it("ignore ce qui n'existe pas", () => {
    for (const w of ["xyzabc", "qsdfgh", "zzzz", "aaaaaa"]) expect(fr.known(w), w).toBe(false);
  });

  it("propose l'accent en premier — la faute la plus fréquente", () => {
    expect(fr.suggest("etre")[0]).toBe("être");
    expect(fr.suggest("deja")[0]).toBe("déjà");
    expect(fr.suggest("francais")[0]).toBe("français");
    expect(fr.suggest("reunion")[0]).toBe("réunion");
  });

  it("corrige les fautes de frappe ordinaires", () => {
    expect(fr.suggest("recevior")).toContain("recevoir");
    expect(fr.suggest("tavail")).toContain("travail");
    expect(fr.suggest("bonjuor")).toContain("bonjour");
    expect(fr.suggest("documnet")).toContain("document");
  });

  it("rend la casse du mot corrigé", () => {
    expect(fr.suggest("Etre")[0]).toBe("Être");
  });

  it("ne propose rien pour un mot correct", () => {
    expect(fr.suggest("bonjour")).toEqual([]);
  });

  it("borne le nombre de propositions", () => {
    expect(fr.suggest("documnet", 2).length).toBeLessThanOrEqual(2);
  });
});

describe("Dictionnaire anglais embarqué", () => {
  it("génère les formes régulières", () => {
    expect(enForms("work")).toContain("works");
    expect(enForms("work")).toContain("worked");
    expect(enForms("work")).toContain("working");
    expect(enForms("make")).toContain("making");
    expect(enForms("stop")).toContain("stopping");
    expect(enForms("company")).toContain("companies");
    expect(enForms("box")).toContain("boxes");
  });

  it("connaît le vocabulaire courant et les formes irrégulières", () => {
    for (const w of ["meeting", "companies", "went", "children", "understood", "data", "email", "review"]) {
      expect(en.known(w), w).toBe(true);
    }
  });

  it("distingue les deux langues", () => {
    // « the » n'est pas un mot français, « bonjour » n'est pas anglais : deux
    // dictionnaires distincts, sinon le correcteur ne signalerait plus rien.
    expect(en.known("the")).toBe(true);
    expect(fr.known("the")).toBe(false);
    expect(en.known("bonjour")).toBe(false);
  });

  it("corrige une faute anglaise", () => {
    expect(en.suggest("recieve")).toContain("receive");
    expect(en.suggest("teh")).toContain("the");
  });
});

describe("Dictionnaire importé et fusion", () => {
  it("accepte une liste de mots fournie, sans accents ni casse", () => {
    const d = listDictionary(["Zorglub", "flibustier"]);
    expect(d.known("zorglub")).toBe(true);
    expect(d.known("ZORGLUB")).toBe(true);
    expect(d.known("flibustier")).toBe(true);
    expect(d.known("inconnu")).toBe(false);
    expect(d.size).toBe(2);
  });

  it("complète le dictionnaire embarqué avec un dictionnaire de métier", () => {
    const merged = mergeDictionaries(fr, listDictionary(["zorglub"], "Métier"));
    expect(merged.known("bonjour")).toBe(true);
    expect(merged.known("zorglub")).toBe(true);
    expect(merged.label).toContain("Métier");
  });
});
