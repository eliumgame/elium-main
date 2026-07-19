import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { readEliumPackage, writeEliumPackage } from "../src/format/elium-package";
import { createEliumFile, addSignature } from "../src/format/document";
import { verifyJournal } from "../src/format/journal";
import { verifySeal } from "../src/sign/seal";
import { createProof, verifyProof } from "../src/sign/proof";
import { generateIdentity } from "../src/sign/keys";
import type { EliumSignature } from "../src/format/types";

const WINDOWS_VENV_PYTHON = join(__dirname, "..", "..", ".venv", "Scripts", "python.exe");
const PYTHON_CANDIDATES = [
  process.env.PYTHON,
  existsSync(WINDOWS_VENV_PYTHON) ? WINDOWS_VENV_PYTHON : undefined,
  "python3",
  "python",
].filter((c): c is string => Boolean(c));
const PYTHON_EXEC = PYTHON_CANDIDATES.find((c) => spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0);
const HELPER = join(__dirname, "..", "..", "tests", "python", "interop_helper.py");

/** Run the Python interop helper, returning raw stdout bytes. */
function py(args: string[], input: string | Buffer): Buffer {
  return execFileSync(PYTHON_EXEC!, [HELPER, ...args], { input, maxBuffer: 64 * 1024 * 1024 });
}
function pyJson(args: string[], input: string | Buffer): any {
  return JSON.parse(execFileSync(PYTHON_EXEC!, [HELPER, ...args], { input, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }));
}

const PLACEMENT = { page: 1, xPct: 0.3, yPct: 0.7, wPct: 0.3, hPct: 0.1, rotation: 0, z: 0, anchorType: "page" as const };

describe.skipIf(!PYTHON_EXEC)("cross-language interop — seal / journal / proof / metadata", () => {
  it("A. Python seals → Web verifies the seal over the same journal", async () => {
    const id = await generateIdentity();
    const blob = py(["doc-encode-sealed", "tracked", id.privateKeyHex!], "Contenu scellé par Python");
    const { file } = await readEliumPackage(new Uint8Array(blob));

    expect(await verifySeal(file.manifest, file.signatures, file.journal, id.publicKeyHex)).toBe("valid");
    expect((await verifyJournal(file.journal)).valid).toBe(true);
    expect(file.journal.events.map((e) => e.type)).toEqual(["document.created"]);
  });

  it("B. Web seals → Python verifies the seal", async () => {
    const id = await generateIdentity();
    const file = await createEliumFile({ title: "TS sealed", profile: "tracked" });
    const blob = await writeEliumPackage(file, { sealPrivateKeyHex: id.privateKeyHex });

    const out = pyJson(["doc-decode-verify", "-", id.publicKeyHex, "-"], Buffer.from(blob));
    expect(out.seal).toBe("valid");
    expect(out.journalValid).toBe(true);
    expect(out.journalTypes).toEqual(["document.created"]);
  });

  it("C. Python signs (Ed25519 proof) → Web verifies it valid", async () => {
    const signer = await generateIdentity();
    const blob = py(["doc-encode-signed", "signed", signer.privateKeyHex!, "Alice", "-"], "À signer");
    const { file } = await readEliumPackage(new Uint8Array(blob));

    expect(file.signatures).toHaveLength(1);
    expect(await verifyProof(file.signatures[0], file.document, signer.publicKeyHex)).toBe("valid");
    expect(file.journal.events.map((e) => e.type)).toEqual(["document.created", "signature.added"]);
  });

  it("D. Web signs → Python verifies the proof valid", async () => {
    const signer = await generateIdentity();
    const file0 = await createEliumFile({ title: "TS signed", profile: "signed" });
    const proof = await createProof({ signatureId: "sig-1", model: file0.document, signer: { name: "Bob" }, privateKeyHex: signer.privateKeyHex! });
    const sig: EliumSignature = {
      id: "sig-1", kind: "typed", visual: { text: "Bob" }, placement: PLACEMENT,
      signer: { name: "Bob" }, proof, level: "advanced", createdAt: proof.signedAt,
    };
    const file = await addSignature(file0, sig);
    const blob = await writeEliumPackage(file);

    const out = pyJson(["doc-decode-verify", "-", signer.publicKeyHex, "-"], Buffer.from(blob));
    expect(out.signatures[0].verdict).toBe("valid");
    expect(out.journalTypes).toContain("signature.added");
  });

  it("E. Python writes metadata-encrypted (secure_max) → Web decrypts title + journal", async () => {
    const blob = py(["doc-encode-secure", "s3cr3t-pass"], "Corps ultra confidentiel");
    const { file } = await readEliumPackage(new Uint8Array(blob), { password: "s3cr3t-pass" });

    expect(file.manifest.protection.metadataEncrypted).toBe(true);
    expect(file.manifest.title).toBe("titre-secret"); // decrypted from the secure envelope
    expect(file.journal.events.map((e) => e.type)).toEqual(["document.created", "protection.enabled", "document.locked"]);
    expect((await verifyJournal(file.journal)).valid).toBe(true);
  });

  it("F. Web writes metadata-encrypted → Python decrypts title + journal", async () => {
    const file = await createEliumFile({ title: "ts-secret-title", profile: "secure_max" });
    const blob = await writeEliumPackage(file, { password: "pw-xyz", encryptMetadata: true });

    const out = pyJson(["doc-decode-verify", "pw-xyz", "-", "-"], Buffer.from(blob));
    expect(out.title).toBe("ts-secret-title");
    expect(out.journalValid).toBe(true);
    expect(out.journalTypes).toContain("document.created");
  });
});
