import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { resolveAnnotExtrasAsync } from "./pdf-worker-client";

describe("resolveAnnotExtrasAsync", () => {
  it("lit un PDF sans annotation (repli en ligne sous jsdom)", async () => {
    const d = await PDFDocument.create();
    d.addPage();
    const bytes = await d.save();
    const copy = bytes.slice();
    const out = await resolveAnnotExtrasAsync(bytes);
    expect(out.size).toBe(0);
    expect(bytes).toEqual(copy); // les octets de l'appelant restent intacts
  });
});
