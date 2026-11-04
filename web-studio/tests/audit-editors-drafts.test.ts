import { describe, it, expect } from "vitest";
import { buildDraftRecord, resolveDraft, snapshotDraftFile, restoreDraftFile } from "../src/format/drafts-store";
import { createEliumFile } from "../src/format/document";
import { docToDocx } from "../src/format/docx";
import { unzipSync, strFromU8 } from "fflate";
describe("F-08 complete recovery", () => {
  it.each([false, true])("restores the complete file (encrypted=%s)", async (encrypted) => {
    const file = await createEliumFile({ title: "Recovery", profile: encrypted ? "encrypted" : "standard" });
    file.document.styles = [
      { id: "custom", name: "Custom", kind: "paragraph", char: { fontFamily: "Garamond" } },
    ];
    file.document.theme = "ocean";
    file.document.watermark = {
      kind: "text",
      text: "CONFIDENTIEL",
      angle: -35,
      opacity: 0.2,
      color: "#123456",
      sizePt: 48,
    };
    file.document.page.footer = "Saved footer";
    const font = new Uint8Array([0, 1, 2, 3, 250, 255]);
    file.resources.set("font-id", font);
    file.resourceIndex = [{ id: "font-id", name: "Test.ttf", mime: "font/ttf", kind: "font", size: font.length }];
    file.manifest.features.resources = 1;
    file.parapheur = { id: "circuit", parties: [] } as typeof file.parapheur;
    const secret = encrypted ? { password: "draft-test" } : undefined;
    const record = await buildDraftRecord({
      id: "draft-id",
      title: file.manifest.title,
      profile: file.manifest.profile,
      updatedAt: "now",
      doc: file.document.doc,
      page: file.document.page,
      snapshot: snapshotDraftFile(file),
      secret,
    });
    if (encrypted) {
      expect(record.snapshot).toBeUndefined();
      expect(JSON.stringify(record)).not.toContain("CONFIDENTIEL");
    }
    const restored = await restoreDraftFile(record, await resolveDraft(record, secret));
    expect(restored).toEqual({ ...file, manifest: { ...file.manifest, docId: "draft-id" } });
    expect(restored.resources.get("font-id")).toEqual(font);
    const parts = unzipSync(docToDocx(restored));
    expect(
      Object.entries(parts)
        .filter(([name]) => name.endsWith(".xml"))
        .map(([, bytes]) => strFromU8(bytes))
        .join(""),
    ).toContain("CONFIDENTIEL");
  });
  it("restores legacy drafts", async () => {
    const original = await createEliumFile({ title: "Legacy" });
    const restored = await restoreDraftFile(
      { id: "old", title: "Legacy", profile: "standard" },
      { doc: original.document.doc, page: original.document.page },
    );
    expect(restored.document).toEqual(original.document);
    expect(restored.resources.size).toBe(0);
    expect(restored.manifest.docId).toBe("old");
  });
});
