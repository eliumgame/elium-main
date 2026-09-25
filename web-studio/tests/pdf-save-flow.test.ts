/**
 * The pure parts of the save flow: when a full rewrite is required, how
 * recovery drafts are stored (never in clear for a protected PDF), and the
 * destination helpers.
 */
import { describe, it, expect } from "vitest";
import { fullRewriteReasons } from "../src/pdf/ops/save";
import { buildPdfDraft, resolvePdfDraft, hasEdits, sourceKey } from "../src/pdf/model/recovery";
import { downloadDestination, pdfName } from "../src/pdf/core/destination";
import * as D from "../src/pdf/model/doc";
import { emptyState, type Annot, type PdfState } from "../src/pdf/model/types";

const base = (): PdfState => ({ ...emptyState(), pages: D.pagesFromSource(3) });
const off = { applyRedactions: true, optimise: false, sanitise: false, flattenForms: false };

function annot(kind: Annot["kind"], pageId: string): Annot {
  return {
    id: `a_${kind}`,
    pageId,
    kind,
    rect: { x: 1, y: 1, w: 10, h: 10 },
    color: "#000000",
    opacity: 1,
    strokeWidth: 1,
    author: "t",
    createdAt: "2026-01-01T00:00:00Z",
    modifiedAt: "2026-01-01T00:00:00Z",
    replies: [],
  } as Annot;
}

describe("fullRewriteReasons", () => {
  it("is empty for comments, form values, rotation and reordering", () => {
    const s = base();
    const st: PdfState = {
      ...s,
      annots: [annot("note", s.pages[0].id)],
      formValues: { a: "b" },
      pages: [s.pages[2], { ...s.pages[0], rotate: 90 }, s.pages[1]],
    };
    expect(fullRewriteReasons(st, off, 3)).toEqual([]);
  });

  it("requires a full rewrite for redaction, removed pages, security, optimisation", () => {
    const s = base();
    expect(fullRewriteReasons({ ...s, annots: [annot("redact", s.pages[0].id)] }, off, 3)[0]).toMatch(/caviardage/);
    expect(
      fullRewriteReasons({ ...s, annots: [annot("redact", s.pages[0].id)] }, { ...off, applyRedactions: false }, 3),
    ).toEqual([]);
    expect(fullRewriteReasons({ ...s, pages: s.pages.slice(0, 2) }, off, 3)[0]).toMatch(/1 page\(s\) supprimée/);
    expect(
      fullRewriteReasons({ ...s, pages: s.pages.map((p, i) => (i === 1 ? { ...p, skipped: true } : p)) }, off, 3)[0],
    ).toMatch(/supprimée/);
    expect(fullRewriteReasons(s, off, 3, "remove")[0]).toMatch(/retrait/);
    expect(fullRewriteReasons(s, off, 3, { protect: { userPassword: "x" } })[0]).toMatch(/nouvelle protection/);
    expect(fullRewriteReasons(s, { ...off, optimise: true }, 3)).toEqual(["optimisation de la taille"]);
  });
});

describe("recovery drafts", () => {
  const state = { ...base(), annots: [annot("note", "p")] };

  it("stores an unprotected source's state in clear", async () => {
    const d = await buildPdfDraft({ id: "k", name: "a.pdf", size: 10, state, sourceProtected: false });
    expect(d?.protected).toBe(false);
    expect(d?.state).toEqual(state);
    expect(await resolvePdfDraft(d!)).toEqual(state);
  });

  it("never stores a protected PDF's edits in clear", async () => {
    expect(await buildPdfDraft({ id: "k", name: "a.pdf", size: 10, state, sourceProtected: true })).toBeNull();
  });

  it("encrypts with the vault secret, and needs it back", async () => {
    const secret = { password: "coffre" };
    const d = await buildPdfDraft({ id: "k", name: "a.pdf", size: 10, state, sourceProtected: true, secret });
    expect(d?.protected).toBe(true);
    expect(d?.state).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("a_note");
    expect(await resolvePdfDraft(d!, secret)).toEqual(state);
    await expect(resolvePdfDraft(d!)).rejects.toThrow(/coffre/);
    await expect(resolvePdfDraft(d!, { password: "faux" })).rejects.toThrow();
  });

  it("recognises edits and keys drafts by the source's SHA-256", async () => {
    expect(hasEdits(base())).toBe(false);
    expect(hasEdits(state)).toBe(true);
    expect(hasEdits({ ...base(), pages: base().pages.slice().reverse() })).toBe(true);
    const k = await sourceKey(new TextEncoder().encode("abc"));
    expect(k).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("destinations", () => {
  it("names files and marks downloads as non-persistent", () => {
    expect(pdfName("rapport")).toBe("rapport.pdf");
    expect(pdfName("Rapport.PDF")).toBe("Rapport.PDF");
    expect(pdfName("  ")).toBe("document.pdf");
    const d = downloadDestination("a.pdf");
    expect(d.kind).toBe("download");
    expect(d.persistent).toBe(false);
  });
});
