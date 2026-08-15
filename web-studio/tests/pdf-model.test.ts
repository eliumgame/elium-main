import { describe, it, expect } from "vitest";
import * as D from "../src/pdf/model/doc";
import { emptyState, newId, type Annot, type PdfState } from "../src/pdf/model/types";
import { base64ToBytes, bytesToBase64, deserialize, serialize } from "../src/pdf/model/persist";

function stateWithPages(n: number): PdfState {
  return { ...emptyState(), pages: D.pagesFromSource(n) };
}

const annot = (over: Partial<Annot> = {}): Annot => ({
  id: newId("an"),
  pageId: "p",
  kind: "square",
  rect: { x: 10, y: 20, w: 100, h: 40 },
  color: "#e11d48",
  opacity: 1,
  strokeWidth: 2,
  author: "Moi",
  createdAt: "2026-01-01T10:00:00.000Z",
  modifiedAt: "2026-01-01T10:00:00.000Z",
  replies: [],
  ...over,
});

describe("PDF model — pages", () => {
  it("moves a block of pages to a new position, keeping their relative order", () => {
    const s = stateWithPages(5);
    const ids = [s.pages[3].id, s.pages[4].id];
    const next = D.reorderPages(s, ids, 1);
    expect(next.pages.map((p) => p.from)).toEqual([0, 3, 4, 1, 2]);
  });

  it("is a no-op when the moved pages land where they already are", () => {
    const s = stateWithPages(3);
    const next = D.reorderPages(s, [s.pages[0].id], 0);
    expect(next.pages.map((p) => p.from)).toEqual([0, 1, 2]);
  });

  it("deletes pages together with everything anchored to them", () => {
    let s = stateWithPages(3);
    const victim = s.pages[1].id;
    s = D.addAnnot(s, annot({ pageId: victim }));
    s = D.addAnnot(s, annot({ pageId: s.pages[0].id }));
    s = D.addField(s, { id: "f1", pageId: victim, name: "nom", kind: "text", rect: { x: 0, y: 0, w: 10, h: 10 } });
    const next = D.deletePages(s, [victim]);
    expect(next.pages).toHaveLength(2);
    expect(next.annots).toHaveLength(1);
    expect(next.createdFields).toHaveLength(0);
  });

  it("refuses to empty the document", () => {
    const s = stateWithPages(2);
    const next = D.deletePages(
      s,
      s.pages.map((p) => p.id),
    );
    expect(next.pages).toHaveLength(2);
  });

  it("duplicates a page with copies of its annotations, not shared references", () => {
    let s = stateWithPages(2);
    s = D.addAnnot(s, annot({ pageId: s.pages[0].id, paths: [[{ x: 1, y: 2 }]] }));
    const next = D.duplicatePages(s, [s.pages[0].id]);
    expect(next.pages).toHaveLength(3);
    expect(next.annots).toHaveLength(2);
    expect(next.annots[0].id).not.toBe(next.annots[1].id);
    expect(next.annots[0].pageId).not.toBe(next.annots[1].pageId);
    next.annots[1].paths![0][0].x = 99;
    expect(next.annots[0].paths![0][0].x).toBe(1);
  });

  it("accumulates rotations modulo a full turn", () => {
    let s = stateWithPages(1);
    const id = s.pages[0].id;
    s = D.rotatePages(s, [id], 90);
    s = D.rotatePages(s, [id], 90);
    expect(s.pages[0].rotate).toBe(180);
    s = D.rotatePages(s, [id], 180);
    expect(s.pages[0].rotate).toBe(0);
    s = D.rotatePages(s, [id], -90);
    expect(s.pages[0].rotate).toBe(270);
  });

  it("keeps skipped pages in the model but out of the export set", () => {
    let s = stateWithPages(3);
    s = D.setPageSkipped(s, [s.pages[1].id], true);
    expect(s.pages).toHaveLength(3);
    expect(D.exportablePages(s)).toHaveLength(2);
  });
});

describe("PDF model — page labels", () => {
  it("renders roman and alphabetic numbering", () => {
    expect(D.toRoman(4)).toBe("iv");
    expect(D.toRoman(1987, true)).toBe("MCMLXXXVII");
    expect(D.toAlpha(1)).toBe("a");
    expect(D.toAlpha(26)).toBe("z");
    expect(D.toAlpha(27)).toBe("aa");
    expect(D.toAlpha(27, true)).toBe("AA");
  });

  it("labels a range with a prefix and a starting number", () => {
    let s = stateWithPages(4);
    s = D.labelPages(s, [s.pages[1].id, s.pages[2].id], "roman", "Annexe-", 1);
    expect(s.pages.map((p) => p.label)).toEqual([undefined, "Annexe-i", "Annexe-ii", undefined]);
    expect(D.pageLabel(s, 0)).toBe("1");
    expect(D.pageLabel(s, 1)).toBe("Annexe-i");
  });
});

describe("PDF model — annotations", () => {
  it("derives the bounding box from the quads of text markup", () => {
    const s = D.addAnnot(
      emptyState(),
      annot({
        kind: "highlight",
        rect: { x: 0, y: 0, w: 0, h: 0 },
        quads: [
          [
            { x: 10, y: 10 },
            { x: 60, y: 10 },
            { x: 60, y: 24 },
            { x: 10, y: 24 },
          ],
        ],
      }),
    );
    expect(s.annots[0].rect).toEqual({ x: 10, y: 10, w: 50, h: 14 });
  });

  it("pads the ink bounding box by the stroke width so the line is not clipped", () => {
    const s = D.addAnnot(
      emptyState(),
      annot({
        kind: "ink",
        strokeWidth: 4,
        paths: [
          [
            { x: 20, y: 20 },
            { x: 60, y: 50 },
          ],
        ],
      }),
    );
    expect(s.annots[0].rect).toEqual({ x: 16, y: 16, w: 48, h: 38 });
  });

  it("moves every piece of geometry together", () => {
    let s = D.addAnnot(
      emptyState(),
      annot({
        id: "a1",
        kind: "polygon",
        paths: [
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        ],
      }),
    );
    s = D.moveAnnots(s, ["a1"], 5, -3);
    expect(s.annots[0].paths![0][2]).toEqual({ x: 15, y: 7 });
    expect(s.annots[0].rect.x).toBe(5);
  });

  it("scales inner geometry when the bounding box is resized", () => {
    let s = D.addAnnot(
      emptyState(),
      annot({
        id: "a1",
        kind: "polyline",
        rect: { x: 0, y: 0, w: 999, h: 999 },
        paths: [
          [
            { x: 0, y: 0 },
            { x: 50, y: 100 },
          ],
        ],
      }),
    );
    // The box is derived from the path, not from whatever was passed in.
    expect(s.annots[0].rect).toEqual({ x: 0, y: 0, w: 50, h: 100 });
    s = D.resizeAnnot(s, "a1", { x: 0, y: 0, w: 100, h: 50 });
    expect(s.annots[0].paths![0][1]).toEqual({ x: 100, y: 50 });
  });

  it("never moves or deletes a locked annotation", () => {
    let s = D.addAnnot(emptyState(), annot({ id: "a1", locked: true }));
    s = D.moveAnnots(s, ["a1"], 40, 40);
    expect(s.annots[0].rect.x).toBe(10);
    s = D.removeAnnots(s, ["a1"]);
    expect(s.annots).toHaveLength(1);
  });

  it("reorders the z-stack", () => {
    let s = emptyState();
    s = D.addAnnot(s, annot({ id: "a" }));
    s = D.addAnnot(s, annot({ id: "b" }));
    s = D.addAnnot(s, annot({ id: "c" }));
    expect(D.reorderAnnot(s, "a", "front").annots.map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(D.reorderAnnot(s, "c", "back").annots.map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(D.reorderAnnot(s, "a", "forward").annots.map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("records a review action as a reply so the thread keeps its history", () => {
    let s = D.addAnnot(emptyState(), annot({ id: "a1" }));
    s = D.setStatus(s, ["a1"], "accepted", "Alice", "2026-02-02T09:00:00.000Z");
    expect(s.annots[0].status).toBe("accepted");
    expect(s.annots[0].replies).toHaveLength(1);
    expect(s.annots[0].replies![0].author).toBe("Alice");
  });
});

describe("PDF model — content edits", () => {
  const edit = (over: Partial<Parameters<typeof D.upsertContentEdit>[1]> = {}) => ({
    id: "e1",
    pageId: "p1",
    blockKey: "B0",
    original: "Ancien",
    text: "Nouveau",
    rect: { x: 0, y: 0, w: 100, h: 20 },
    fontSize: 11,
    leading: 13,
    align: "left" as const,
    ...over,
  });

  it("stores an edit and replaces it on a second pass", () => {
    let s = D.upsertContentEdit(emptyState(), edit());
    expect(s.contentEdits).toHaveLength(1);
    s = D.upsertContentEdit(s, edit({ text: "Encore autre chose" }));
    expect(s.contentEdits).toHaveLength(1);
    expect(s.contentEdits[0].text).toBe("Encore autre chose");
  });

  it("drops the edit when the text is restored to the original", () => {
    let s = D.upsertContentEdit(emptyState(), edit());
    s = D.upsertContentEdit(s, edit({ text: "Ancien" }));
    expect(s.contentEdits).toHaveLength(0);
  });

  it("keeps a deletion even though the text is empty", () => {
    const s = D.upsertContentEdit(emptyState(), edit({ text: "", deleted: true }));
    expect(s.contentEdits).toHaveLength(1);
    expect(s.contentEdits[0].deleted).toBe(true);
  });
});

describe("PDF model — bookmarks", () => {
  const tree = [
    { id: "a", title: "A", page: 1, children: [{ id: "a1", title: "A1", page: 2, children: [] }] },
    { id: "b", title: "B", page: 5, children: [] },
  ];

  it("flattens with depth, hiding collapsed children", () => {
    expect(D.flattenBookmarks(tree).map((n) => [n.node.id, n.depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["b", 0],
    ]);
    const closed = [{ ...tree[0], closed: true }, tree[1]];
    expect(D.flattenBookmarks(closed).map((n) => n.node.id)).toEqual(["a", "b"]);
  });

  it("removes a node wherever it sits in the tree", () => {
    expect(D.flattenBookmarks(D.removeBookmark(tree, "a1")).map((n) => n.node.id)).toEqual(["a", "b"]);
  });

  it("inserts under a parent and expands it", () => {
    const next = D.insertBookmark(tree, "b", { id: "b1", title: "B1", page: 6, children: [] });
    expect(D.flattenBookmarks(next).map((n) => n.node.id)).toEqual(["a", "a1", "b", "b1"]);
  });
});

describe("PDF model — form fields", () => {
  it("invents a non-colliding field name", () => {
    let s = D.addField(emptyState(), {
      id: "1",
      pageId: "p",
      name: "nom",
      kind: "text",
      rect: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(D.uniqueFieldName(s, "nom")).toBe("nom_2");
    s = D.addField(s, { id: "2", pageId: "p", name: "nom_2", kind: "text", rect: { x: 0, y: 0, w: 1, h: 1 } });
    expect(D.uniqueFieldName(s, "nom")).toBe("nom_3");
    expect(D.uniqueFieldName(s, "prenom")).toBe("prenom");
  });
});

describe("PDF persistence", () => {
  it("round-trips arbitrary bytes across the base64 chunk boundary", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it("survives JSON and restores the whole editing state", () => {
    let s = stateWithPages(2);
    s = D.addAnnot(
      s,
      annot({
        pageId: s.pages[0].id,
        kind: "highlight",
        quads: [
          [
            { x: 1, y: 2 },
            { x: 3, y: 2 },
            { x: 3, y: 6 },
            { x: 1, y: 6 },
          ],
        ],
      }),
    );
    s = D.upsertContentEdit(s, {
      id: "e1",
      pageId: s.pages[0].id,
      blockKey: "B2",
      original: "Loyer de 24 000 euros",
      text: "Loyer de 30 000 euros",
      rect: { x: 60, y: 120, w: 300, h: 22 },
      fontSize: 11,
      leading: 13,
      align: "left",
    });
    s = { ...s, formValues: { nom: "Dupont", accord: true }, metadata: { title: "Contrat" } };
    const pdf = new TextEncoder().encode("%PDF-1.7\ntest");
    const file = serialize("contrat.pdf", pdf, s);
    const back = deserialize(JSON.parse(JSON.stringify(file)));
    expect(back.name).toBe("contrat.pdf");
    expect(Array.from(back.bytes)).toEqual(Array.from(pdf));
    expect(back.state.pages).toHaveLength(2);
    expect(back.state.annots[0].quads![0][2]).toEqual({ x: 3, y: 6 });
    expect(back.state.formValues).toEqual({ nom: "Dupont", accord: true });
    expect(back.state.metadata.title).toBe("Contrat");
    // Rewritten paragraphs must survive too, or reopening silently loses work.
    expect(back.state.contentEdits).toHaveLength(1);
    expect(back.state.contentEdits[0].text).toBe("Loyer de 30 000 euros");
    expect(back.state.contentEdits[0].blockKey).toBe("B2");
    expect(back.state.contentEdits[0].rect).toEqual({ x: 60, y: 120, w: 300, h: 22 });
  });

  it("fills in fields added after a file was written", () => {
    const back = deserialize({ v: 2, name: "x.pdf", pdf: "", state: { pages: [] } });
    expect(back.state.contentEdits).toEqual([]);
    expect(back.state.watermark.enabled).toBe(false);
    expect(back.state.measureScale.unit).toBe("cm");
  });
});

describe("PDF persistence — migration from the previous module", () => {
  const v1 = {
    v: 1,
    name: "ancien.pdf",
    pdf: bytesToBase64(new TextEncoder().encode("%PDF-1.4\n")),
    pages: [
      { id: "pg-1", from: 0 },
      { id: "pg-2", from: null, rotate: 90 },
    ],
    annos: {
      "pg-1": [
        { id: "a1", type: "highlight", x: 10, y: 20, w: 80, h: 12, color: "#fde047", strokeWidth: 0, fontSize: 16 },
        {
          id: "a2",
          type: "draw",
          x: 0,
          y: 0,
          w: 30,
          h: 30,
          color: "#e11d48",
          strokeWidth: 3,
          fontSize: 16,
          points: [
            { x: 1, y: 1 },
            { x: 20, y: 25 },
          ],
        },
        {
          id: "a3",
          type: "text",
          x: 5,
          y: 5,
          w: 200,
          h: 24,
          color: "#000000",
          strokeWidth: 0,
          fontSize: 14,
          text: "Note",
          bold: true,
        },
      ],
    },
    textEdits: {
      "pg-1": [{ key: "L3", x: 40, y: 100, w: 300, h: 12, fontSize: 11, text: "Corrigé", original: "Erroné" }],
    },
    formValues: { champ: "valeur" },
  };

  it("converts the old flat annotations into the new kinds", () => {
    const back = deserialize(v1);
    const kinds = back.state.annots.map((a) => a.kind);
    expect(kinds).toContain("highlight");
    expect(kinds).toContain("ink");
    expect(kinds).toContain("freetext");
  });

  it("gives a migrated highlight real quads instead of a bare box", () => {
    const back = deserialize(v1);
    const hl = back.state.annots.find((a) => a.kind === "highlight")!;
    expect(hl.quads).toHaveLength(1);
    expect(hl.quads![0][0]).toEqual({ x: 10, y: 20 });
    expect(hl.quads![0][2]).toEqual({ x: 90, y: 32 });
  });

  it("reproduces the old cover-and-redraw text edit as a white mask plus a text box", () => {
    const back = deserialize(v1);
    const mask = back.state.annots.find((a) => a.kind === "whiteout");
    const text = back.state.annots.find((a) => a.kind === "freetext" && a.text === "Corrigé");
    expect(mask).toBeDefined();
    expect(text).toBeDefined();
    expect(mask!.rect.y).toBe(100);
  });

  it("keeps the page order, rotations and form values", () => {
    const back = deserialize(v1);
    expect(back.state.pages.map((p) => p.from)).toEqual([0, null]);
    expect(back.state.pages[1].rotate).toBe(90);
    expect(back.state.formValues).toEqual({ champ: "valeur" });
  });
});
