import { describe, it, expect } from "vitest";
import {
  CELL_VALIGN_LABELS, DEFAULT_TABLE_STYLE, TABLE_FIT_LABELS, TABLE_STYLES, compareCells, fitCss,
  fitXml, isBandedColumn, normalizeFit, normalizeVAlign, parseLoose, rowClasses, sortRowOrder,
  tablePrXml, tableStyleById, tableStylesCss, vAlignXml,
} from "../src/editor/tableStyles";
import { strFromU8, unzipSync } from "fflate";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { buildStandaloneHtml, docToHtml } from "../src/export/exporters";
import type { ProseMirrorNode } from "../src/format/types";

describe("Styles de tableau — catalogue", () => {
  it("expose des styles distincts et un défaut valide", () => {
    expect(TABLE_STYLES.length).toBeGreaterThan(4);
    expect(new Set(TABLE_STYLES.map((s) => s.id)).size).toBe(TABLE_STYLES.length);
    expect(tableStyleById(DEFAULT_TABLE_STYLE).id).toBe(DEFAULT_TABLE_STYLE);
  });

  it("retombe sur le style simple pour un identifiant inconnu", () => {
    expect(tableStyleById("inexistant").id).toBe("plain");
    expect(tableStyleById(null).id).toBe("plain");
  });
});

describe("Styles de tableau — trames dérivées de la position", () => {
  const banded = tableStyleById("banded-rows");
  const cols = tableStyleById("banded-cols");

  it("trame une ligne de corps sur deux", () => {
    expect(rowClasses(banded, 0, true)).toContain("is-header-accent");
    // La bande se compte depuis la première ligne de CORPS.
    expect(rowClasses(banded, 1, true)).not.toContain("is-banded");
    expect(rowClasses(banded, 2, true)).toContain("is-banded");
    expect(rowClasses(banded, 3, true)).not.toContain("is-banded");
  });

  it("l'ajout d'un en-tête n'inverse pas les trames du corps", () => {
    // Sans en-tête, la 2e ligne (index 1) est tramée ; avec en-tête, c'est la 3e
    // (index 2) — soit la même ligne de corps dans les deux cas.
    expect(rowClasses(banded, 1, false)).toContain("is-banded");
    expect(rowClasses(banded, 2, true)).toContain("is-banded");
  });

  it("ne trame pas la ligne d'en-tête", () => {
    expect(rowClasses(banded, 0, true)).not.toContain("is-banded");
  });

  it("trame une colonne sur deux dans le style adéquat", () => {
    expect(isBandedColumn(cols, 0)).toBe(false);
    expect(isBandedColumn(cols, 1)).toBe(true);
    expect(isBandedColumn(banded, 1)).toBe(false);
  });

  it("un style sans trame ne rend aucune classe de bande", () => {
    const plain = tableStyleById("plain");
    for (let i = 0; i < 5; i++) expect(rowClasses(plain, i, true)).not.toContain("is-banded");
  });
});

describe("Styles de tableau — CSS et OOXML", () => {
  it("génère une règle par style, depuis la table", () => {
    const css = tableStylesCss();
    for (const s of TABLE_STYLES) {
      if (!s.innerBorders || !s.outerBorders) expect(css).toContain(`data-table-style="${s.id}"`);
    }
    expect(css).toContain("is-banded");
    expect(css).toContain("is-header-accent");
  });

  it("rend l'alignement vertical, en omettant le défaut", () => {
    expect(vAlignXml("top")).toBe("");
    expect(vAlignXml("center")).toBe('<w:vAlign w:val="center"/>');
    expect(vAlignXml("bottom")).toBe('<w:vAlign w:val="bottom"/>');
    expect(vAlignXml("bogus")).toBe("");
    expect(normalizeVAlign("bogus")).toBe("top");
    expect(CELL_VALIGN_LABELS.center).toBe("Milieu");
  });

  it("traduit l'ajustement en CSS", () => {
    // `table-layout: fixed` est ce qui fait respecter les largeurs de colonnes.
    expect(fitCss("window")).toContain("table-layout:fixed");
    expect(fitCss("window")).toContain("width:100%");
    expect(fitCss("content")).toContain("table-layout:auto");
    expect(fitCss("auto")).toBe("");
    expect(normalizeFit("bogus")).toBe("auto");
    expect(TABLE_FIT_LABELS.window).toBe("Ajuster à la fenêtre");
  });

  it("traduit l'ajustement en OOXML", () => {
    expect(fitXml("window")).toContain('w:type="pct"');
    expect(fitXml("fixed")).toContain("w:tblLayout");
    expect(fitXml("content")).toContain('w:type="auto"');
  });

  it("écrit des filets présents ou explicitement absents", () => {
    const minimal = tablePrXml("minimal", "auto");
    // « none » explicite, sinon Word applique les filets de son propre style.
    expect(minimal).toContain('<w:insideH w:val="none"');
    expect(minimal).toContain('<w:top w:val="none"');
    const grid = tablePrXml("grid", "auto");
    expect(grid).toContain('<w:insideH w:val="single"');
  });

  it("écrit un w:tblLook accordé aux bandes du style", () => {
    // Sans w:tblLook, un tableau à lignes alternées s'ouvre uniformément gris.
    const rows = tablePrXml("banded-rows", "auto");
    expect(rows).toContain('w:noHBand="0"');
    expect(rows).toContain('w:noVBand="1"');
    expect(rows).toContain('w:firstRow="1"');
    const colsXml = tablePrXml("banded-cols", "auto");
    expect(colsXml).toContain('w:noVBand="0"');
    expect(colsXml).toContain('w:noHBand="1"');
  });
});

describe("Tri — lecture des nombres", () => {
  it("lit les formats français", () => {
    expect(parseLoose("1 234,50")).toBeCloseTo(1234.5);
    expect(parseLoose("1 234,50")).toBeCloseTo(1234.5); // espace insécable
    expect(parseLoose("12,5 %")).toBeCloseTo(12.5);
    expect(parseLoose("1 200 €")).toBe(1200);
    expect(parseLoose("-3,5")).toBeCloseTo(-3.5);
  });

  it("lit aussi le format anglo-saxon", () => {
    expect(parseLoose("1234.50")).toBeCloseTo(1234.5);
    expect(parseLoose("42")).toBe(42);
  });

  it("rend null pour ce qui n'est pas un nombre", () => {
    expect(parseLoose("")).toBeNull();
    expect(parseLoose("   ")).toBeNull();
    expect(parseLoose("Paris")).toBeNull();
    expect(parseLoose("12a")).toBeNull();
  });
});

describe("Tri — comparaison", () => {
  it("compare les nombres numériquement, pas comme du texte", () => {
    // Le défaut le plus visible d'un tri de tableau : « 10 » avant « 9 ».
    expect(compareCells("9", "10")).toBeLessThan(0);
    expect(compareCells("100", "20")).toBeGreaterThan(0);
  });

  it("place les nombres avant le texte", () => {
    expect(compareCells("5", "Paris")).toBeLessThan(0);
    expect(compareCells("Paris", "5")).toBeGreaterThan(0);
  });

  it("compare le texte selon la collation française, accents inclus", () => {
    expect(compareCells("Éclair", "Eclat")).toBeLessThan(0);
    expect(compareCells("zèbre", "Zebra")).toBeGreaterThan(0);
  });
});

describe("Tri — ordre des lignes", () => {
  const rows = [
    ["Ville", "Population"],
    ["Lyon", "9"],
    ["Paris", "100"],
    ["Lille", "20"],
  ];

  it("trie le corps et laisse l'en-tête en place", () => {
    const order = sortRowOrder(rows, 1, "asc", true);
    expect(order[0]).toBe(0);
    expect(order.slice(1).map((i) => rows[i]![0])).toEqual(["Lyon", "Lille", "Paris"]);
  });

  it("trie en ordre décroissant", () => {
    const order = sortRowOrder(rows, 1, "desc", true);
    expect(order.slice(1).map((i) => rows[i]![0])).toEqual(["Paris", "Lille", "Lyon"]);
  });

  it("trie tout quand il n'y a pas d'en-tête", () => {
    const order = sortRowOrder(rows, 0, "asc", false);
    expect(order.map((i) => rows[i]![0])).toEqual(["Lille", "Lyon", "Paris", "Ville"]);
  });

  it("est stable à égalité", () => {
    const tied = [["h"], ["a"], ["a"], ["a"]];
    // Un tri instable ferait sauter des lignes identiques à chaque clic.
    expect(sortRowOrder(tied, 0, "asc", true)).toEqual([0, 1, 2, 3]);
    expect(sortRowOrder(tied, 0, "desc", true)).toEqual([0, 1, 2, 3]);
  });

  it("survit à une colonne hors bornes ou à un tableau vide", () => {
    expect(sortRowOrder(rows, 99, "asc", true)).toEqual([0, 1, 2, 3]);
    expect(sortRowOrder([], 0, "asc", true)).toEqual([]);
    expect(sortRowOrder([["seul"]], 0, "asc", true)).toEqual([0]);
  });

  it("rend une permutation, jamais des lignes reconstruites", () => {
    const order = sortRowOrder(rows, 1, "asc", true);
    // C'est ce qui permet de réordonner les vrais nœuds sans perdre leur mise en forme.
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});

describe("Styles de tableau — export", () => {
  const model = (doc: ProseMirrorNode) => ({
    schema: "elium-doc/1" as const,
    page: {
      format: "A4" as const, orientation: "portrait" as const,
      margins: { top: 25, right: 20, bottom: 25, left: 20 },
    },
    doc,
  });
  const cell = (text: string, header = false, attrs: Record<string, unknown> = {}): ProseMirrorNode => ({
    type: header ? "tableHeader" : "tableCell",
    attrs,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const row = (...cells: ProseMirrorNode[]): ProseMirrorNode => ({ type: "tableRow", content: cells });
  const table = (attrs: Record<string, unknown>, ...rows: ProseMirrorNode[]): ProseMirrorNode =>
    ({ type: "table", attrs, content: rows });
  const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

  const sample = table(
    { tableStyle: "banded-rows", tableFit: "window" },
    row(cell("Ville", true), cell("Population", true)),
    row(cell("Lyon"), cell("9")),
    row(cell("Paris", false, { vAlign: "center" }), cell("100")),
    row(cell("Lille"), cell("20")),
  );

  it("écrit le style, l'ajustement et les trames en HTML", () => {
    const html = docToHtml(model(doc(sample)));
    expect(html).toContain('data-table-style="banded-rows"');
    expect(html).toContain("table-layout:fixed");
    // Un HTML exporté n'a pas de plugin pour recalculer les bandes : elles
    // doivent être écrites.
    expect(html).toMatch(/<tr class="[^"]*is-header-accent/);
    expect(html).toMatch(/<tr class="[^"]*is-banded/);
    // Le marqueur de style est porté par chaque ligne : dans l'éditeur, la vue de
    // nœud du tableau rend l'attribut du `<table>` inatteignable (cf. rowClasses).
    expect(html).toMatch(/<tr class="[^"]*tstyle-banded-rows/);
    expect(html).toContain('data-valign="center"');
  });

  it("trame la bonne ligne de corps", () => {
    const html = docToHtml(model(sample ? doc(sample) : doc()));
    // En-tête + Lyon (non tramée) + Paris (tramée) + Lille (non tramée).
    const rowTags = html.split("<tr").slice(1);
    const bandedRows = rowTags.filter((r) => /^[^>]*class="[^"]*is-banded/.test(r));
    expect(bandedRows).toHaveLength(1);
    // La ligne tramée est bien celle de Paris (2e ligne de corps).
    expect(bandedRows[0]).toContain("Paris");
  });

  it("porte la feuille de styles de tableau dans l'export autonome", async () => {
    const file = await createEliumFile({ title: "T", profile: "standard", doc: doc(sample) });
    const html = buildStandaloneHtml(file);
    expect(html).toContain("is-header-accent");
    expect(html).toContain('table[data-table-style]');
  });

  it("écrit le w:tblPr et le w:vAlign en DOCX", async () => {
    const file = await createEliumFile({ title: "T", profile: "standard", doc: doc(sample) });
    const xml = strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);
    expect(xml).toContain('w:noHBand="0"');
    expect(xml).toContain('w:type="pct"');
    expect(xml).toContain('<w:vAlign w:val="center"/>');
    // « top » est le défaut : il ne doit pas être écrit.
    expect(xml).not.toContain('<w:vAlign w:val="top"/>');
  });

  it("écrit des filets explicitement absents pour un style minimal", async () => {
    const t = table({ tableStyle: "minimal" }, row(cell("a"), cell("b")));
    const file = await createEliumFile({ title: "T", profile: "standard", doc: doc(t) });
    const xml = strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);
    expect(xml).toContain('<w:insideH w:val="none"');
  });
});
