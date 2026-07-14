import { describe, it, expect } from "vitest";
import { createEliumFile, extractText } from "../src/format/document";
import { readEliumPackage, writeEliumPackage, EliumPasswordRequired } from "../src/format/elium-package";
import type { ProseMirrorNode } from "../src/format/types";

const doc: ProseMirrorNode = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Secret protégé par fichier-clé" }] }],
};

/**
 * "eliumkey": a keyfile can stand in for the password. A document encrypted with
 * a keyfile only (no password) must open with that keyfile alone — and must NOT
 * open without any credential, nor with the wrong keyfile.
 */
describe("keyfile-only (.elium) — pas de mot de passe", () => {
  it("encrypts with a keyfile alone and reopens with it (no password)", async () => {
    const kf = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const file = await createEliumFile({ title: "Confidentiel", profile: "encrypted", doc });
    const bytes = await writeEliumPackage(file, { keyfile: kf });

    const { file: read } = await readEliumPackage(bytes, { keyfile: kf });
    expect(extractText(read.document.doc)).toContain("Secret protégé par fichier-clé");
  });

  it("refuses to open with no credential at all", async () => {
    const kf = new Uint8Array([1, 2, 3, 4]);
    const file = await createEliumFile({ title: "Confidentiel", profile: "encrypted", doc });
    const bytes = await writeEliumPackage(file, { keyfile: kf });
    await expect(readEliumPackage(bytes, {})).rejects.toBeInstanceOf(EliumPasswordRequired);
  });

  it("rejects a wrong keyfile", async () => {
    const file = await createEliumFile({ title: "Confidentiel", profile: "encrypted", doc });
    const bytes = await writeEliumPackage(file, { keyfile: new Uint8Array([1, 1, 1, 1]) });
    await expect(readEliumPackage(bytes, { keyfile: new Uint8Array([2, 2, 2, 2]) })).rejects.toBeTruthy();
  });
});
