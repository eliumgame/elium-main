import { describe, it, expect } from "vitest";
import {
  ISSUE_LABELS,
  NARROW_NBSP,
  applyIssue,
  checkText,
  editDistance,
  foldWord,
  parseDictionary,
  suggest,
  summarize,
  words,
  type IssueKind,
} from "../src/editor/proofing";

/** Les familles présentes dans le résultat, dans l'ordre. */
const kinds = (text: string, opts = {}): IssueKind[] => checkText(text, opts).map((i) => i.kind);
const only = (text: string, kind: IssueKind, opts = {}) => checkText(text, opts).filter((i) => i.kind === kind);

describe("Correcteur — repli et découpage", () => {
  it("replie la casse et les accents", () => {
    expect(foldWord("Élève")).toBe("eleve");
    expect(foldWord("ÇA")).toBe("ca");
  });

  it("garde les mots élidés et composés entiers", () => {
    // Les découper produirait des fragments inconnus de tout dictionnaire.
    expect(words("aujourd'hui peut-être l’avion").map((w) => w.text)).toEqual(["aujourd'hui", "peut-être", "l’avion"]);
  });

  it("donne des positions exactes", () => {
    const ws = words("un deux");
    expect(ws[1]).toEqual({ text: "deux", from: 3, to: 7 });
  });

  it("ignore la ponctuation et les chiffres", () => {
    expect(words("a, b. 42 c").map((w) => w.text)).toEqual(["a", "b", "c"]);
  });
});

describe("Correcteur — mots répétés", () => {
  it("détecte une répétition immédiate", () => {
    const found = only("Il a mangé le le gâteau.", "repeated");
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe("le le");
    expect(found[0]!.suggestions).toEqual(["le"]);
  });

  it("ignore la casse et les accents", () => {
    expect(only("Le le chat", "repeated")).toHaveLength(1);
    expect(only("ou où", "repeated")).toHaveLength(1);
  });

  it("ne signale pas deux mots séparés par de la ponctuation", () => {
    // « non, non » est volontaire.
    expect(only("non, non", "repeated")).toHaveLength(0);
  });

  it("laisse passer les répétitions correctes du français", () => {
    expect(only("nous nous levons", "repeated")).toHaveLength(0);
    expect(only("vous vous trompez", "repeated")).toHaveLength(0);
  });

  it("corrige le texte à partir du problème", () => {
    const text = "le le chat";
    const issue = only(text, "repeated")[0]!;
    expect(applyIssue(text, issue)).toBe("le chat");
  });
});

describe("Correcteur — espaces", () => {
  it("détecte les espaces doubles", () => {
    const found = only("un  deux", "double-space");
    expect(found).toHaveLength(1);
    expect(found[0]!.suggestions).toEqual([" "]);
  });

  it("compte les espaces multiples", () => {
    expect(only("un    deux", "double-space")[0]!.message).toContain("4 espaces");
  });
});

describe("Correcteur — ponctuation haute à la française", () => {
  it("exige une fine insécable, pas une espace ordinaire", () => {
    const found = only("Vraiment ?", "space-before-punct");
    expect(found).toHaveLength(1);
    expect(found[0]!.suggestions[0]).toBe(`${NARROW_NBSP}?`);
  });

  it("signale l'absence totale d'espace", () => {
    const found = only("Vraiment?", "space-before-punct");
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("manquante");
  });

  it("accepte une fine insécable déjà présente", () => {
    expect(only(`Vraiment${NARROW_NBSP}?`, "space-before-punct")).toHaveLength(0);
  });

  it("couvre les quatre ponctuations concernées", () => {
    for (const p of [";", ":", "!", "?"]) {
      expect(only(`mot${p}`, "space-before-punct").length).toBe(1);
    }
  });

  it("ne signale pas une heure ni une URL", () => {
    // « 12:30 » et « https:// » ne sont pas de la ponctuation.
    expect(only("Rendez-vous à 12:30", "space-before-punct")).toHaveLength(0);
    expect(only("Voir https://elium.fr", "space-before-punct")).toHaveLength(0);
  });

  it("ne signale pas une ponctuation enchaînée", () => {
    expect(only(`Quoi${NARROW_NBSP}?!`, "space-before-punct")).toHaveLength(0);
  });

  it("corrige en insérant la fine insécable", () => {
    const text = "Vraiment ?";
    const issue = only(text, "space-before-punct")[0]!;
    expect(applyIssue(text, issue)).toBe(`Vraiment${NARROW_NBSP}?`);
  });
});

describe("Correcteur — espace après la ponctuation", () => {
  it("détecte une virgule collée au mot suivant", () => {
    const found = only("un,deux", "space-after-punct");
    expect(found).toHaveLength(1);
    expect(found[0]!.suggestions[0]).toBe(", d");
  });

  it("ne signale pas un nombre décimal ni un millier", () => {
    expect(only("12,5 %", "space-after-punct")).toHaveLength(0);
    expect(only("1.234", "space-after-punct")).toHaveLength(0);
  });

  it("ne signale pas un sigle pointé", () => {
    expect(only("S.A.R.L.", "space-after-punct")).toHaveLength(0);
  });
});

describe("Correcteur — capitale de début de phrase", () => {
  it("détecte une minuscule après un point", () => {
    const found = only("Fin. début", "capital");
    expect(found).toHaveLength(1);
    expect(found[0]!.suggestions).toEqual(["D"]);
  });

  it("détecte une minuscule au tout début", () => {
    expect(only("début de texte", "capital")).toHaveLength(1);
  });

  it("ne signale pas après une abréviation courante", () => {
    // « M. Dupont » ou « etc. suite » n'ouvrent pas une phrase. Les textes
    // commencent par une capitale, sinon la règle de début de texte s'applique —
    // à juste titre.
    expect(only("Voir etc. suite du texte", "capital")).toHaveLength(0);
    expect(only("Voir art. 5 du texte", "capital")).toHaveLength(0);
    expect(only("Écrit par M. dupont", "capital")).toHaveLength(0);
  });

  it("corrige en majuscule accentuée", () => {
    const text = "Fin. étude";
    const issue = only(text, "capital")[0]!;
    expect(applyIssue(text, issue)).toBe("Fin. Étude");
  });
});

describe("Correcteur — guillemets", () => {
  it("détecte un guillemet ouvrant non fermé", () => {
    expect(only("Il dit « bonjour", "unpaired-quote")).toHaveLength(1);
  });

  it("accepte une paire complète", () => {
    expect(only("Il dit « bonjour »", "unpaired-quote")).toHaveLength(0);
  });

  it("gère les imbrications", () => {
    expect(only("« a « b » c »", "unpaired-quote")).toHaveLength(0);
    expect(only("« a « b »", "unpaired-quote")).toHaveLength(1);
  });
});

describe("Correcteur — mots inconnus", () => {
  const dict = ["bonjour", "monde", "chat", "élève"];

  it("ne fait RIEN sans dictionnaire", () => {
    // Un dictionnaire partiel signalerait la moitié d'un texte correct, et
    // l'auteur cesserait de regarder les soulignements.
    expect(kinds("xyzzy plugh")).not.toContain("unknown-word");
  });

  it("signale un mot absent quand un dictionnaire est fourni", () => {
    const found = only("bonjour xyzzy", "unknown-word", { dictionary: dict });
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe("xyzzy");
  });

  it("accepte les accents et la casse du dictionnaire", () => {
    expect(only("Élève", "unknown-word", { dictionary: dict })).toHaveLength(0);
    expect(only("eleve", "unknown-word", { dictionary: dict })).toHaveLength(0);
  });

  it("accepte une forme élidée dont la base est connue", () => {
    expect(only("l’élève", "unknown-word", { dictionary: dict })).toHaveLength(0);
  });

  it("ignore les mots très courts et les sigles", () => {
    expect(only("de la SNCF", "unknown-word", { dictionary: dict })).toHaveLength(0);
  });

  it("respecte le dictionnaire personnel et la liste à ignorer", () => {
    expect(only("Elium", "unknown-word", { dictionary: dict, personal: ["Elium"] })).toHaveLength(0);
    expect(only("Elium", "unknown-word", { dictionary: dict, ignored: ["elium"] })).toHaveLength(0);
  });

  it("propose des suggestions proches", () => {
    const found = only("bonjou", "unknown-word", { dictionary: dict });
    expect(found[0]!.suggestions).toContain("bonjour");
  });
});

describe("Correcteur — distance et suggestions", () => {
  it("calcule la distance d'édition", () => {
    expect(editDistance("chat", "chat")).toBe(0);
    expect(editDistance("chat", "chats")).toBe(1);
    expect(editDistance("chat", "chien")).toBeGreaterThan(2);
  });

  it("sort tôt au-delà de la borne", () => {
    // La borne évite de parcourir un dictionnaire entier caractère par caractère.
    expect(editDistance("a", "abcdefghij", 2)).toBe(3);
  });

  it("trie les suggestions par proximité", () => {
    const s = suggest("chatt", new Set(["chat", "chien", "chatte"]));
    expect(s[0]).toBe("chat");
    expect(s).not.toContain("chien");
  });
});

describe("Correcteur — orchestration", () => {
  it("trie les problèmes par position", () => {
    const issues = checkText("début. le le  chat");
    const positions = issues.map((i) => i.from);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("permet de désactiver une règle", () => {
    expect(kinds("un  deux", { disabled: ["double-space"] })).not.toContain("double-space");
  });

  it("rend une liste vide pour un texte vide", () => {
    expect(checkText("")).toEqual([]);
    expect(checkText(null as never)).toEqual([]);
  });

  it("résume le nombre de problèmes", () => {
    expect(summarize([])).toBe("Aucun problème détecté");
    // « Un  deux » : seule l'espace double est fautive (la capitale est là).
    expect(summarize(checkText("Un  deux"))).toBe("1 problème détecté");
    expect(summarize(checkText("un  deux"))).toBe("2 problèmes détectés");
  });

  it("expose des libellés français", () => {
    expect(ISSUE_LABELS["space-before-punct"]).toBe("Espace avant la ponctuation");
  });

  it("un texte propre ne produit rien", () => {
    const clean = `Bonjour le monde${NARROW_NBSP}! Tout va bien, vraiment.`;
    expect(checkText(clean)).toEqual([]);
  });
});

describe("Correcteur — lecture d'un dictionnaire", () => {
  it("lit une liste de mots, un par ligne", () => {
    expect(parseDictionary("chat\nchien\n\noiseau")).toEqual(["chat", "chien", "oiseau"]);
  });

  it("lit un .dic Hunspell : compteur et drapeaux ignorés", () => {
    expect(parseDictionary("3\nchat/S\nchien/SM\nélève")).toEqual(["chat", "chien", "élève"]);
  });

  it("écarte les commentaires et les lignes à espaces", () => {
    expect(parseDictionary("# commentaire\nchat\ndeux mots")).toEqual(["chat"]);
  });

  it("survit à une entrée vide", () => {
    expect(parseDictionary("")).toEqual([]);
    expect(parseDictionary(null as never)).toEqual([]);
  });
});
