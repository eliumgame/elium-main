// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import { fromFdfComments, toFdfComments } from "../src/pdf/ops/fdfcomments";
import type { RawAnnotation } from "../src/pdf/ops/import-annots";
import * as D from "../src/pdf/model/doc";
import { DEFAULT_MEASURE_SCALE, emptyState, type Annot, type Page } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/** Comments as FDF: Acrobat's native comment file, both ways. */

async function readAnnotations(pdf: Uint8Array): Promise<RawAnnotation[][]> {
  const task = pdfjsLib.getDocument({ data: pdf.slice(), isEvalSupported: false });
  const doc = await task.promise;
  const out: RawAnnotation[][] = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getAnnotations()) as RawAnnotation[]);
  await task.destroy();
  return out;
}

const pages: Page[] = [
  { id: "p1", from: 0 },
  { id: "p2", from: 1 },
];
const boxes = new Map([
  ["p1", { w: 600, h: 800, ox: 20, oy: 30 }],
  ["p2", { w: 600, h: 800 }],
]);

const mk = (over: Partial<Annot>): Annot =>
  ({
    id: "x",
    pageId: "p1",
    kind: "square",
    rect: { x: 40, y: 50, w: 120, h: 60 },
    color: "#cc0000",
    opacity: 1,
    strokeWidth: 2,
    author: "Alice",
    createdAt: "2026-03-01T08:00:00.000Z",
    modifiedAt: "2026-03-01T08:00:00.000Z",
    replies: [],
    ...over,
  }) as Annot;

describe("FDF comments", () => {
  it("round-trips comments, threads and states, on the right pages and places", async () => {
    let s = {
      ...emptyState(),
      pages,
      annots: [
        mk({ id: "a", contents: "Carré" }),
        mk({
          id: "b",
          pageId: "p2",
          kind: "freetext",
          text: "Bonjour",
          color: "#0000cc",
          textBg: "#ffff00",
          fontSize: 14,
        }),
        mk({ id: "c", pageId: "p2", kind: "note", text: "Note", icon: "Help", rect: { x: 300, y: 300, w: 20, h: 20 } }),
      ],
    };
    s = D.addReply(s, "a", { author: "Bob", text: "Vu", createdAt: "2026-03-02T08:00:00.000Z" });
    s = D.setStatus(s, ["a"], "accepted", "Bob", "2026-03-03T08:00:00.000Z");
    const fdf = await toFdfComments(s.annots, pages, boxes, "rapport.pdf", {
      author: "Moi",
      measureScale: DEFAULT_MEASURE_SCALE,
    });
    const head = new TextDecoder("latin1").decode(fdf.subarray(0, 8));
    expect(head).toBe("%FDF-1.2");
    const body = new TextDecoder("latin1").decode(fdf);
    expect(body).toContain("/FDF");
    expect(body).toContain("(rapport.pdf)");
    expect(body).not.toContain("/Type /Pages");

    const back = await fromFdfComments(fdf, pages, boxes, "Moi", readAnnotations);
    const by = Object.fromEntries(back.map((a) => [a.kind, a]));
    expect(back.map((a) => [a.pageId, a.kind]).sort()).toEqual([
      ["p1", "square"],
      ["p2", "freetext"],
      ["p2", "note"],
    ]);
    const round = (r: Annot["rect"]) => Object.values(r).map((v) => Math.round(v));
    expect(round(by.square.rect)).toEqual([40, 50, 120, 60]);
    expect(by.square.contents).toBe("Carré");
    expect(by.square.status).toBe("accepted");
    expect(by.square.replies?.map((r) => r.text)).toEqual(["Vu", "a accepté"]);
    expect(by.freetext).toMatchObject({ text: "Bonjour", color: "#0000cc", textBg: "#ffff00", fontSize: 14 });
    expect(by.note).toMatchObject({ icon: "Help" });
    // Fresh ids (never « 12R »), the source's name kept to recognise them.
    expect(back.every((a) => !/^\d+R/.test(a.id))).toBe(true);
    expect(by.square.pdf?.nm).toBe("a");
  });

  it("ignores a file that is not an FDF", async () => {
    expect(await fromFdfComments(new TextEncoder().encode("%PDF-1.7\n"), pages, boxes, "Moi", readAnnotations)).toEqual(
      [],
    );
  });
});
