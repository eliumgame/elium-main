import { describe, it, expect } from "vitest";
import { docKeyOf } from "../src/format/doc-key";
import { createEliumFile } from "../src/format/document";

describe("document key (docId → UUID, createdAt fallback)", () => {
  it("prefers docId when present", () => {
    expect(docKeyOf({ docId: "uuid-x", createdAt: "2026-01-01T00:00:00Z" })).toBe("uuid-x");
  });

  it("falls back to createdAt for legacy files without a docId (soft migration)", () => {
    expect(docKeyOf({ createdAt: "2026-01-01T00:00:00Z" })).toBe("2026-01-01T00:00:00Z");
  });

  it("createEliumFile mints a distinct docId per document", async () => {
    const a = await createEliumFile({ title: "A" });
    const b = await createEliumFile({ title: "B" });
    expect(a.manifest.docId).toBeTruthy();
    expect(a.manifest.docId).not.toBe(b.manifest.docId);
  });
});
