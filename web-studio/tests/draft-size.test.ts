import { describe, expect, it } from "vitest";
import { draftSizeEstimate } from "../src/format/draft-size";
import { buildDraftRecord } from "../src/format/drafts-store";
import type { ProseMirrorNode } from "../src/format/types";

describe("draftSizeEstimate", () => {
  const doc: ProseMirrorNode = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Bonjour" }] },
      { type: "image", attrs: { src: "data:image/png;base64,AAAA" } },
    ],
  };
  it("additionne texte et images sans sérialiser", () => {
    expect(draftSizeEstimate(doc)).toBe(7 + "data:image/png;base64,AAAA".length);
  });
  it("le brouillon utilise la taille estimée, sans .docx", async () => {
    const page = {} as never;
    const rec = await buildDraftRecord({
      id: "a",
      title: "t",
      profile: "standard" as never,
      updatedAt: "2026-01-01",
      doc,
      page,
      size: 1234,
    });
    expect(rec.size).toBe(1234);
    expect(rec.docx).toBeUndefined();
  });
});
