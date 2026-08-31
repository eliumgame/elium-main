import { describe, it, expect } from "vitest";
import { compareDocuments, diffSeq, hasChanges } from "../src/editor/compare";
import type { ProseMirrorNode } from "../src/format/types";

const p = (text: string, attrs?: Record<string, unknown>): ProseMirrorNode => ({
  type: "paragraph",
  ...(attrs ? { attrs } : {}),
  content: text ? [{ type: "text", text }] : [],
});
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

/** Flatten to "text[mark]" pieces so assertions read clearly. */
function pieces(node: ProseMirrorNode): string[] {
  const out: string[] = [];
  const walk = (n: ProseMirrorNode) => {
    if (n.type === "text") {
      const change = (n.marks ?? []).find((m) => m.type === "insertion" || m.type === "deletion");
      out.push(change ? `${n.text}[${change.type === "insertion" ? "+" : "-"}]` : `${n.text}`);
    }
    (n.content ?? []).forEach(walk);
  };
  walk(node);
  return out;
}

/** Simulate "accept all": drop deletions, unwrap insertions. */
function accepted(node: ProseMirrorNode): string {
  const out: string[] = [];
  const walk = (n: ProseMirrorNode) => {
    if (n.type === "text") {
      if (!(n.marks ?? []).some((m) => m.type === "deletion")) out.push(n.text ?? "");
      return;
    }
    (n.content ?? []).forEach(walk);
  };
  walk(node);
  return out.join("");
}

/** Simulate "reject all": drop insertions, unwrap deletions. */
function rejected(node: ProseMirrorNode): string {
  const out: string[] = [];
  const walk = (n: ProseMirrorNode) => {
    if (n.type === "text") {
      if (!(n.marks ?? []).some((m) => m.type === "insertion")) out.push(n.text ?? "");
      return;
    }
    (n.content ?? []).forEach(walk);
  };
  walk(node);
  return out.join("");
}

describe("Comparaison — diff de séquences", () => {
  it("ne signale rien entre deux séquences identiques", () => {
    expect(diffSeq(["a", "b"], ["a", "b"]).every((o) => o.kind === "equal")).toBe(true);
  });

  it("repère une insertion au milieu", () => {
    const ops = diffSeq(["a", "c"], ["a", "b", "c"]);
    expect(ops.filter((o) => o.kind === "ins")).toHaveLength(1);
    expect(ops.filter((o) => o.kind === "del")).toHaveLength(0);
  });

  it("repère une suppression au milieu", () => {
    const ops = diffSeq(["a", "b", "c"], ["a", "c"]);
    expect(ops.filter((o) => o.kind === "del")).toHaveLength(1);
  });

  it("gère les séquences vides", () => {
    expect(diffSeq([], ["a"]).map((o) => o.kind)).toEqual(["ins"]);
    expect(diffSeq(["a"], []).map((o) => o.kind)).toEqual(["del"]);
    expect(diffSeq([], [])).toEqual([]);
  });

  it("conserve les préfixes et suffixes communs", () => {
    const ops = diffSeq(["x", "a", "y"], ["x", "b", "y"]);
    expect(ops[0]).toEqual({ kind: "equal", a: 0, b: 0 });
    expect(ops[ops.length - 1]).toEqual({ kind: "equal", a: 2, b: 2 });
  });
});

describe("Comparaison — documents", () => {
  it("ne marque rien quand les documents sont identiques", () => {
    const a = doc(p("Bonjour le monde"), p("Deuxième paragraphe"));
    const { doc: merged, summary } = compareDocuments(a, structuredClone(a));
    expect(hasChanges(summary)).toBe(false);
    expect(pieces(merged)).toEqual(["Bonjour le monde", "Deuxième paragraphe"]);
  });

  it("marque un mot remplacé au niveau du mot, pas du paragraphe", () => {
    const { doc: merged, summary } = compareDocuments(
      doc(p("Le contrat prend effet lundi")),
      doc(p("Le contrat prend effet mardi")),
    );
    expect(pieces(merged)).toEqual(["Le contrat prend effet ", "lundi[-]", "mardi[+]"]);
    expect(summary.blocksChanged).toBe(1);
    expect(summary.deletions).toBe(5);
    expect(summary.insertions).toBe(5);
  });

  it("respecte l'invariant accepter/refuser sur le texte", () => {
    const original = doc(p("alpha beta gamma"), p("delta"));
    const revised = doc(p("alpha BETA gamma"), p("delta"), p("epsilon"));
    const { doc: merged } = compareDocuments(original, revised);
    expect(rejected(merged)).toBe("alpha beta gammadelta");
    expect(accepted(merged)).toBe("alpha BETA gammadeltaepsilon");
  });

  it("marque un paragraphe entièrement ajouté", () => {
    const { doc: merged, summary } = compareDocuments(doc(p("un")), doc(p("un"), p("deux")));
    expect(pieces(merged)).toEqual(["un", "deux[+]"]);
    expect(summary.blocksAdded).toBe(1);
    expect(summary.blocksRemoved).toBe(0);
  });

  it("marque un paragraphe entièrement supprimé", () => {
    const { doc: merged, summary } = compareDocuments(doc(p("un"), p("deux")), doc(p("un")));
    expect(pieces(merged)).toEqual(["un", "deux[-]"]);
    expect(summary.blocksRemoved).toBe(1);
  });

  it("préserve la mise en forme des mots conservés", () => {
    const original = doc({
      type: "paragraph",
      content: [
        { type: "text", text: "Montant " },
        { type: "text", text: "1000", marks: [{ type: "bold" }] },
        { type: "text", text: " euros" },
      ],
    });
    const revised = doc({
      type: "paragraph",
      content: [
        { type: "text", text: "Montant " },
        { type: "text", text: "2000", marks: [{ type: "bold" }] },
        { type: "text", text: " euros" },
      ],
    });
    const { doc: merged } = compareDocuments(original, revised);
    const bold = (merged.content![0]!.content ?? []).filter((n) => (n.marks ?? []).some((m) => m.type === "bold"));
    expect(bold).toHaveLength(2);
    expect(bold.map((n) => n.text)).toEqual(["1000", "2000"]);
    expect(pieces(merged)).toEqual(["Montant ", "1000[-]", "2000[+]", " euros"]);
  });

  it("descend dans les listes au lieu de tout remplacer", () => {
    const list = (second: string): ProseMirrorNode =>
      doc({
        type: "bulletList",
        content: [
          { type: "listItem", content: [p("premier point")] },
          { type: "listItem", content: [p(second)] },
        ],
      });
    const { doc: merged, summary } = compareDocuments(list("second point"), list("second point revu"));
    expect(pieces(merged)).toEqual(["premier point", "second point", " revu[+]"]);
    expect(summary.blocksAdded).toBe(0);
    expect(summary.blocksRemoved).toBe(0);
  });

  it("descend dans les cellules d'un tableau", () => {
    const table = (cell: string): ProseMirrorNode =>
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [p("Poste")] },
              { type: "tableCell", content: [p(cell)] },
            ],
          },
        ],
      });
    const { doc: merged } = compareDocuments(table("1000"), table("2000"));
    expect(pieces(merged)).toEqual(["Poste", "1000[-]", "2000[+]"]);
  });

  it("estampille l'auteur et la date sur chaque marque", () => {
    const { doc: merged } = compareDocuments(doc(p("a")), doc(p("b")), { author: "Alice", ts: "2026-07-26T10:00:00Z" });
    const marks = (merged.content![0]!.content ?? []).flatMap((n) => n.marks ?? []);
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) {
      expect(m.attrs).toMatchObject({ author: "Alice", ts: "2026-07-26T10:00:00Z" });
    }
  });

  it("adopte la révision pour une différence de mise en forme seule", () => {
    const { doc: merged, summary } = compareDocuments(
      doc(p("texte", { textAlign: "left" })),
      doc(p("texte", { textAlign: "center" })),
    );
    expect(merged.content![0]!.attrs).toMatchObject({ textAlign: "center" });
    expect(summary.blocksChanged).toBe(1);
    expect(summary.insertions).toBe(0);
    expect(summary.deletions).toBe(0);
  });

  it("suit la révision pour les blocs structurels et le signale", () => {
    const { doc: merged, summary } = compareDocuments(doc(p("a"), { type: "pageBreak" }, p("b")), doc(p("a"), p("b")));
    expect(merged.content!.some((n) => n.type === "pageBreak")).toBe(false);
    expect(summary.structural).toBe(1);
  });

  it("garde un saut de page ajouté par la révision", () => {
    const { doc: merged, summary } = compareDocuments(doc(p("a"), p("b")), doc(p("a"), { type: "pageBreak" }, p("b")));
    expect(merged.content!.some((n) => n.type === "pageBreak")).toBe(true);
    expect(summary.structural).toBe(1);
  });

  it("diffe les nœuds en ligne comme les notes de bas de page", () => {
    const withNote = doc({
      type: "paragraph",
      content: [
        { type: "text", text: "texte" },
        { type: "footnote", attrs: { id: "fn-1", text: "note" } },
      ],
    });
    const withoutNote = doc(p("texte"));
    const { doc: merged, summary } = compareDocuments(withNote, withoutNote);
    const note = (merged.content![0]!.content ?? []).find((n) => n.type === "footnote");
    expect(note).toBeDefined();
    expect((note!.marks ?? []).some((m) => m.type === "deletion")).toBe(true);
    expect(summary.deletions).toBe(1);
  });

  it("ne rend jamais un document vide", () => {
    const { doc: merged } = compareDocuments(doc(), doc());
    expect(merged.content).toEqual([{ type: "paragraph" }]);
  });

  it("marque le remplacement de l'image d'une figure malgré une légende inchangée", () => {
    // Non-régression du constat P2 : contentSig/blockSig ignoraient les
    // attributs des blocs non-vides, donc remplacer l'image d'une figure en
    // gardant la même légende ne produisait aucune marque de changement.
    const figure = (src: string): ProseMirrorNode => ({
      type: "figure",
      attrs: { src, alt: "", align: "center", width: null },
      content: [{ type: "text", text: "Légende" }],
    });
    const { doc: merged, summary } = compareDocuments(doc(figure("a.png")), doc(figure("b.png")));
    expect(summary.blocksChanged).toBe(1);
    expect(merged.content![0]!.attrs).toMatchObject({ src: "b.png" });
  });

  it("marque le changement du nombre de colonnes d'une section, texte inchangé", () => {
    const section = (count: number): ProseMirrorNode => ({
      type: "columnSection",
      attrs: { count, gapMm: 8, separator: false },
      content: [p("texte identique")],
    });
    const { doc: merged, summary } = compareDocuments(doc(section(2)), doc(section(3)));
    expect(summary.blocksChanged).toBeGreaterThanOrEqual(1);
    expect(merged.content![0]!.attrs).toMatchObject({ count: 3 });
    // Le texte lui-même n'est pas touché : pas de marques ins/del.
    expect(pieces(merged)).toEqual(["texte identique"]);
  });

  it("gère un document entièrement réécrit", () => {
    const { doc: merged, summary } = compareDocuments(doc(p("ancien texte")), doc(p("nouveau contenu")));
    expect(accepted(merged)).toBe("nouveau contenu");
    expect(rejected(merged)).toBe("ancien texte");
    expect(summary.insertions).toBeGreaterThan(0);
    expect(summary.deletions).toBeGreaterThan(0);
  });
});
