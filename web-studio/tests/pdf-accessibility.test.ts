import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef } from "pdf-lib";
import { checkAccessibility } from "../src/pdf/ops/accessibility";

/** Accessibility check: the rules Acrobat's full check reports, judged from the file. */

const statusOf = (rules: ReturnType<typeof checkAccessibility>, rule: string) =>
  rules.find((r) => r.rule === rule)?.status;

describe("accessibility check", () => {
  it("an untagged document without language or title fails those rules; manual ones are listed", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const rules = checkAccessibility(doc, ["Bonjour"]);
    expect(statusOf(rules, "PDF balisé")).toBe("fail");
    expect(statusOf(rules, "Langue principale")).toBe("fail");
    expect(statusOf(rules, "Titre")).toBe("fail");
    expect(statusOf(rules, "PDF image uniquement")).toBe("pass");
    expect(statusOf(rules, "Ordre de lecture logique")).toBe("manual");
    expect(statusOf(rules, "Contraste des couleurs")).toBe("manual");
    expect(statusOf(checkAccessibility(doc, [""]), "PDF image uniquement")).toBe("fail");
  });

  it("a tagged document: title, language pass; missing alt text, table headers and a heading jump are found", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.setTitle("Rapport", { showInWindowTitleBar: true });
    doc.setLanguage("fr-FR");
    const ctx = doc.context;
    const el = (s: string, kids: PDFRef[] = [], extra: Record<string, unknown> = {}) =>
      ctx.register(ctx.obj({ Type: "StructElem", S: s, K: kids, ...extra }) as PDFDict);
    const td = el("TD");
    const tr = el("TR", [td]);
    const table = el("Table", [tr]);
    const fig = el("Figure");
    const figOk = el("Figure", [], { Alt: PDFHexString.fromText("Logo") });
    const lbody = el("LBody");
    const li = el("LI", [lbody]);
    const list = el("L", [li]);
    const h1 = el("H1");
    const h3 = el("H3");
    const document = el("Document", [h1, h3, fig, figOk, table, list]);
    doc.catalog.set(
      PDFName.of("StructTreeRoot"),
      ctx.register(ctx.obj({ Type: "StructTreeRoot", K: document }) as PDFDict),
    );
    doc.catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }));
    const rules = checkAccessibility(doc, ["Texte"]);
    expect(statusOf(rules, "PDF balisé")).toBe("pass");
    expect(statusOf(rules, "Titre")).toBe("pass");
    expect(statusOf(rules, "Langue principale")).toBe("pass");
    expect(rules.find((r) => r.rule === "Texte de remplacement des figures")).toMatchObject({
      status: "fail",
      detail: "1 figure(s) sur 2 sans texte de remplacement.",
    });
    expect(statusOf(rules, "En-têtes")).toBe("fail");
    expect(statusOf(rules, "Lignes et cellules (TR, TH, TD)")).toBe("pass");
    expect(statusOf(rules, "Éléments de liste (LI, Lbl, LBody)")).toBe("pass");
    expect(statusOf(rules, "Imbrication appropriée")).toBe("fail");
  });
});
