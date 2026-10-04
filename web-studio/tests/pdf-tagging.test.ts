import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { checkAccessibility } from "../src/pdf/ops/accessibility";
import { figureKey, isTagged, listFigures, setFigureAlts, tagDocument } from "../src/pdf/ops/tagging";
import { readPageContentBytes } from "../src/pdf/ops/content";

// PNG 1×1 rouge.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
    .split("")
    .map((c) => c.charCodeAt(0)),
);

async function sample(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(PNG);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([400, 400]);
    p.drawText(`Titre ${i}`, { x: 20, y: 360, size: 20, font });
    p.drawText("Un paragraphe.", { x: 20, y: 300, size: 12, font });
    p.drawImage(img, { x: 20, y: 100, width: 50, height: 50 });
  }
  return PDFDocument.load(await doc.save(), { updateMetadata: false });
}

const status = (rules: ReturnType<typeof checkAccessibility>, rule: string) => rules.find((r) => r.rule === rule)?.status;

describe("balisage PDF/UA", () => {
  it("crée l'arbre de structure, la langue, le titre et le ParentTree", async () => {
    const doc = await sample();
    expect(isTagged(doc)).toBe(false);
    const before = checkAccessibility(doc);
    expect(status(before, "PDF balisé")).toBe("fail");

    const alts = new Map([[figureKey(0, 0), "Logo rouge"]]);
    const report = tagDocument(doc, { lang: "fr-FR", title: "Mon document", alts });
    expect(report).toMatchObject({ tagged: true, pages: 2, paragraphs: 4, figures: 2, figuresWithoutAlt: 1 });

    const reloaded = await PDFDocument.load(await doc.save(), { updateMetadata: false });
    const after = checkAccessibility(reloaded);
    expect(status(after, "PDF balisé")).toBe("pass");
    expect(status(after, "Langue principale")).toBe("pass");
    expect(status(after, "Titre")).toBe("pass");
    // Une figure sur deux a son alt : la règle échoue et le dit.
    expect(status(after, "Texte de remplacement des figures")).toBe("fail");

    const content = new TextDecoder("latin1").decode(readPageContentBytes(reloaded.getPage(0)));
    expect(content).toMatch(/\/P <<\/MCID 0 ?>> BDC/);
    expect(content).toMatch(/\/Figure <<\/MCID 2 ?>> BDC/);
    expect(content.match(/EMC/g)).toHaveLength(3);
  });

  it("ne re-balise pas un document déjà balisé, et édite les textes de remplacement", async () => {
    const doc = await sample();
    tagDocument(doc, { lang: "fr-FR" });
    const again = await PDFDocument.load(await doc.save(), { updateMetadata: false });
    const r = tagDocument(again, { lang: "en-GB", title: "T" });
    expect(r.alreadyTagged).toBe(true);
    expect(r.tagged).toBe(false);

    expect(listFigures(again).map((f) => [f.page, f.index, f.alt])).toEqual([
      [0, 0, ""],
      [1, 0, ""],
    ]);
    setFigureAlts(
      again,
      new Map([
        [figureKey(0, 0), "Premier"],
        [figureKey(1, 0), "Second"],
      ]),
    );
    const final = await PDFDocument.load(await again.save(), { updateMetadata: false });
    expect(listFigures(final).map((f) => f.alt)).toEqual(["Premier", "Second"]);
    expect(status(checkAccessibility(final), "Texte de remplacement des figures")).toBe("pass");
  });

  it("signale un document sans contenu", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const r = tagDocument(doc, { lang: "fr-FR" });
    expect(r.tagged).toBe(false);
    expect(r.notes.join(" ")).toMatch(/OCR/);
  });
});
