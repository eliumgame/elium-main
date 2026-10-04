import { describe, it, expect } from "vitest";
import { duplicateEliumBytes, sniffEliumKind } from "../src/workspace/content";
import { createEliumFile } from "../src/format/document";
import { readEliumPackage, writeEliumPackage } from "../src/format/elium-package";
import type { ProseMirrorNode } from "../src/format/types";

const para = (t: string): ProseMirrorNode => ({ type: "paragraph", content: [{ type: "text", text: t }] });

describe("duplication d'un .elium de la bibliothèque", () => {
  it("garde le contenu, change l'identifiant interne et le titre", async () => {
    const f = await createEliumFile({ title: "Original", profile: "standard", doc: { type: "doc", content: [para("Bonjour")] } });
    const bytes = await writeEliumPackage(f, {});
    const copy = await duplicateEliumBytes(bytes, "nouvel-id", "Copie de Original");
    const back = (await readEliumPackage(copy, {})).file;
    expect(back.manifest.docId).toBe("nouvel-id");
    expect(back.manifest.docId).not.toBe(f.manifest.docId);
    expect(back.manifest.title).toBe("Copie de Original");
    expect(JSON.stringify(back.document.doc)).toContain("Bonjour");
    // L'original n'est pas modifié.
    const orig = (await readEliumPackage(bytes, {})).file;
    expect(orig.manifest.title).toBe("Original");
  });

  it("explique comment copier un document chiffré au lieu d'échouer en silence", async () => {
    const f = await createEliumFile({ title: "Secret", profile: "encrypted", doc: { type: "doc", content: [para("x")] } });
    const bytes = await writeEliumPackage(f, { password: "pw-test" });
    await expect(duplicateEliumBytes(bytes, "id", "Copie")).rejects.toThrow(/Enregistrer sous/);
  });
});

describe("type d'un .elium d'après son contenu", () => {
  it("détecte un classeur exporté, un document ordinaire, et retombe sur « document » si illisible", async () => {
    const sheet = await createEliumFile({
      title: "Classeur",
      profile: "standard",
      doc: { type: "doc", content: [{ type: "eliumSheet", attrs: { data: "{}" } }] },
    });
    expect(await sniffEliumKind(await writeEliumPackage(sheet, {}))).toBe("sheet");
    const doc = await createEliumFile({ title: "Doc", profile: "standard", doc: { type: "doc", content: [para("a")] } });
    expect(await sniffEliumKind(await writeEliumPackage(doc, {}))).toBe("doc");
    expect(await sniffEliumKind(new Uint8Array([1, 2, 3]))).toBe("doc");
  });
});
