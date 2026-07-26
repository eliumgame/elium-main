import { describe, it, expect } from "vitest";
import { collectTargetsJson, newAnchorId, referenceLabel } from "../src/editor/crossref";
import type { ProseMirrorNode } from "../src/format/types";

const t = (text: string): ProseMirrorNode => ({ type: "text", text });
const h = (level: number, text: string, attrs: Record<string, unknown> = {}): ProseMirrorNode => ({
  type: "heading",
  attrs: { level, ...attrs },
  content: [t(text)],
});
const para = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", content });

const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

describe("Renvois — collecte des cibles", () => {
  it("numérote les titres H1–H3 en 1 / 1.1 / 1.1.1", () => {
    const targets = collectTargetsJson(
      doc(h(1, "Premier"), h(2, "Sous-un"), h(3, "Détail"), h(2, "Sous-deux"), h(1, "Second")),
    );
    expect(targets.map((x) => x.number)).toEqual(["1", "1.1", "1.1.1", "1.2", "2"]);
    expect(targets.map((x) => x.text)).toEqual(["Premier", "Sous-un", "Détail", "Sous-deux", "Second"]);
  });

  it("réinitialise les compteurs de sous-niveaux en descendant d'un cran", () => {
    const targets = collectTargetsJson(doc(h(1, "A"), h(2, "A1"), h(3, "A1a"), h(1, "B"), h(2, "B1")));
    expect(targets.map((x) => x.number)).toEqual(["1", "1.1", "1.1.1", "2", "2.1"]);
  });

  it("ne numérote pas les titres de niveau 4 (le document ne les numérote pas non plus)", () => {
    const targets = collectTargetsJson(doc(h(1, "A"), h(4, "Petit")));
    expect(targets[1]!.number).toBe("");
    expect(targets[1]!.kind).toBe("heading");
  });

  it("numérote figures et tableaux dans l'ordre du document", () => {
    const targets = collectTargetsJson(
      doc(
        { type: "figure", attrs: { src: "x" }, content: [t("Le graphique")] },
        { type: "table", content: [] },
        { type: "figure", attrs: { src: "y" }, content: [] },
      ),
    );
    expect(targets.map((x) => x.number)).toEqual(["Figure 1", "Tableau 1", "Figure 2"]);
    expect(targets[0]!.label).toBe("Figure 1 — Le graphique");
    expect(targets[2]!.label).toBe("Figure 2");
  });

  it("reprend l'id propre des signets et des notes de bas de page", () => {
    const targets = collectTargetsJson(
      doc(
        para({ type: "bookmark", attrs: { id: "bm-7", label: "Clause de résiliation" } }),
        para({ type: "footnote", attrs: { id: "fn-3", text: "Voir annexe II." } }),
      ),
    );
    expect(targets[0]).toMatchObject({ anchorId: "bm-7", kind: "bookmark", text: "Clause de résiliation" });
    expect(targets[1]).toMatchObject({ anchorId: "fn-3", kind: "footnote", number: "1" });
  });

  it("expose l'ancre déjà posée et une chaîne vide sinon", () => {
    const targets = collectTargetsJson(doc(h(1, "Déjà ancré", { refId: "ref-h-42" }), h(1, "Pas encore")));
    expect(targets[0]!.anchorId).toBe("ref-h-42");
    expect(targets[1]!.anchorId).toBe("");
  });

  it("tronque un libellé très long", () => {
    const long = "x".repeat(200);
    const [target] = collectTargetsJson(doc(h(1, long)));
    expect(target!.label.length).toBeLessThanOrEqual(70);
    expect(target!.label.endsWith("…")).toBe(true);
  });

  it("trouve les cibles imbriquées dans des tableaux et des listes", () => {
    const targets = collectTargetsJson(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [para({ type: "bookmark", attrs: { id: "bm-in", label: "dedans" } })] }],
          },
        ],
      }),
    );
    expect(targets.map((x) => x.kind)).toEqual(["table", "bookmark"]);
  });
});

describe("Renvois — libellé affiché", () => {
  const target = collectTargetsJson(doc(h(1, "Conditions"), h(2, "Modalités de paiement")))[1]!;

  it("affiche le texte de la cible", () => {
    expect(referenceLabel(target, "text", null)).toBe("Modalités de paiement");
  });

  it("affiche le numéro de la cible", () => {
    expect(referenceLabel(target, "number", null)).toBe("1.1");
  });

  it("numérote un H2 orphelin comme le document l'affiche lui-même", () => {
    // Les compteurs CSS de la numérotation des titres partent de 0 : un H2 sans
    // H1 au-dessus s'affiche « 0.1 » à l'écran, et le renvoi doit dire la même
    // chose que ce que le lecteur voit.
    const orphan = collectTargetsJson(doc(h(2, "Orpheline")))[0]!;
    expect(referenceLabel(orphan, "number", null)).toBe("0.1");
  });

  it("affiche le numéro de page, et le signale quand la pagination est inconnue", () => {
    expect(referenceLabel(target, "page", { targetPage: 4 })).toBe("page 4");
    expect(referenceLabel(target, "page", null)).toBe("page ?");
    expect(referenceLabel(target, "page", { targetPage: null })).toBe("page ?");
  });

  it("combine texte et page", () => {
    expect(referenceLabel(target, "full", { targetPage: 9 })).toBe("1.1 Modalités de paiement, page 9");
    expect(referenceLabel(target, "full", null)).toBe("1.1 Modalités de paiement");
  });

  it("choisit ci-dessus ou ci-dessous selon la position du renvoi", () => {
    const above = { ...target, pos: 10 };
    expect(referenceLabel(above, "aboveBelow", { refPos: 50 })).toBe("ci-dessus");
    expect(referenceLabel(above, "aboveBelow", { refPos: 2 })).toBe("ci-dessous");
  });

  it("retombe sur ci-dessus quand aucune position n'est connue", () => {
    expect(referenceLabel({ ...target, pos: -1 }, "aboveBelow", { refPos: 5 })).toBe("ci-dessus");
    expect(referenceLabel(target, "aboveBelow", null)).toBe("ci-dessus");
  });

  it("retombe sur le texte quand la cible n'a pas de numéro", () => {
    const bookmark = collectTargetsJson(
      doc(para({ type: "bookmark", attrs: { id: "bm-1", label: "Annexe" } })),
    )[0]!;
    expect(referenceLabel(bookmark, "number", null)).toBe("Annexe");
  });
});

describe("Renvois — génération d'ancre", () => {
  it("préfixe l'ancre selon le type et reste unique", () => {
    expect(newAnchorId("heading")).toMatch(/^ref-h-/);
    expect(newAnchorId("figure")).toMatch(/^ref-fig-/);
    expect(newAnchorId("table")).toMatch(/^ref-tbl-/);
    expect(newAnchorId("heading")).not.toBe(newAnchorId("heading"));
  });
});
