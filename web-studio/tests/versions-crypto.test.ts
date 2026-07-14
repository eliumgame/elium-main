import { describe, it, expect } from "vitest";
import { versionDoc } from "../src/format/versions-store";
import { encryptAtRest } from "../src/crypto/local-vault";
import type { ProseMirrorNode } from "../src/format/types";

const doc: ProseMirrorNode = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Contenu confidentiel — accents é è à" }] }],
};

describe("version snapshots — at-rest encryption", () => {
  it("encrypts then decrypts a snapshot round-trip with the password", async () => {
    const enc = await encryptAtRest(doc, { password: "motdepasse" });
    expect(typeof enc).toBe("string");
    expect(enc).not.toContain("confidentiel"); // ciphertext, not plaintext
    const back = await versionDoc({ docKey: "k", label: "v", ts: "t", enc }, { password: "motdepasse" });
    expect(back).toEqual(doc);
  });

  it("a different password fails to decrypt", async () => {
    const enc = await encryptAtRest(doc, { password: "bon" });
    await expect(versionDoc({ docKey: "k", label: "v", ts: "t", enc }, { password: "mauvais" })).rejects.toBeTruthy();
  });

  it("requires a secret for an encrypted version", async () => {
    const enc = await encryptAtRest(doc, { password: "x" });
    await expect(versionDoc({ docKey: "k", label: "v", ts: "t", enc })).rejects.toBeTruthy();
  });

  it("returns the plaintext doc when not encrypted", async () => {
    const back = await versionDoc({ docKey: "k", label: "v", ts: "t", doc });
    expect(back).toEqual(doc);
  });

  it("a keyfile-only secret (empty password) is honoured, not silently treated as no secret", async () => {
    const keyfile = new TextEncoder().encode("ma-cle-de-fichier");
    const enc = await encryptAtRest(doc, { password: "", keyfile });
    // Wrong keyfile must fail even with the same (empty) password.
    await expect(
      versionDoc({ docKey: "k", label: "v", ts: "t", enc }, { password: "", keyfile: new TextEncoder().encode("autre-cle") }),
    ).rejects.toBeTruthy();
    const back = await versionDoc({ docKey: "k", label: "v", ts: "t", enc }, { password: "", keyfile });
    expect(back).toEqual(doc);
  });
});
