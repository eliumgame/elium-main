import { describe, it, expect } from "vitest";
import { batchToCsv, batchToJson, filterSupported, runBatch } from "../src/detector/batch";
import { PdfPasswordRequired } from "../src/detector/ingest/loadFile";
import type { DocumentModel } from "../src/detector/types";

const para = (text: string, i: number) => ({ index: i, text, runs: [{ text }] }) as never;

function model(text: string): DocumentModel {
  return { paragraphs: [para(text, 0)], images: [], metadata: { sourceFormat: "docx", title: text } };
}

describe("analyse par lot", () => {
  it("isole les échecs par fichier et produit un CSV sûr", async () => {
    const files = [new File(["a"], "ok.docx"), new File(["b"], "=cmd.pdf"), new File(["c"], "bad.docx")];
    const rows = await runBatch(files, {
      generatedAt: "2026-01-01T00:00:00Z",
      load: async (f) => {
        if (f.name === "=cmd.pdf") throw new PdfPasswordRequired(false);
        if (f.name === "bad.docx") throw new Error('corrompu ; "x"');
        return model("Un texte simple.");
      },
    });
    expect(rows.map((r) => r.status)).toEqual(["ok", "protege", "erreur"]);
    const csv = batchToCsv(rows);
    expect(csv.startsWith("﻿Fichier;Statut")).toBe(true);
    expect(csv).toContain("'=cmd.pdf"); // pas d'injection de formule
    expect(csv).toContain('"corrompu ; ""x"""');
    const json = JSON.parse(batchToJson(rows, "2026-01-01T00:00:00Z"));
    expect(json.files).toHaveLength(3);
  });

  it("filtre les formats non pris en charge", () => {
    const r = filterSupported([new File([""], "a.PDF"), new File([""], "b.txt"), new File([""], "c.webp")]);
    expect(r.files).toHaveLength(2);
    expect(r.ignored).toBe(1);
  });

  it("s'arrête proprement sur annulation", async () => {
    const ctl = new AbortController();
    const rows = await runBatch([new File([""], "a.docx"), new File([""], "b.docx")], {
      generatedAt: "x",
      signal: ctl.signal,
      load: async () => {
        ctl.abort();
        return model("t");
      },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("annule");
  });
});
