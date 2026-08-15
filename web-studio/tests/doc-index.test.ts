import { describe, it, expect } from "vitest";
import { buildIndex, buildIndexJson, indexTerms } from "../src/editor/indexing";
import type { ProseMirrorNode } from "../src/format/types";

/** A fake ProseMirror doc exposing just `descendants`, with chosen positions. */
function liveDoc(marks: { term: string; sub?: string; pos: number }[]) {
  return {
    descendants(fn: (node: { type: { name: string }; attrs: Record<string, unknown> }, pos: number) => boolean | void) {
      for (const m of marks) {
        fn({ type: { name: "indexEntry" }, attrs: { term: m.term, sub: m.sub ?? "" } }, m.pos);
      }
    },
  };
}

const jsonDoc = (marks: { term: string; sub?: string }[]): ProseMirrorNode => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: marks.map((m) => ({ type: "indexEntry", attrs: { term: m.term, sub: m.sub ?? "" } })),
    },
  ],
});

describe("Index — regroupement alphabétique", () => {
  it("groupe par initiale et trie les entrées", () => {
    const groups = buildIndex(
      liveDoc([
        { term: "Signature", pos: 10 },
        { term: "Archivage", pos: 20 },
        { term: "Chiffrement", pos: 30 },
      ]),
      () => 1,
    );
    expect(groups.map((g) => g.letter)).toEqual(["A", "C", "S"]);
    expect(groups[0]!.entries[0]!.term).toBe("Archivage");
  });

  it("classe les accents avec la lettre de base", () => {
    const groups = buildIndex(
      liveDoc([
        { term: "Élision", pos: 1 },
        { term: "Effacement", pos: 2 },
      ]),
      () => 1,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.letter).toBe("E");
    expect(groups[0]!.entries.map((e) => e.term)).toEqual(["Effacement", "Élision"]);
  });

  it("range chiffres et symboles dans un groupe # placé en dernier", () => {
    const groups = buildIndex(
      liveDoc([
        { term: "256 bits", pos: 1 },
        { term: "Clé", pos: 2 },
      ]),
      () => 1,
    );
    expect(groups.map((g) => g.letter)).toEqual(["C", "#"]);
  });

  it("fusionne les variantes de casse et d'accent d'un même terme", () => {
    const groups = buildIndex(
      liveDoc([
        { term: "Clé", pos: 1 },
        { term: "clé", pos: 2 },
        { term: "CLE", pos: 3 },
      ]),
      (pos) => pos,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toHaveLength(1);
    expect(groups[0]!.entries[0]!.pages).toEqual([1, 2, 3]);
  });

  it("ignore les entrées sans terme", () => {
    const groups = buildIndex(
      liveDoc([
        { term: "   ", pos: 1 },
        { term: "Réel", pos: 2 },
      ]),
      () => 1,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries[0]!.term).toBe("Réel");
  });

  it("normalise les espaces internes du terme", () => {
    const groups = buildIndex(liveDoc([{ term: "  clé   privée ", pos: 1 }]), () => 1);
    expect(groups[0]!.entries[0]!.term).toBe("clé privée");
  });
});

describe("Index — numéros de page", () => {
  it("dédoublonne et trie les pages d'un terme", () => {
    const groups = buildIndex(
      liveDoc([
        { term: "Sceau", pos: 1 },
        { term: "Sceau", pos: 2 },
        { term: "Sceau", pos: 3 },
      ]),
      (pos) => [7, 2, 7][pos - 1]!,
    );
    expect(groups[0]!.entries[0]!.pages).toEqual([2, 7]);
  });

  it("laisse les pages vides quand la pagination est indisponible", () => {
    const groups = buildIndex(liveDoc([{ term: "Sceau", pos: 1 }]), () => null);
    expect(groups[0]!.entries[0]!.pages).toEqual([]);
  });

  it("n'expose aucune page depuis du JSON brut (pas de mise en page)", () => {
    const groups = buildIndexJson(jsonDoc([{ term: "Sceau" }]));
    expect(groups[0]!.entries[0]!.pages).toEqual([]);
  });
});

describe("Index — sous-entrées", () => {
  it("range les sous-entrées sous leur terme, triées, avec leurs propres pages", () => {
    const groups = buildIndex(
      liveDoc([
        { term: "Chiffrement", sub: "symétrique", pos: 1 },
        { term: "Chiffrement", sub: "asymétrique", pos: 2 },
        { term: "Chiffrement", pos: 3 },
      ]),
      (pos) => pos,
    );
    const entry = groups[0]!.entries[0]!;
    expect(entry.term).toBe("Chiffrement");
    expect(entry.pages).toEqual([3]);
    expect(entry.subs.map((s) => s.term)).toEqual(["asymétrique", "symétrique"]);
    expect(entry.subs[0]!.pages).toEqual([2]);
    expect(entry.subs[1]!.pages).toEqual([1]);
  });

  it("n'attribue pas la page d'une sous-entrée au terme parent", () => {
    const groups = buildIndex(liveDoc([{ term: "Clé", sub: "publique", pos: 5 }]), (pos) => pos);
    expect(groups[0]!.entries[0]!.pages).toEqual([]);
    expect(groups[0]!.entries[0]!.subs[0]!.pages).toEqual([5]);
  });
});

describe("Index — liste des termes existants", () => {
  it("dédoublonne, trie et ignore les termes vides", () => {
    expect(indexTerms(jsonDoc([{ term: "Sceau" }, { term: "sceau" }, { term: "Archive" }, { term: " " }]))).toEqual([
      "Archive",
      "Sceau",
    ]);
  });

  it("retourne une liste vide pour un document sans marque", () => {
    expect(indexTerms({ type: "doc", content: [{ type: "paragraph" }] })).toEqual([]);
  });

  it("trouve les marques imbriquées profondément", () => {
    const nested: ProseMirrorNode = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "indexEntry", attrs: { term: "Cellule" } }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(indexTerms(nested)).toEqual(["Cellule"]);
  });
});
