import { describe, it, expect } from "vitest";
import {
  buildBibliography,
  collectSources,
  formatCitation,
  formatReference,
  makeSourceKey,
  parseAuthors,
  partsToHtml,
  partsToText,
  sortSources,
  validateSource,
  type BibSource,
} from "../src/editor/citations";

const book: BibSource = {
  key: "k1",
  type: "book",
  authors: "Dupont, Marie-Claire; Martin, Paul",
  title: "L'économie du savoir",
  year: "2020",
  publisher: "Presses Universitaires",
  place: "Paris",
  edition: "2e éd.",
};
const article: BibSource = {
  key: "k2",
  type: "article",
  authors: "Bernard, Luc",
  title: "Cryptographie et vie privée",
  year: "2019",
  container: "Revue de sécurité",
  volume: "12",
  issue: "3",
  pages: "45-67",
  doi: "10.1000/xyz123",
};
const web: BibSource = {
  key: "k3",
  type: "web",
  authors: "",
  title: "Guide du RGPD",
  year: "2022",
  container: "CNIL",
  url: "https://cnil.fr/guide",
  accessed: "2026-03-05",
};

describe("auteurs et clés", () => {
  it("lit « Nom, Prénom ; … »", () => {
    expect(parseAuthors("Dupont, Marie ; Martin")).toEqual([
      { last: "Dupont", first: "Marie" },
      { last: "Martin", first: "" },
    ]);
  });
  it("clé stable, sans accents", () => {
    expect(makeSourceKey({ authors: "Étienne, Jean", year: "2001", title: "Été ardent" })).toBe("etienne2001eteard");
  });
});

describe("citations courantes", () => {
  it("APA : auteur-année, pages, et al., sans année", () => {
    expect(formatCitation(book, "apa")).toBe("(Dupont et Martin, 2020)");
    expect(formatCitation(article, "apa", "47")).toBe("(Bernard, 2019, p. 47)");
    expect(formatCitation({ ...book, authors: "A, a; B, b; C, c" }, "apa")).toBe("(A et al., 2020)");
    expect(formatCitation({ ...article, year: "" }, "apa")).toBe("(Bernard, s. d.)");
  });
  it("MLA : auteur + page, sans année", () => {
    expect(formatCitation(article, "mla", "47")).toBe("(Bernard 47)");
    expect(formatCitation(article, "mla")).toBe("(Bernard)");
  });
  it("ISO 690 : NOM en capitales", () => {
    expect(formatCitation(article, "iso690")).toBe("(BERNARD, 2019)");
  });
  it("sans auteur : titre abrégé", () => {
    expect(formatCitation(web, "apa")).toBe("(« Guide du RGPD », 2022)");
    expect(formatCitation(web, "iso690")).toBe("(GUIDE DU RGPD, 2022)");
  });
});

describe("références complètes", () => {
  it("APA livre / article / site", () => {
    expect(partsToText(formatReference(book, "apa"))).toBe("Dupont, M.-C. & Martin, P. (2020). L'économie du savoir (2e éd.). Presses Universitaires.");
    expect(partsToText(formatReference(article, "apa"))).toBe("Bernard, L. (2019). Cryptographie et vie privée. Revue de sécurité, 12(3), 45–67. https://doi.org/10.1000/xyz123");
    expect(partsToText(formatReference(web, "apa"))).toBe("Guide du RGPD. (2022). CNIL. https://cnil.fr/guide");
  });
  it("APA : l'italique porte le titre du livre et la revue + volume", () => {
    expect(formatReference(book, "apa").filter((p) => p.i).map((p) => p.t)).toEqual(["L'économie du savoir"]);
    expect(formatReference(article, "apa").filter((p) => p.i).map((p) => p.t)).toEqual(["Revue de sécurité", "12"]);
    expect(partsToHtml(formatReference(article, "apa"))).toContain("<i>Revue de sécurité</i>");
  });
  it("MLA livre / article / site", () => {
    expect(partsToText(formatReference(book, "mla"))).toBe("Dupont, Marie-Claire, et Paul Martin. L'économie du savoir. 2e éd., Presses Universitaires, 2020.");
    expect(partsToText(formatReference(article, "mla"))).toBe("Bernard, Luc. « Cryptographie et vie privée ». Revue de sécurité, vol. 12, no 3, 2019, p. 45–67. https://doi.org/10.1000/xyz123.");
    expect(partsToText(formatReference(web, "mla"))).toBe("« Guide du RGPD ». CNIL, 2022, https://cnil.fr/guide. Consulté le 5 mars 2026.");
  });
  it("ISO 690 livre / article / site", () => {
    expect(partsToText(formatReference(book, "iso690"))).toBe("DUPONT, Marie-Claire ; MARTIN, Paul. L'économie du savoir. 2e éd. Paris : Presses Universitaires, 2020.");
    expect(partsToText(formatReference(article, "iso690"))).toBe("BERNARD, Luc. Cryptographie et vie privée. Revue de sécurité, 2019, vol. 12, n° 3, p. 45–67. https://doi.org/10.1000/xyz123");
    expect(partsToText(formatReference(web, "iso690"))).toBe("Guide du RGPD [en ligne]. CNIL, 2022 [consulté le 5 mars 2026]. Disponible à l'adresse : https://cnil.fr/guide");
  });
});

describe("bibliographie", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "citation", attrs: { source: article } }, { type: "citation", attrs: { source: book } }] },
      { type: "paragraph", content: [{ type: "citation", attrs: { source: article } }] },
    ],
  };
  it("collecte les sources citées sans doublon, dans l'ordre", () => {
    expect(collectSources(doc).map((s) => s.key)).toEqual(["k2", "k1"]);
  });
  it("tri alphabétique par nom du premier auteur", () => {
    expect(sortSources([article, book, web]).map((s) => s.key)).toEqual(["k2", "k1", "k3"].sort((a, b) => ({ k2: 0, k1: 1, k3: 2 })[a]! - ({ k2: 0, k1: 1, k3: 2 })[b]!));
    expect(buildBibliography([book, article], "apa")).toHaveLength(2);
    expect(partsToText(buildBibliography([book, article], "apa")[0]!).startsWith("Bernard")).toBe(true);
  });
  it("validation de saisie", () => {
    expect(validateSource({ ...book })).toEqual([]);
    expect(validateSource({ ...book, title: "" })).toContain("Le titre est obligatoire.");
    expect(validateSource({ ...book, year: "20" })).toHaveLength(1);
    expect(validateSource({ ...article, container: "" })).toContain("Indiquez le nom de la revue.");
    expect(validateSource({ ...web, url: "" })).toHaveLength(1);
  });
});
