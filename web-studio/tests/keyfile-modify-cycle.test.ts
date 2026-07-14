import { describe, it, expect } from "vitest";
import { createEliumFile, extractText } from "../src/format/document";
import { readEliumPackage, writeEliumPackage, EliumPasswordRequired } from "../src/format/elium-package";
import { generateIdentity } from "../src/sign/keys";
import type { ProseMirrorNode } from "../src/format/types";

const docWith = (text: string): ProseMirrorNode => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/**
 * The full "open with keyfile → edit → save with the SAME keyfile" cycle must
 * work end-to-end — including metadata encryption (F-7) and the seal — without
 * ever needing a password. This is the package-level guarantee behind the app's
 * keyfile editing flow.
 */
describe("keyfile modify cycle (no password), with metadata encryption + seal", () => {
  it("opens, edits and re-saves a keyfile-only sealed + metadata-encrypted .elium", async () => {
    const kf = new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12]);
    const id = await generateIdentity();
    const seal = id.privateKeyHex;

    // 1. Create + write (keyfile only, metadata encrypted, sealed).
    let file = await createEliumFile({ title: "Dossier confidentiel", profile: "encrypted", doc: docWith("Version 1") });
    let bytes = await writeEliumPackage(file, { keyfile: kf, encryptMetadata: true, sealPrivateKeyHex: seal });

    // No credential → must refuse (proves it really is encrypted).
    await expect(readEliumPackage(bytes, {})).rejects.toBeInstanceOf(EliumPasswordRequired);

    // 2. Open with the keyfile alone: content AND metadata (title) decrypt.
    let read = await readEliumPackage(bytes, { keyfile: kf });
    expect(extractText(read.file.document.doc)).toContain("Version 1");
    expect(read.file.manifest.title).toBe("Dossier confidentiel"); // metadata decrypted, not "Document chiffré"
    expect(read.seal.verdict === "valid" || read.seal.verdict === "unknown_key").toBe(true);

    // 3. Edit the document in place (as the editor would), keeping the same flags.
    file = { ...read.file, document: { ...read.file.document, doc: docWith("Version 2 modifiée") } };

    // 4. Re-save with the keyfile ALONE (no password) — the modify path.
    bytes = await writeEliumPackage(file, {
      keyfile: kf,
      encryptMetadata: !!file.manifest.protection.metadataEncrypted,
      sealPrivateKeyHex: seal,
    });

    // 5. Re-open with the keyfile: the edit persisted, metadata still decrypts.
    read = await readEliumPackage(bytes, { keyfile: kf });
    expect(extractText(read.file.document.doc)).toContain("Version 2 modifiée");
    expect(read.file.manifest.title).toBe("Dossier confidentiel");
    expect(read.seal.verdict === "valid" || read.seal.verdict === "unknown_key").toBe(true);
  });
});
