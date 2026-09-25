// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { buildPdf } from "../src/pdf/ops/save";
import { buildCommentSummary } from "../src/pdf/ops/summary";
import * as D from "../src/pdf/model/doc";
import { emptyState, type Annot, type PdfState } from "../src/pdf/model/types";
import { KIND_LABEL } from "../src/pdf/ui/state";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/** « Résumer les commentaires »: a PDF of the commented pages, their comments listed and linked. */

async function texts(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push((tc.items as { str: string }[]).map((t) => t.str).join(" "));
  }
  await task.destroy();
  return out;
}

describe("comment summary", () => {
  it("lists the comments of commented pages only, with replies, status and text edits", async () => {
    const src = await PDFDocument.create();
    src.addPage([595, 842]);
    src.addPage([595, 842]);
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(2) };
    const p2 = base.pages[1].id;
    const now = "2026-03-01T08:00:00.000Z";
    const mk = (over: Partial<Annot>): Annot =>
      ({
        pageId: p2,
        color: "#e11d48",
        opacity: 1,
        strokeWidth: 2,
        author: "Marie",
        createdAt: now,
        modifiedAt: now,
        replies: [],
        ...over,
      }) as Annot;
    let s: PdfState = {
      ...base,
      annots: [
        mk({ id: "a", kind: "square", rect: { x: 50, y: 60, w: 100, h: 50 }, contents: "Vérifier ce chiffre — Łódź" }),
        mk({ id: "c", kind: "caret", rect: { x: 300, y: 300, w: 8, h: 8 }, contents: "mensuel", color: "#1d4ed8" }),
        mk({
          id: "s",
          kind: "strikeout",
          group: "c",
          rect: { x: 240, y: 296, w: 60, h: 14 },
          quads: [
            [
              { x: 240, y: 296 },
              { x: 300, y: 296 },
              { x: 300, y: 310 },
              { x: 240, y: 310 },
            ],
          ],
        }),
      ],
    };
    s = D.addReply(s, "a", { author: "Paul", text: "D'accord", createdAt: now });
    s = D.setStatus(s, ["a"], "accepted", "Paul", now);
    const rendered = (await buildPdf(await src.save(), s, { interactiveAnnots: false })).bytes;
    const summary = await buildCommentSummary(rendered, s, { title: "rapport", kindLabel: KIND_LABEL });
    const pages = await texts(summary);
    expect(pages).toHaveLength(1);
    const t = pages[0];
    expect(t).toContain("rapport — page 2");
    expect(t).toContain("Vérifier ce chiffre — Łódź");
    expect(t).toContain("Accepté");
    expect(t).toContain("D'accord");
    expect(t).toContain("Remplacement de texte");
    expect(t).toContain("Remplacer par : « mensuel »");
    // The struck text is not a second entry.
    expect(t.match(/Texte barré/g)).toBeNull();
  });

  it("goes on on another sheet when the list is long", async () => {
    const src = await PDFDocument.create();
    src.addPage([595, 842]);
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const long = "Un commentaire assez long pour occuper plusieurs lignes dans la colonne de droite. ".repeat(4);
    const annots = Array.from({ length: 14 }, (_, i) => ({
      id: `n${i}`,
      pageId: base.pages[0].id,
      kind: "note",
      rect: { x: 40, y: 40 + i * 50, w: 20, h: 20 },
      color: "#ffd400",
      opacity: 1,
      strokeWidth: 0,
      contents: `${i + 1}. ${long}`,
      author: "Marie",
      createdAt: "2026-03-01T08:00:00.000Z",
      modifiedAt: "2026-03-01T08:00:00.000Z",
      replies: [],
    })) as Annot[];
    const s = { ...base, annots };
    const rendered = (await buildPdf(await src.save(), s, { interactiveAnnots: false })).bytes;
    const pages = await texts(await buildCommentSummary(rendered, s, { title: "doc", kindLabel: KIND_LABEL }));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[1]).toContain("page 1 (suite)");
    expect(pages.join(" ")).toContain("14. Un commentaire");
  });

  it("says so when there is nothing to summarise", async () => {
    const src = await PDFDocument.create();
    src.addPage([595, 842]);
    const s: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const rendered = (await buildPdf(await src.save(), s, { interactiveAnnots: false })).bytes;
    const pages = await texts(await buildCommentSummary(rendered, s, { title: "doc", kindLabel: KIND_LABEL }));
    expect(pages[0]).toContain("aucun commentaire");
  });
});
