import { describe, it, expect } from "vitest";
import { TEMPLATES } from "../src/editor/templates";
import { createDocumentModel } from "../src/format/document";
import { docToHtml } from "../src/export/exporters";

describe("galerie de modèles", () => {
  it("propose les modèles attendus, avec identifiants uniques", () => {
    const ids = TEMPLATES.map((t) => t.id);
    for (const want of [
      "cv",
      "lettre-motivation",
      "rapport",
      "facture",
      "compte-rendu",
      "memo",
      "proces-verbal",
      "devis",
    ])
      expect(ids).toContain(want);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("chaque modèle produit un document valide, rendu en HTML non vide", () => {
    for (const t of TEMPLATES) {
      const { title, doc } = t.build();
      expect(title.length).toBeGreaterThan(0);
      expect(doc.type).toBe("doc");
      const html = docToHtml(createDocumentModel(doc, t.page));
      expect(html.length).toBeGreaterThan(50);
    }
  });
  it("les modèles réunion portent en-tête/pied de page et numéros", () => {
    const cr = TEMPLATES.find((t) => t.id === "compte-rendu")!;
    expect(cr.page?.header).toBeTruthy();
    expect(cr.page?.showPageNumbers).toBe(true);
    expect(TEMPLATES.find((t) => t.id === "proces-verbal")!.page?.footer).toBeTruthy();
    const model = createDocumentModel(cr.build().doc, cr.page);
    expect(model.page.header).toBe("Compte rendu de réunion");
  });
  it("chaque modèle a une catégorie", () => {
    for (const t of TEMPLATES) expect(t.category).toBeTruthy();
  });
});
