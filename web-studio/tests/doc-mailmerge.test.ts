import { describe, it, expect } from "vitest";
import {
  applyMerge,
  detectDelimiter,
  mergeAll,
  mergeCombined,
  missingFields,
  parseDataSource,
  parseDelimited,
  recordLabel,
  usedFields,
} from "../src/editor/mailmerge";
import type { ProseMirrorNode } from "../src/format/types";

const field = (name: string): ProseMirrorNode => ({ type: "mergeField", attrs: { field: name } });
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });
const para = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", content });
const t = (text: string): ProseMirrorNode => ({ type: "text", text });

const flat = (node: ProseMirrorNode): string => {
  if (node.text != null) return node.text;
  return (node.content ?? []).map(flat).join("");
};

describe("Publipostage — détection du séparateur", () => {
  it("reconnaît la virgule, le point-virgule et la tabulation", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
  });

  it("ne compte pas les séparateurs entre guillemets", () => {
    expect(detectDelimiter('"Nom, Prénom";Ville;Pays')).toBe(";");
  });
});

describe("Publipostage — analyse de la source", () => {
  it("lit un CSV simple", () => {
    const data = parseDataSource("Nom,Ville\nDupont,Lyon\nMartin,Nantes");
    expect(data.fields).toEqual(["Nom", "Ville"]);
    expect(data.records).toEqual([
      { Nom: "Dupont", Ville: "Lyon" },
      { Nom: "Martin", Ville: "Nantes" },
    ]);
  });

  it("gère les guillemets, les séparateurs et les retours à la ligne inclus", () => {
    const data = parseDataSource('Nom,Adresse\n"Dupont, Jean","12 rue A\nLyon"');
    expect(data.records[0]).toEqual({ Nom: "Dupont, Jean", Adresse: "12 rue A\nLyon" });
  });

  it("gère les guillemets échappés", () => {
    const data = parseDataSource('Titre\n"Le ""grand"" jour"');
    expect(data.records[0]!.Titre).toBe('Le "grand" jour');
  });

  it("gère CRLF et le BOM", () => {
    const data = parseDataSource("﻿Nom,Ville\r\nDupont,Lyon\r\n");
    expect(data.fields).toEqual(["Nom", "Ville"]);
    expect(data.records).toHaveLength(1);
    expect(data.records[0]).toEqual({ Nom: "Dupont", Ville: "Lyon" });
  });

  it("répare les en-têtes vides ou dupliqués", () => {
    const data = parseDataSource("Nom,,Nom\na,b,c");
    expect(data.fields).toEqual(["Nom", "Colonne 2", "Nom (2)"]);
    expect(data.records[0]).toEqual({ Nom: "a", "Colonne 2": "b", "Nom (2)": "c" });
  });

  it("complète les lignes trop courtes et ignore les lignes vides finales", () => {
    const data = parseDataSource("Nom,Ville\nDupont\n\n");
    expect(data.records).toEqual([{ Nom: "Dupont", Ville: "" }]);
  });

  it("rend une source vide pour un texte vide", () => {
    expect(parseDataSource("")).toEqual({ fields: [], records: [] });
  });

  it("ne perd pas une cellule finale vide", () => {
    expect(parseDelimited("a,b,\n", ",")).toEqual([["a", "b", ""]]);
  });
});

describe("Publipostage — champs du document", () => {
  const model = doc(
    para(t("Bonjour "), field("Prénom"), t(" "), field("Nom")),
    para(t("Votre ville : {Ville}. Le {date} — {titre}")),
  );

  it("liste les champs utilisés, nœuds et jetons texte", () => {
    expect(usedFields(model).sort()).toEqual(["Nom", "Prénom", "Ville"]);
  });

  it("ne confond pas les jetons d'en-tête {titre} et {date} avec des champs", () => {
    expect(usedFields(model)).not.toContain("date");
    expect(usedFields(model)).not.toContain("titre");
  });

  it("signale les champs absents de la source", () => {
    const data = parseDataSource("Nom,Prénom\nDupont,Jean");
    expect(missingFields(model, data)).toEqual(["Ville"]);
  });

  it("compare les noms de champ sans tenir compte de la casse", () => {
    const data = parseDataSource("nom,prénom,ville\na,b,c");
    expect(missingFields(model, data)).toEqual([]);
  });
});

describe("Publipostage — fusion d'un enregistrement", () => {
  const model = doc(para(t("Bonjour "), field("Prénom"), t(", bienvenue à {Ville}.")));

  it("remplace les nœuds de champ et les jetons texte", () => {
    const merged = applyMerge(model, { Prénom: "Jean", Ville: "Lyon" });
    expect(flat(merged)).toBe("Bonjour Jean, bienvenue à Lyon.");
    expect(JSON.stringify(merged)).not.toContain("mergeField");
  });

  it("trouve la colonne quelle que soit la casse", () => {
    expect(flat(applyMerge(model, { prénom: "Ana", VILLE: "Nice" }))).toBe("Bonjour Ana, bienvenue à Nice.");
  });

  it("utilise la valeur de repli pour une colonne absente", () => {
    expect(flat(applyMerge(model, { Ville: "Lyon" }, { fallback: "—" }))).toBe("Bonjour —, bienvenue à Lyon.");
  });

  it("laisse le jeton texte intact quand la colonne n'existe pas", () => {
    expect(flat(applyMerge(doc(para(t("Ville : {Inconnu}"))), { Nom: "x" }))).toBe("Ville : {Inconnu}");
  });

  it("peut ne pas développer les jetons texte", () => {
    const merged = applyMerge(model, { Prénom: "Jean", Ville: "Lyon" }, { expandTextTokens: false });
    expect(flat(merged)).toBe("Bonjour Jean, bienvenue à {Ville}.");
  });

  it("conserve la mise en forme portée par le champ", () => {
    const bold: ProseMirrorNode = { ...field("Nom"), marks: [{ type: "bold" }] };
    const merged = applyMerge(doc(para(bold)), { Nom: "Dupont" });
    const text = merged.content![0]!.content![0]!;
    expect(text).toMatchObject({ type: "text", text: "Dupont", marks: [{ type: "bold" }] });
  });

  it("supprime le champ quand la valeur est vide", () => {
    const merged = applyMerge(doc(para(t("A"), field("Vide"), t("B"))), { Vide: "" });
    expect(flat(merged)).toBe("AB");
    expect(merged.content![0]!.content).toHaveLength(2);
  });
});

describe("Publipostage — fusion de tout le lot", () => {
  const model = doc(para(t("Cher "), field("Nom")));
  const data = parseDataSource("Nom\nDupont\nMartin\nDurand");

  it("produit un document par enregistrement", () => {
    const docs = mergeAll(model, data);
    expect(docs).toHaveLength(3);
    expect(docs.map(flat)).toEqual(["Cher Dupont", "Cher Martin", "Cher Durand"]);
  });

  it("respecte la sélection d'enregistrements", () => {
    expect(mergeAll(model, data, { selected: [2, 0] }).map(flat)).toEqual(["Cher Durand", "Cher Dupont"]);
  });

  it("ignore les indices hors bornes", () => {
    expect(mergeAll(model, data, { selected: [0, 99, -1] })).toHaveLength(1);
  });

  it("combine tout en un document séparé par des sauts de page", () => {
    const combined = mergeCombined(model, data);
    const breaks = (combined.content ?? []).filter((n) => n.type === "pageBreak");
    expect(breaks).toHaveLength(2);
    expect(combined.content![0]!.type).toBe("paragraph");
    expect(flat(combined)).toBe("Cher DupontCher MartinCher Durand");
  });

  it("ne met aucun saut de page avant le premier enregistrement", () => {
    const combined = mergeCombined(model, data, { selected: [1] });
    expect(combined.content![0]!.type).toBe("paragraph");
    expect((combined.content ?? []).filter((n) => n.type === "pageBreak")).toHaveLength(0);
  });

  it("rend un document non vide même sans enregistrement", () => {
    const combined = mergeCombined(model, { fields: ["Nom"], records: [] });
    expect(combined.content).toEqual([{ type: "paragraph" }]);
  });
});

describe("Publipostage — libellé d'un enregistrement", () => {
  it("résume avec les premières valeurs non vides", () => {
    expect(recordLabel({ Nom: "Dupont", Ville: "Lyon" }, ["Nom", "Ville"])).toBe("Dupont · Lyon");
  });

  it("signale un enregistrement vide", () => {
    expect(recordLabel({ Nom: "", Ville: " " }, ["Nom", "Ville"])).toBe("(enregistrement vide)");
  });
});
