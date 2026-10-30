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
  it("les modèles sont de vrais documents structurés, pas des squelettes", () => {
    const count = (n: unknown, type: string): number => {
      const node = n as { type: string; content?: unknown[] };
      return (node.type === type ? 1 : 0) + (node.content ?? []).reduce<number>((a, c) => a + count(c, type), 0);
    };
    const words = (n: unknown): number => {
      const node = n as { text?: string; content?: unknown[] };
      return (
        (node.text ? node.text.split(/\s+/).filter(Boolean).length : 0) +
        (node.content ?? []).reduce<number>((a, c) => a + words(c), 0)
      );
    };
    for (const t of TEMPLATES) {
      const { doc } = t.build();
      const html = docToHtml(createDocumentModel(doc, t.page));
      // Aucun point de suspension de remplissage : le contenu d'exemple est réaliste.
      expect(html, t.id).not.toContain("……");
      if (t.id === "blank") continue;
      // Courriers et pièces comptables suivent leur mise en page normée : pas de titres.
      if (!["courrier", "lettre-motivation", "facture", "devis"].includes(t.id))
        expect(count(doc, "heading"), t.id).toBeGreaterThanOrEqual(1);
      expect(words(doc), t.id).toBeGreaterThan(60);
    }
    for (const id of ["rapport", "facture", "devis", "compte-rendu", "fiche"]) {
      const { doc } = TEMPLATES.find((t) => t.id === id)!.build();
      expect(count(doc, "table"), id).toBeGreaterThanOrEqual(1);
    }
  });
  it("les tableaux de données portent un style de tableau intégré", () => {
    const { doc } = TEMPLATES.find((t) => t.id === "facture")!.build();
    const tables = (doc.content ?? []).filter((n) => n.type === "table");
    expect(tables.some((t) => t.attrs?.tableStyle === "header-accent")).toBe(true);
  });
});
