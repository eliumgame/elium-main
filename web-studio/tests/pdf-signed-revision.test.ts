import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { diffRevisions } from "../src/pdf/ops/pades";

async function revisions() {
  const original = await PDFDocument.create();
  original.addPage().drawText("100 EUR");
  const bytes = await original.save();
  return { signed: await PDFDocument.load(bytes), final: await PDFDocument.load(bytes) };
}

describe("signed revision content ownership", () => {
  it("allows scalar metadata updates only in the signed Info dictionary", async () => {
    const { signed, final } = await revisions();
    const info = final.context.lookup(final.context.trailerInfo.Info, PDFDict);
    info.set(PDFName.of("ModDate"), PDFHexString.fromText("D:20261104000000Z"));
    expect(diffRevisions(signed, final)).toEqual([]);
    info.set(PDFName.of("Title"), final.context.register(final.context.obj({ Payload: "not metadata" })));
    expect(diffRevisions(signed, final).some((c) => c.kind === "disallowed")).toBe(true);
  });

  it("accepts an unchanged document", async () => {
    const { signed, final } = await revisions();
    expect(diffRevisions(signed, final)).toEqual([]);
  });
  it("rejects a replacement root even when the page count stays unchanged", async () => {
    const { signed, final } = await revisions();
    final.context.trailerInfo.Root = final.context.register(final.catalog.clone(final.context));
    expect(diffRevisions(signed, final).some((c) => c.kind === "disallowed")).toBe(true);
  });
  it("does not let DSS reclassify modified signed resources as neutral", async () => {
    const { signed, final } = await revisions();
    const resources = final.context.register(final.context.obj({ Font: {} }));
    final.getPages()[0].node.set(PDFName.of("Resources"), resources);
    const bytes = await final.save();
    const before = await PDFDocument.load(bytes);
    const after = await PDFDocument.load(bytes);
    after.context.assign(resources, after.context.obj({ Font: {}, FT: PDFName.of("Tx") }));
    after.catalog.set(PDFName.of("DSS"), after.context.obj({ Certs: [resources] }));
    expect(diffRevisions(before, after).some((c) => c.kind === "disallowed")).toBe(true);
    expect(signed.getPageCount()).toBe(after.getPageCount());
  });
});
