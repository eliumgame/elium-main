// Fidélité DOCX : documents « tels que Word les écrit » (styles hérités, listes
// par numPr/style, tableaux fusionnés, contrôles de contenu, suivi des
// modifications, commentaires, en-têtes/pieds de page) — pas notre exporteur.
import { describe, it, expect } from "vitest";
import { docxToDoc } from "../src/format/docx";
import type { ProseMirrorNode } from "../src/format/types";
import { wordDocx } from "./docx-word-fixture-helper";

const STYLES = `
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Titre2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="MonTitre"><w:name w:val="Mon titre"/><w:basedOn w:val="Titre1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:color w:val="C00000"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Titre"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Paragraphedeliste"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Listepuces"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
<w:style w:type="character" w:styleId="Accentuation"><w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style>
`;
const NUMBERING = `
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>
 <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/><w:lvlJc w:val="left"/></w:lvl>
 <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>
 <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl>
 <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
`;

const p = (inner: string, ppr = "") => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${inner}</w:p>`;
const r = (text: string, rpr = "") => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

function textOf(n: ProseMirrorNode): string {
  return n.text ?? (n.content ?? []).map(textOf).join("");
}
function all(n: ProseMirrorNode, type: string, out: ProseMirrorNode[] = []): ProseMirrorNode[] {
  if (n.type === type) out.push(n);
  for (const c of n.content ?? []) all(c, type, out);
  return out;
}
const imp = (parts: Parameters<typeof wordDocx>[0]) => docxToDoc(wordDocx(parts));

describe("DOCX Word réel — styles et titres", () => {
  const d = imp({
    styles: STYLES,
    body:
      p(r("Titre du rapport"), `<w:pStyle w:val="Titre"/>`) +
      p(r("Chapitre un"), `<w:pStyle w:val="Titre1"/>`) +
      p(r("Chapitre personnalisé"), `<w:pStyle w:val="MonTitre"/>`) +
      p(r("Section"), `<w:pStyle w:val="Titre2"/>`) +
      p(r("Corps ") + r("emphase", `<w:rStyle w:val="Accentuation"/>`)),
  });
  it("les titres sont reconnus par nom de style et par héritage (basedOn / outlineLvl)", () => {
    const heads = all(d.doc, "heading");
    expect(heads.map((h) => [textOf(h), h.attrs?.level])).toEqual([
      ["Titre du rapport", 1],
      ["Chapitre un", 1],
      ["Chapitre personnalisé", 1],
      ["Section", 2],
    ]);
  });
  it("le style de caractère (italique) est appliqué", () => {
    const emph = JSON.stringify(d.doc);
    expect(emph).toContain('"italic"');
  });
});

describe("DOCX Word réel — listes", () => {
  const d = imp({
    styles: STYLES,
    numbering: NUMBERING,
    body:
      p(r("Puce A"), `<w:pStyle w:val="Paragraphedeliste"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`) +
      p(r("Sous-puce"), `<w:pStyle w:val="Paragraphedeliste"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>`) +
      p(r("Puce B"), `<w:pStyle w:val="Paragraphedeliste"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`) +
      p(r("Intermède")) +
      p(r("Étape 1"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>`) +
      p(r("Étape 2"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>`) +
      p(r("Via le style"), `<w:pStyle w:val="Listepuces"/>`),
  });
  it("regroupe les paragraphes numPr en listes à puces et numérotées", () => {
    expect(all(d.doc, "bulletList").length).toBeGreaterThanOrEqual(2);
    const ordered = all(d.doc, "orderedList");
    expect(ordered).toHaveLength(1);
    expect(all(ordered[0]!, "listItem").map(textOf)).toEqual(["Étape 1", "Étape 2"]);
  });
  it("conserve l'imbrication par niveau", () => {
    const first = all(d.doc, "bulletList")[0]!;
    expect(textOf(first)).toContain("Puce A");
    expect(all(first, "bulletList").length + (first.content ?? []).length).toBeGreaterThan(1);
    expect(textOf(first)).toContain("Sous-puce");
  });
  it("une liste définie par le STYLE (sans numPr direct) est reconnue", () => {
    const lists = all(d.doc, "bulletList");
    expect(lists.some((l) => textOf(l).includes("Via le style"))).toBe(true);
  });
});

describe("DOCX Word réel — tableaux", () => {
  const cell = (inner: string, tcpr = "") => `<w:tc><w:tcPr>${tcpr}</w:tcPr>${p(r(inner))}</w:tc>`;
  const d = imp({
    body:
      `<w:tbl><w:tblPr><w:tblStyle w:val="Grilledutableau"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>` +
      `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell("Titre fusionné", `<w:gridSpan w:val="2"/>`)}${cell("Col C")}</w:tr>` +
      `<w:tr>${cell("A2", `<w:vMerge w:val="restart"/>`)}${cell("B2")}${cell("C2")}</w:tr>` +
      `<w:tr>${cell("", `<w:vMerge/>`)}${cell("B3")}${cell("C3")}</w:tr>` +
      `</w:tbl>`,
  });
  it("importe le tableau avec ses cellules", () => {
    const tbl = all(d.doc, "table")[0]!;
    expect(tbl).toBeTruthy();
    expect(all(tbl, "tableRow")).toHaveLength(3);
    expect(textOf(tbl)).toContain("B3");
  });
  it("fusion horizontale (gridSpan) et verticale (vMerge) → colspan / rowspan", () => {
    const tbl = all(d.doc, "table")[0]!;
    const cells = [...all(tbl, "tableCell"), ...all(tbl, "tableHeader")];
    const merged = cells.find((c) => textOf(c) === "Titre fusionné")!;
    expect(merged.attrs?.colspan).toBe(2);
    const a2 = cells.find((c) => textOf(c) === "A2")!;
    expect(a2.attrs?.rowspan).toBe(2);
  });
  it("la ligne w:tblHeader devient une ligne d'en-têtes", () => {
    const tbl = all(d.doc, "table")[0]!;
    expect(all(tbl.content![0]!, "tableHeader").length).toBeGreaterThan(0);
  });
});

describe("DOCX Word réel — contenu enveloppé, suivi des modifications, commentaires", () => {
  const d = imp({
    comments: `<w:comment w:id="0" w:author="Marie" w:date="2026-01-02T10:00:00Z"><w:p><w:r><w:t>À vérifier</w:t></w:r></w:p></w:comment>`,
    body:
      `<w:sdt><w:sdtPr><w:alias w:val="Titre"/></w:sdtPr><w:sdtContent>${p(r("Dans un contrôle de contenu"))}</w:sdtContent></w:sdt>` +
      p(`<w:smartTag w:uri="x" w:element="place">${r("Paris")}</w:smartTag>${r(" est belle")}`) +
      p(
        r("Avant ") +
          `<w:ins w:id="1" w:author="Paul" w:date="2026-01-03T09:00:00Z">${r("ajouté")}</w:ins>` +
          `<w:del w:id="2" w:author="Paul" w:date="2026-01-03T09:00:00Z"><w:r><w:delText>supprimé</w:delText></w:r></w:del>` +
          `<w:commentRangeStart w:id="0"/>${r(" commenté")}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>`,
      ) +
      `<mc:AlternateContent><mc:Choice Requires="wps">${p(r("choix moderne"))}</mc:Choice><mc:Fallback>${p(r("repli doublon"))}</mc:Fallback></mc:AlternateContent>`,
  });
  const txt = textOf(d.doc);
  it("lit les paragraphes d'un contrôle de contenu (w:sdt) et d'un smartTag", () => {
    expect(txt).toContain("Dans un contrôle de contenu");
    expect(txt).toContain("Paris est belle");
  });
  it("suivi des modifications : insertion et suppression marquées", () => {
    const json = JSON.stringify(d.doc);
    expect(json).toContain('"insertion"');
    expect(json).toContain('"deletion"');
    expect(json).toContain("Paul");
  });
  it("commentaires rattachés au texte", () => {
    const json = JSON.stringify(d.doc);
    expect(json).toContain("À vérifier");
    expect(json).toContain("Marie");
  });
  it("mc:AlternateContent : pas de doublon avec le repli", () => {
    expect(txt).toContain("choix moderne");
    expect(txt).not.toContain("repli doublon");
  });
});

describe("DOCX Word réel — mise en page, en-têtes et pieds de page", () => {
  const d = imp({
    header: p(r("Société Exemple — Confidentiel")),
    footer: p(r("Page ") + `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r("1")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`),
    sectPr: `<w:sectPr><w:headerReference w:type="default" r:id="rIdHd"/><w:footerReference w:type="default" r:id="rIdFt"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1134" w:right="851" w:bottom="1134" w:left="851" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`,
    body: p(r("Corps")),
  });
  it("orientation paysage, marges et en-tête/pied relus", () => {
    expect(d.page?.orientation).toBe("landscape");
    expect(Math.round(d.page?.margins?.left ?? 0)).toBe(15);
    expect(d.page?.header).toContain("Confidentiel");
    expect(d.page?.showPageNumbers || (d.page?.footer ?? "").includes("Page")).toBeTruthy();
  });
});

describe("DOCX — aller-retour page, en-tête/pied et fusions", () => {
  it("export puis réimport : en-tête, pied de page, numéros, orientation, marges", async () => {
    const { docToDocx } = await import("../src/format/docx");
    const { createEliumFile } = await import("../src/format/document");
    const f = await createEliumFile({
      title: "RT",
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Corps" }] }] },
      page: { header: "En-tête société", footer: "Pied confidentiel", showPageNumbers: true, orientation: "landscape", margins: { top: 20, right: 15, bottom: 20, left: 15 } },
    });
    const back = docxToDoc(docToDocx(f));
    expect(back.page?.header).toBe("En-tête société");
    expect(back.page?.footer).toBe("Pied confidentiel");
    expect(back.page?.showPageNumbers).toBe(true);
    expect(back.page?.orientation).toBe("landscape");
    expect(back.page?.format).toBe("A4");
    expect(Math.round(back.page?.margins?.left ?? 0)).toBe(15);
  });
  it("sans en-tête ni pied : aucune partie superflue", async () => {
    const { docToDocx } = await import("../src/format/docx");
    const { createEliumFile } = await import("../src/format/document");
    const { unzipSync } = await import("fflate");
    const f = await createEliumFile({ title: "RT", doc: { type: "doc", content: [{ type: "paragraph" }] }, page: { showPageNumbers: false } });
    const zip = unzipSync(docToDocx(f));
    expect(zip["word/footer1.xml"]).toBeUndefined();
    expect(zip["word/header1.xml"]).toBeUndefined();
  });
  it("colspan et rowspan survivent à l'aller-retour", async () => {
    const { docToDocx } = await import("../src/format/docx");
    const { createEliumFile } = await import("../src/format/document");
    const para = (x: string) => ({ type: "paragraph", content: [{ type: "text", text: x }] });
    const td = (x: string, attrs: Record<string, unknown> = {}, type = "tableCell") => ({ type, attrs, content: [para(x)] });
    const table = {
      type: "table",
      content: [
        { type: "tableRow", content: [td("H1", { colspan: 2 }, "tableHeader"), td("H3", {}, "tableHeader")] },
        { type: "tableRow", content: [td("A", { rowspan: 2 }), td("B"), td("C")] },
        { type: "tableRow", content: [td("D"), td("E")] },
      ],
    };
    const f = await createEliumFile({ title: "T", doc: { type: "doc", content: [table] } });
    const back = docxToDoc(docToDocx(f));
    const tbl = all(back.doc, "table")[0]!;
    const cells = [...all(tbl, "tableCell"), ...all(tbl, "tableHeader")];
    expect(cells.find((c) => textOf(c) === "H1")!.attrs?.colspan).toBe(2);
    expect(cells.find((c) => textOf(c) === "A")!.attrs?.rowspan).toBe(2);
    expect(all(tbl, "tableRow").map((r) => (r.content ?? []).length)).toEqual([2, 3, 2]);
  });
});
