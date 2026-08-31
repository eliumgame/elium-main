import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  slideToY,
  yToSlide,
  ensureElementsY,
  elToY,
  ensureYText,
  syncYText,
} from "../src/drive-cloud/collab-slides-crdt";
import type { Slide } from "../src/slides/model";

type YMap = Y.Map<unknown>;

/** Seed a Y.Doc with a `deck` map containing one slide, returning the slide Y.Map. */
function seedDoc(doc: Y.Doc, slide: Slide): YMap {
  const deckMap = doc.getMap("deck");
  doc.transact(() => {
    const arr = new Y.Array<YMap>();
    arr.push([slideToY(slide)]);
    deckMap.set("slides", arr);
  });
  return (deckMap.get("slides") as Y.Array<YMap>).get(0);
}
const slideAt0 = (doc: Y.Doc): YMap => (doc.getMap("deck").get("slides") as Y.Array<YMap>).get(0);
const elementsY = (m: YMap): Y.Array<YMap> => m.get("elements") as Y.Array<YMap>;

describe("collab slides CRDT (de)serialization", () => {
  it("round-trips free-canvas elements faithfully", () => {
    const slide: Slide = {
      id: "s1",
      title: "T",
      body: "",
      bodyHtml: "",
      layout: "blank",
      elements: [
        {
          id: "e1",
          type: "text",
          x: 10,
          y: 20,
          w: 30,
          h: 15,
          rotation: 15,
          opacity: 0.8,
          html: "<p>Salut</p>",
          fontSize: 28,
          color: "#111827",
          align: "center",
          valign: "middle",
        },
        {
          id: "e2",
          type: "shape",
          x: 40,
          y: 40,
          w: 20,
          h: 20,
          shape: "star",
          fill: "#ff0000",
          stroke: "#0000ff",
          strokeWidth: 2,
        },
        { id: "e3", type: "image", x: 5, y: 5, w: 25, h: 25, src: "data:image/png;base64,AAAA" },
      ],
    };
    const doc = new Y.Doc();
    const m = seedDoc(doc, slide);
    const back = yToSlide(m);
    expect(back.elements).toEqual(slide.elements);
  });

  it("migrates a legacy (elements-less) slide via elementsOf on read", () => {
    // Build an old-room slide Y.Map WITHOUT an `elements` array.
    const doc = new Y.Doc();
    const deckMap = doc.getMap("deck");
    const m = new Y.Map() as YMap;
    doc.transact(() => {
      m.set("id", "s2");
      m.set("title", "Titre");
      m.set("body", "");
      m.set("bodyHtml", "<p>corps</p>");
      m.set("layout", "title-content");
      m.set("shapes", new Y.Array());
      const arr = new Y.Array<YMap>();
      arr.push([m]);
      deckMap.set("slides", arr);
    });
    const back = yToSlide(m);
    expect(back.elements && back.elements.length).toBeGreaterThanOrEqual(2);
    const texts = (back.elements ?? []).filter((e) => e.type === "text");
    expect(texts.some((e) => (e.html ?? "").includes("Titre"))).toBe(true);
    expect(texts.some((e) => (e.html ?? "").includes("corps"))).toBe(true);
  });

  it("ensureElementsY seeds + persists the migration on first edit", () => {
    const doc = new Y.Doc();
    const deckMap = doc.getMap("deck");
    const m = new Y.Map() as YMap;
    doc.transact(() => {
      m.set("id", "s3");
      m.set("title", "Section");
      m.set("body", "");
      m.set("bodyHtml", "");
      m.set("layout", "section");
      const arr = new Y.Array<YMap>();
      arr.push([m]);
      deckMap.set("slides", arr);
    });
    expect(m.get("elements")).toBeUndefined();
    doc.transact(() => {
      ensureElementsY(m).push([elToY({ id: "new", type: "text", x: 1, y: 1, w: 10, h: 10, html: "<p>+</p>" })]);
    });
    const arr = elementsY(m);
    expect(arr).toBeInstanceOf(Y.Array);
    // seeded (title) + the freshly added element
    expect(arr.length).toBeGreaterThanOrEqual(2);
    expect(arr.toArray().some((em) => em.get("id") === "new")).toBe(true);
  });

  it("merges two peers editing DIFFERENT elements without conflict (per-element LWW)", () => {
    const slide: Slide = {
      id: "s1",
      title: "",
      body: "",
      bodyHtml: "",
      layout: "blank",
      elements: [
        { id: "e1", type: "shape", x: 10, y: 10, w: 20, h: 20, shape: "rect" },
        { id: "e2", type: "shape", x: 60, y: 60, w: 20, h: 20, shape: "ellipse" },
      ],
    };
    const A = new Y.Doc();
    seedDoc(A, slide);
    const B = new Y.Doc();
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A)); // B starts from A's state

    const findEl = (doc: Y.Doc, id: string) =>
      elementsY(slideAt0(doc))
        .toArray()
        .find((em) => em.get("id") === id)!;
    // Concurrent edits: A moves e1, B moves e2 — no exchange yet.
    A.transact(() => findEl(A, "e1").set("x", 42));
    B.transact(() => findEl(B, "e2").set("x", 88));

    // Exchange updates both ways.
    const ua = Y.encodeStateAsUpdate(A),
      ub = Y.encodeStateAsUpdate(B);
    Y.applyUpdate(A, ub);
    Y.applyUpdate(B, ua);

    for (const doc of [A, B]) {
      const s = yToSlide(slideAt0(doc));
      const e1 = s.elements!.find((e) => e.id === "e1")!;
      const e2 = s.elements!.find((e) => e.id === "e2")!;
      expect(e1.x).toBe(42); // A's edit survived on both
      expect(e2.x).toBe(88); // B's edit survived on both
    }
  });

  it("merges two peers typing in the SAME text element character-by-character (not LWW)", () => {
    const slide: Slide = {
      id: "s1",
      title: "",
      body: "",
      bodyHtml: "",
      layout: "blank",
      elements: [{ id: "e1", type: "text", x: 10, y: 10, w: 40, h: 20, html: "Hello world" }],
    };
    const A = new Y.Doc();
    seedDoc(A, slide);
    const B = new Y.Doc();
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
    const htmlY = (doc: Y.Doc) => elementsY(slideAt0(doc)).toArray()[0]!.get("html") as Y.Text;

    // Concurrent, non-overlapping edits: A inserts "dear " mid-string, B appends "!".
    A.transact(() => syncYText(htmlY(A), "Hello dear world"));
    B.transact(() => syncYText(htmlY(B), "Hello world!"));
    Y.applyUpdate(A, Y.encodeStateAsUpdate(B));
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));

    // Both survive on both peers (whole-field LWW would have lost one).
    for (const doc of [A, B]) {
      expect(yToSlide(slideAt0(doc)).elements![0]!.html).toBe("Hello dear world!");
    }
  });

  it("merges concurrent edits to a slide title (Y.Text field)", () => {
    const slide: Slide = { id: "s1", title: "Rapport", body: "", bodyHtml: "", layout: "title" };
    const A = new Y.Doc();
    seedDoc(A, slide);
    const B = new Y.Doc();
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
    const titleY = (doc: Y.Doc) => ensureYText(slideAt0(doc), "title");

    A.transact(() => syncYText(titleY(A), "Mon Rapport")); // prepend "Mon "
    B.transact(() => syncYText(titleY(B), "Rapport final")); // append " final"
    Y.applyUpdate(A, Y.encodeStateAsUpdate(B));
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));

    for (const doc of [A, B]) {
      expect(yToSlide(slideAt0(doc)).title).toBe("Mon Rapport final");
    }
  });

  it("merges two peers editing DIFFERENT fields of the SAME element", () => {
    const slide: Slide = {
      id: "s1",
      title: "",
      body: "",
      bodyHtml: "",
      layout: "blank",
      elements: [{ id: "e1", type: "shape", x: 10, y: 10, w: 20, h: 20, shape: "rect", fill: "#fff" }],
    };
    const A = new Y.Doc();
    seedDoc(A, slide);
    const B = new Y.Doc();
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
    const el = (doc: Y.Doc) => elementsY(slideAt0(doc)).toArray()[0]!;
    A.transact(() => el(A).set("x", 30)); // A moves it
    B.transact(() => el(B).set("fill", "#f00")); // B recolors it
    Y.applyUpdate(A, Y.encodeStateAsUpdate(B));
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
    for (const doc of [A, B]) {
      const e = yToSlide(slideAt0(doc)).elements![0]!;
      expect(e.x).toBe(30);
      expect(e.fill).toBe("#f00");
    }
  });
});

describe("collab deck undo/redo (Y.UndoManager scoped to the deck map)", () => {
  it("undoes/redoes a local element edit", () => {
    const slide: Slide = {
      id: "s1",
      title: "",
      body: "",
      bodyHtml: "",
      layout: "blank",
      elements: [{ id: "e1", type: "shape", x: 10, y: 10, w: 20, h: 20, shape: "rect" }],
    };
    const doc = new Y.Doc();
    const m = seedDoc(doc, slide);
    const deckMap = doc.getMap("deck");
    const undoMgr = new Y.UndoManager(deckMap);

    doc.transact(() => elementsY(m).toArray()[0]!.set("x", 99));
    expect(yToSlide(m).elements![0]!.x).toBe(99);
    expect(undoMgr.canUndo()).toBe(true);

    undoMgr.undo();
    expect(yToSlide(m).elements![0]!.x).toBe(10);
    expect(undoMgr.canUndo()).toBe(false);
    expect(undoMgr.canRedo()).toBe(true);

    undoMgr.redo();
    expect(yToSlide(m).elements![0]!.x).toBe(99);
  });

  it("never undoes an update applied under the 'remote' transaction origin", () => {
    const slide: Slide = {
      id: "s1",
      title: "",
      body: "",
      bodyHtml: "",
      layout: "blank",
      elements: [{ id: "e1", type: "shape", x: 10, y: 10, w: 20, h: 20, shape: "rect" }],
    };
    const A = new Y.Doc();
    const mA = seedDoc(A, slide);
    const undoMgr = new Y.UndoManager(A.getMap("deck"));

    // A peer applies a remote change the way EncryptedYjsProvider does
    // (Y.applyUpdate(doc, update, "remote")): a second doc edits the element,
    // and the resulting update is applied to A under the "remote" origin.
    const B = new Y.Doc();
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
    const mB = slideAt0(B);
    B.transact(() => elementsY(mB).toArray()[0]!.set("x", 77));
    Y.applyUpdate(A, Y.encodeStateAsUpdate(B), "remote");

    expect(yToSlide(mA).elements![0]!.x).toBe(77);
    // Nothing tracked (the only change on A came in under "remote"), so
    // there is no local history to undo.
    expect(undoMgr.canUndo()).toBe(false);
  });
});
