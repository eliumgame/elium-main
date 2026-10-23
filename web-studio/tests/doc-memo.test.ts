import { describe, expect, it } from "vitest";
import { memoByDoc } from "../src/editor/doc-memo";
import { collectTargets, targetsByAnchor } from "../src/editor/crossref";
import { collectCaptions } from "../src/editor/captions";
import { collectNotes } from "../src/editor/notes";
import { buildIndex } from "../src/editor/indexing";
import { createPageResolver, pageAt, type PagePlan } from "../src/editor/Pagination";

type FakeNode = { type: { name: string }; attrs: Record<string, unknown>; textContent: string };
function fakeDoc(nodes: Array<[FakeNode, number]>) {
  const calls = { descendants: 0 };
  const doc = {
    calls,
    descendants(fn: (n: FakeNode, p: number) => boolean | void) {
      calls.descendants += 1;
      for (const [n, p] of nodes) fn(n, p);
    },
  };
  return doc;
}
const reads = new WeakMap<object, number>();
const node = (name: string, attrs: Record<string, unknown> = {}, text = ""): FakeNode => {
  const n: FakeNode = {
    type: { name },
    attrs,
    get textContent() {
      reads.set(n, (reads.get(n) ?? 0) + 1);
      return text;
    },
  };
  return n;
};

describe("memoByDoc", () => {
  it("ne calcule qu'une fois par document et par clé", () => {
    const doc = {};
    let n = 0;
    expect(memoByDoc(doc, "k", () => ++n)).toBe(1);
    expect(memoByDoc(doc, "k", () => ++n)).toBe(1);
    expect(memoByDoc(doc, "autre", () => ++n)).toBe(2);
    expect(memoByDoc({}, "k", () => ++n)).toBe(3);
  });
});

describe("collecteurs mémoïsés par document", () => {
  const doc = fakeDoc([
    [node("heading", { level: 1 }, "Titre"), 0],
    [node("paragraph", {}, "Un long paragraphe"), 10],
    [node("caption", { label: "Figure" }, "Légende"), 40],
    [node("footnote", { id: "n1", text: "x" }), 60],
    [node("indexEntry", { term: "mot" }), 70],
  ]);

  it("un seul parcours pour N appels (renvois, légendes, notes, index)", () => {
    for (let i = 0; i < 50; i++) {
      collectTargets(doc);
      targetsByAnchor(doc);
      collectCaptions(doc);
      collectNotes(doc, "footnote");
      buildIndex(doc, null);
    }
    // targets + captions + footnotes + indexRaws = 4 parcours, indépendamment des 50 tours.
    expect(doc.calls.descendants).toBe(4);
  });

  it("garde les mêmes résultats", () => {
    expect(collectTargets(doc).map((t) => t.kind)).toEqual(["heading", "caption", "footnote"]);
    expect(collectCaptions(doc)).toHaveLength(1);
    expect(collectNotes(doc, "footnote")[0]!.marker).toBe("1");
  });

  it("ne lit textContent que pour les titres, figures et légendes", () => {
    const para = node("paragraph", {}, "x");
    const d = fakeDoc([[para, 0]]);
    collectTargets(d);
    expect(reads.get(para) ?? 0).toBe(0);
  });
});

describe("createPageResolver", () => {
  const sizes = [5, 8, 3, 12, 7];
  const state = {
    doc: {
      forEach(fn: (n: { nodeSize: number }, offset: number) => void) {
        let off = 0;
        for (const s of sizes) {
          fn({ nodeSize: s }, off);
          off += s;
        }
      },
    },
  } as unknown as import("@tiptap/pm/state").EditorState;
  const plan: PagePlan = {
    spacers: [],
    pageStartByPos: new Map([
      [0, 1],
      [5, 1],
      [13, 2],
      [16, 3],
      [28, 3],
    ]),
    pageCount: 3,
    pages: [],
  } as unknown as PagePlan;

  it("donne la même page que pageAt pour chaque position (y compris hors du document)", () => {
    const at = createPageResolver(plan, state);
    for (let pos = -2; pos < 40; pos++) expect(at(pos)).toBe(pageAt(plan, state, pos));
  });
});

describe("countWords (barre d'état)", () => {
  const ref = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
  it("donne le même résultat que le découpage par espaces", async () => {
    const { countWords } = await import("../src/editor/EditorStatusBar");
    const samples = [
      "",
      "   ",
      "un",
      " un  deux\ttrois\nquatre\r\ncinq ",
      "a b c d　e﻿ f",
      "mot-composé l'élision… fin.",
      "\n\nligne\n\n",
    ];
    for (const s of samples) expect(countWords(s), JSON.stringify(s)).toBe(ref(s));
  });
});
