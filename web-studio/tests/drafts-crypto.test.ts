import { describe, it, expect } from "vitest";
import { buildDraftRecord, resolveDraft } from "../src/format/drafts-store";
import type { PageSettings, ProseMirrorNode } from "../src/format/types";

const doc: ProseMirrorNode = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Rapport confidentiel — accents é è à" }] }],
};
const page: PageSettings = { format: "A4", orientation: "portrait", margins: { top: 25, right: 20, bottom: 25, left: 20 } };

describe("drafts-store — buildDraftRecord / resolveDraft", () => {
  it("stores an unprotected draft in clear, with its .docx", async () => {
    const docx = new Uint8Array([1, 2, 3, 4]);
    const rec = await buildDraftRecord({
      id: "doc-1", title: "Sans protection", profile: "standard", updatedAt: "2026-07-02T00:00:00Z",
      doc, page, docx,
    });
    expect(rec.protected).toBe(false);
    expect(rec.doc).toEqual(doc);
    expect(rec.page).toEqual(page);
    expect(rec.docx).toEqual(docx);
    expect(rec.enc).toBeUndefined();
    expect(rec.size).toBe(docx.length);

    const content = await resolveDraft(rec);
    expect(content).toEqual({ doc, page });
  });

  it("encrypts a protected draft's content and never stores a plaintext .docx", async () => {
    const rec = await buildDraftRecord({
      id: "doc-2", title: "Document confidentiel", profile: "encrypted", updatedAt: "2026-07-02T00:00:00Z",
      doc, page, secret: { password: "motdepasse" },
      // no `docx` passed — the caller must not compute one for protected documents
    });
    expect(rec.protected).toBe(true);
    expect(rec.doc).toBeUndefined();
    expect(rec.page).toBeUndefined();
    expect(rec.docx).toBeUndefined();
    expect(typeof rec.enc).toBe("string");
    expect(rec.enc).not.toContain("confidentiel");
    expect(rec.profile).toBe("encrypted"); // preserved so recovery doesn't downgrade protection

    const content = await resolveDraft(rec, { password: "motdepasse" });
    expect(content).toEqual({ doc, page });
  });

  it("a keyfile-only secret (empty password) still encrypts, instead of silently falling back to plaintext", async () => {
    const keyfile = new TextEncoder().encode("fichier-cle");
    const rec = await buildDraftRecord({
      id: "doc-3", title: "Protégé par fichier-clé", profile: "protected", updatedAt: "t",
      doc, page, secret: { password: "", keyfile },
    });
    expect(rec.protected).toBe(true);
    expect(rec.doc).toBeUndefined();
    const content = await resolveDraft(rec, { password: "", keyfile });
    expect(content).toEqual({ doc, page });
  });

  it("resolveDraft rejects the wrong password for a protected draft", async () => {
    const rec = await buildDraftRecord({
      id: "doc-4", title: "x", profile: "encrypted", updatedAt: "t",
      doc, page, secret: { password: "bon" },
    });
    await expect(resolveDraft(rec, { password: "mauvais" })).rejects.toBeTruthy();
  });

  it("resolveDraft refuses to guess when no secret is supplied for a protected draft", async () => {
    const rec = await buildDraftRecord({
      id: "doc-5", title: "x", profile: "encrypted", updatedAt: "t",
      doc, page, secret: { password: "bon" },
    });
    await expect(resolveDraft(rec)).rejects.toBeTruthy();
  });
});
