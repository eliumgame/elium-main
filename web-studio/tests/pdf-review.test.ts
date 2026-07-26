/**
 * @vitest-environment jsdom
 *
 * XFDF round-trips need a DOM parser, which is also how the browser reads a
 * comment file exported from Acrobat.
 */
import { describe, it, expect } from "vitest";
import { fromXfdf, toXfdf } from "../src/pdf/ops/xfdf";
import { comparePages, diffTokens, similarityOf, tokenise } from "../src/pdf/ops/compare";
import { batesLabel, expandTokens } from "../src/pdf/ops/decorate";
import { fromFdf, missingRequired, suggestFields, toCsv, toFdf, type FieldBox } from "../src/pdf/ops/forms";
import * as D from "../src/pdf/model/doc";
import { emptyState, newId, type Annot, type Page } from "../src/pdf/model/types";

const pages: Page[] = [{ id: "p1", from: 0 }, { id: "p2", from: 1 }];
const heights = new Map([["p1", 842], ["p2", 842]]);

const annot = (over: Partial<Annot>): Annot => ({
  id: newId("an"),
  pageId: "p1",
  kind: "square",
  rect: { x: 40, y: 40, w: 120, h: 60 },
  color: "#e11d48",
  opacity: 1,
  strokeWidth: 2,
  author: "Alice",
  createdAt: "2026-03-01T08:00:00.000Z",
  modifiedAt: "2026-03-01T08:00:00.000Z",
  replies: [],
  ...over,
});

describe("XFDF — export", () => {
  it("produces a well-formed document with one element per annotation", () => {
    const xml = toXfdf([
      annot({ kind: "highlight", quads: [[{ x: 10, y: 20 }, { x: 90, y: 20 }, { x: 90, y: 34 }, { x: 10, y: 34 }]] }),
      annot({ kind: "ink", paths: [[{ x: 1, y: 2 }, { x: 3, y: 4 }]] }),
      annot({ pageId: "p2", kind: "note", contents: "Vérifier" }),
    ], pages, heights, "contrat.pdf");

    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.getElementsByTagName("highlight")).toHaveLength(1);
    expect(doc.getElementsByTagName("ink")).toHaveLength(1);
    expect(doc.getElementsByTagName("text")).toHaveLength(1);
    expect(doc.getElementsByTagName("text")[0].getAttribute("page")).toBe("1");
  });

  it("escapes text that would otherwise break the XML", () => {
    const xml = toXfdf([annot({ kind: "note", contents: 'a < b & "c"' , author: "Ann & Bob" })], pages, heights, "x.pdf");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.getElementsByTagName("contents")[0].textContent).toBe('a < b & "c"');
  });
});

describe("XFDF — round-trip", () => {
  it("restores geometry, colour, author and comment", () => {
    const original = annot({
      kind: "highlight",
      color: "#ffd400",
      contents: "Passage clé",
      quads: [[{ x: 10, y: 20 }, { x: 90, y: 20 }, { x: 90, y: 34 }, { x: 10, y: 34 }]],
    });
    const back = fromXfdf(toXfdf([original], pages, heights, "x.pdf"), pages, heights, "Import");
    expect(back).toHaveLength(1);
    expect(back[0].kind).toBe("highlight");
    expect(back[0].author).toBe("Alice");
    expect(back[0].contents).toBe("Passage clé");
    expect(back[0].color).toBe("#ffd400");
    expect(back[0].quads![0][0].x).toBeCloseTo(10, 1);
    expect(back[0].quads![0][0].y).toBeCloseTo(20, 1);
    expect(back[0].quads![0][2].y).toBeCloseTo(34, 1);
  });

  it("restores ink strokes", () => {
    const original = annot({ kind: "ink", paths: [[{ x: 5, y: 6 }, { x: 40, y: 90 }]] });
    const back = fromXfdf(toXfdf([original], pages, heights, "x.pdf"), pages, heights, "Import");
    expect(back[0].kind).toBe("ink");
    expect(back[0].paths![0]).toHaveLength(2);
    expect(back[0].paths![0][1].x).toBeCloseTo(40, 1);
    expect(back[0].paths![0][1].y).toBeCloseTo(90, 1);
  });

  it("restores a polygon's vertices", () => {
    const original = annot({ kind: "polygon", paths: [[{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 40 }]] });
    const back = fromXfdf(toXfdf([original], pages, heights, "x.pdf"), pages, heights, "Import");
    expect(back[0].paths![0]).toHaveLength(3);
    expect(back[0].paths![0][2].y).toBeCloseTo(40, 1);
  });

  it("reattaches replies to their parent comment", () => {
    let state = D.addAnnot(emptyState(), annot({ id: "a1", kind: "note", contents: "Question ?" }));
    state = D.addReply(state, "a1", { author: "Bob", text: "Réponse", createdAt: "2026-03-02T09:00:00.000Z" });
    const back = fromXfdf(toXfdf(state.annots, pages, heights, "x.pdf"), pages, heights, "Import");
    const parent = back.find((a) => a.contents === "Question ?");
    expect(parent).toBeDefined();
    expect(parent!.replies).toHaveLength(1);
    expect(parent!.replies![0].author).toBe("Bob");
    expect(parent!.replies![0].text).toBe("Réponse");
  });

  it("keeps annotations on their own page", () => {
    const back = fromXfdf(
      toXfdf([annot({ pageId: "p2", kind: "note", contents: "sur la deux" })], pages, heights, "x.pdf"),
      pages, heights, "Import",
    );
    expect(back[0].pageId).toBe("p2");
  });

  it("ignores a file that is not XFDF at all", () => {
    expect(fromXfdf("pas du xml <<<", pages, heights, "Import")).toEqual([]);
  });
});

describe("Comparison — word diff", () => {
  it("tokenises words, keeping apostrophes together", () => {
    expect(tokenise("L'état, c'est moi.")).toEqual(["L'état", ",", "c'est", "moi", "."]);
  });

  it("reports identical text as a single equal run", () => {
    const changes = diffTokens(tokenise("le chat dort"), tokenise("le chat dort"));
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("equal");
    expect(similarityOf(changes)).toBe(1);
  });

  it("pairs a deletion followed by an insertion into a replacement", () => {
    const changes = diffTokens(tokenise("le chat dort"), tokenise("le chien dort"));
    const replace = changes.find((c) => c.kind === "replace");
    expect(replace).toBeDefined();
    expect(replace!.left).toEqual(["chat"]);
    expect(replace!.right).toEqual(["chien"]);
  });

  it("detects a pure insertion", () => {
    const changes = diffTokens(tokenise("le chat"), tokenise("le gros chat"));
    expect(changes.some((c) => c.kind === "insert" && c.right.includes("gros"))).toBe(true);
    expect(changes.some((c) => c.kind === "delete")).toBe(false);
  });

  it("detects a pure deletion", () => {
    const changes = diffTokens(tokenise("le gros chat"), tokenise("le chat"));
    expect(changes.some((c) => c.kind === "delete" && c.left.includes("gros"))).toBe(true);
  });

  it("scores similarity between 0 and 1", () => {
    const sim = similarityOf(diffTokens(tokenise("a b c d"), tokenise("a b x d")));
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThan(1);
  });
});

describe("Comparison — page alignment", () => {
  it("finds nothing to report between two identical documents", () => {
    const left = ["Page un identique", "Page deux identique"];
    const report = comparePages(left, [...left]);
    expect(report.pagesModified).toBe(0);
    expect(report.pagesAdded).toBe(0);
    expect(report.pagesRemoved).toBe(0);
    expect(report.similarity).toBe(1);
  });

  it("reports a modified page without desynchronising the rest", () => {
    const left = ["Article premier : le loyer est de mille euros", "Article deux : la durée est de trois ans"];
    const right = ["Article premier : le loyer est de douze cents euros", "Article deux : la durée est de trois ans"];
    const report = comparePages(left, right);
    expect(report.pagesModified).toBe(1);
    expect(report.pages[0].status).toBe("modified");
    expect(report.pages[1].status).toBe("unchanged");
    expect(report.wordsAdded).toBeGreaterThan(0);
  });

  it("aligns around an inserted page instead of shifting everything", () => {
    const left = ["Alpha alpha alpha", "Gamma gamma gamma"];
    const right = ["Alpha alpha alpha", "Beta beta beta toute nouvelle", "Gamma gamma gamma"];
    const report = comparePages(left, right);
    expect(report.pagesAdded).toBe(1);
    // "Gamma" is still recognised as the same page, not as a rewrite.
    const gamma = report.pages.find((p) => p.leftPage === 2);
    expect(gamma?.status).toBe("unchanged");
    expect(gamma?.rightPage).toBe(3);
  });

  it("reports a removed page", () => {
    const report = comparePages(["Alpha alpha", "Beta beta", "Gamma gamma"], ["Alpha alpha", "Gamma gamma"]);
    expect(report.pagesRemoved).toBe(1);
    expect(report.pages.some((p) => p.status === "removed" && p.leftPage === 2)).toBe(true);
  });
});

describe("Page marks", () => {
  it("expands every header/footer token", () => {
    const out = expandTokens("{title} — page {page}/{pages} — {author} — {filename} — {bates}", {
      page: 3, total: 12, title: "Bail", author: "Durand", filename: "bail.pdf", bates: "ELI-00007",
      date: new Date(2026, 2, 14, 9, 5),
    });
    expect(out).toBe("Bail — page 3/12 — Durand — bail.pdf — ELI-00007");
  });

  it("formats the date and time in the local convention", () => {
    const out = expandTokens("{date} {time}", {
      page: 1, total: 1, title: "", author: "", filename: "", date: new Date(2026, 2, 14, 9, 5),
    });
    expect(out).toBe("14/03/2026 09:05");
  });

  it("pads a Bates number to the requested width", () => {
    const bates = { enabled: true, prefix: "ELI-", suffix: "-FR", start: 7, digits: 6 };
    expect(batesLabel(bates, 0)).toBe("ELI-000007-FR");
    expect(batesLabel(bates, 5)).toBe("ELI-000012-FR");
  });
});

describe("Form data", () => {
  it("round-trips values through FDF", () => {
    const values = { nom: "Dupont (Jean)", accord: true, refus: false, note: "a\\b" };
    const back = fromFdf(toFdf(values, "contrat.pdf"));
    expect(back.nom).toBe("Dupont (Jean)");
    expect(back.note).toBe("a\\b");
    expect(back.accord).toBe(true);
    expect(back.refus).toBe(false);
  });

  it("exports a spreadsheet-safe CSV", () => {
    const csv = toCsv({ "nom;complet": 'Jean "Le Grand"', ok: true });
    expect(csv.split("\r\n")[0]).toBe("Champ;Valeur");
    expect(csv).toContain('"nom;complet"');
    expect(csv).toContain('"Jean ""Le Grand"""');
    expect(csv).toContain("Oui");
  });

  it("lists the required fields still empty", () => {
    const field = (over: Partial<FieldBox>): FieldBox => ({
      key: "k", name: "n", kind: "text", rect: { x: 0, y: 0, w: 10, h: 10 },
      readOnly: false, required: false, multiLine: false, password: false,
      maxLen: null, exportValue: null, options: [], value: "", align: "left", ...over,
    });
    const fields = [
      field({ name: "nom", required: true }),
      field({ name: "prenom", required: true }),
      field({ name: "accord", kind: "checkbox", required: true, value: false }),
      field({ name: "facultatif" }),
    ];
    const missing = missingRequired(fields, { prenom: "Jean" });
    expect(missing.map((f) => f.name)).toEqual(["nom", "accord"]);
  });

  it("suggests a field after a label ending in a colon", () => {
    const suggestions = suggestFields([
      { text: "Nom du locataire :", rect: { x: 60, y: 300, w: 130, h: 12 }, fontSize: 11 },
      { text: "Signature ______________", rect: { x: 60, y: 340, w: 200, h: 12 }, fontSize: 11 },
      { text: "Texte ordinaire sans marqueur", rect: { x: 60, y: 380, w: 220, h: 12 }, fontSize: 11 },
    ], 595);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].name).toBe("Nom_du_locataire");
    expect(suggestions[0].rect.x).toBeGreaterThan(190);
    // The underscore run becomes a field over the line itself.
    expect(suggestions[1].rect.x).toBeCloseTo(60, 1);
  });
});
