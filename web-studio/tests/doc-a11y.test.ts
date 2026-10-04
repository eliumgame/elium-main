import { describe, it, expect } from "vitest";
import { checkAccessibility, contrastRatio, parseColor, summarizeA11y } from "../src/editor/a11y";
import type { ProseMirrorNode } from "../src/format/types";

const t = (text: string, marks?: unknown[]) => ({ type: "text", text, ...(marks ? { marks } : {}) });
const p = (...c: unknown[]) => ({ type: "paragraph", ...(c.length ? { content: c } : {}) });
const h = (level: number, text: string) => ({ type: "heading", attrs: { level }, content: text ? [t(text)] : [] });
const doc = (...c: unknown[]) => ({ type: "doc", content: c }) as unknown as ProseMirrorNode;
const rules = (d: ProseMirrorNode, o = {}) => checkAccessibility(d, o).map((i) => i.rule);

describe("vérificateur d'accessibilité", () => {
  it("document propre : aucun constat", () => {
    expect(
      checkAccessibility(doc(h(1, "Titre"), p(t("Texte")), h(2, "Section"), p(t("Suite"))), { title: "Mon doc" }),
    ).toEqual([]);
  });
  it("image sans alt (image et figure)", () => {
    const d = doc(
      h(1, "T"),
      { type: "image", attrs: { src: "x", alt: "" } },
      { type: "figure", attrs: { src: "y", alt: "Un graphique" } },
    );
    const r = checkAccessibility(d);
    expect(r.filter((i) => i.rule === "image-alt")).toHaveLength(1);
    expect(r[0]!.severity).toBe("error");
  });
  it("ordre des titres : saut, premier titre non H1, titre vide", () => {
    expect(rules(doc(h(1, "A"), h(3, "B")))).toContain("heading-order");
    expect(rules(doc(h(2, "A")))).toEqual(expect.arrayContaining(["heading-order", "no-title"]));
    expect(rules(doc(h(1, "A"), h(2, "")))).toContain("heading-empty");
    expect(rules(doc(h(1, "A"), h(2, "B"), h(1, "C"), h(2, "D")))).toEqual([]);
  });
  it("tableau : en-tête requis", () => {
    const row = (type: string) => ({ type: "tableRow", content: [{ type, content: [p(t("x"))] }] });
    expect(rules(doc(h(1, "T"), { type: "table", content: [row("tableCell")] }))).toContain("table-header");
    expect(rules(doc(h(1, "T"), { type: "table", content: [row("tableHeader"), row("tableCell")] }))).toEqual([]);
  });
  it("contraste WCAG", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
    expect(parseColor("n'importe quoi")).toBeNull();
    const light = doc(h(1, "T"), p(t("pâle", [{ type: "textStyle", attrs: { color: "#cccccc" } }])));
    expect(rules(light)).toContain("contrast");
    const ok = doc(h(1, "T"), p(t("foncé", [{ type: "textStyle", attrs: { color: "#222222" } }])));
    expect(rules(ok)).toEqual([]);
    // un surlignage foncé rend le texte clair lisible
    const onDark = doc(
      h(1, "T"),
      p(
        t("blanc", [
          { type: "textStyle", attrs: { color: "#ffffff" } },
          { type: "highlight", attrs: { color: "#000000" } },
        ]),
      ),
    );
    expect(rules(onDark)).toEqual([]);
  });
  it("liens peu explicites et paragraphes vides répétés", () => {
    expect(rules(doc(h(1, "T"), p(t("cliquez ici", [{ type: "link", attrs: { href: "https://a.fr" } }]))))).toContain(
      "link-text",
    );
    expect(rules(doc(h(1, "T"), p(), p(), p(), p(t("fin"))))).toContain("empty-paragraphs");
    expect(rules(doc(h(1, "T"), p(), p(t("fin"))))).toEqual([]);
  });
  it("titre de document manquant et positions ProseMirror cohérentes", () => {
    expect(rules(doc(h(1, "T")), { title: "  " })).toContain("doc-title");
    const d = doc(p(t("abc")), { type: "image", attrs: { alt: "" } });
    // paragraphe « abc » = 2 + 3 = 5 → l'image est à la position 5
    expect(checkAccessibility(d).find((i) => i.rule === "image-alt")!.pos).toBe(5);
    expect(summarizeA11y(checkAccessibility(d))).toEqual({ errors: 1, warnings: 0 });
  });
});
