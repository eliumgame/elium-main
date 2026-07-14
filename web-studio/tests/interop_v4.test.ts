import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { readEliumPackage, writeEliumPackage } from "../src/format/elium-package";
import { createEliumFile, extractText } from "../src/format/document";

const WINDOWS_VENV_PYTHON = join(__dirname, "..", "..", ".venv", "Scripts", "python.exe");
const PYTHON_CANDIDATES = [
  process.env.PYTHON,
  existsSync(WINDOWS_VENV_PYTHON) ? WINDOWS_VENV_PYTHON : undefined,
  "python3",
  "python",
].filter((candidate): candidate is string => Boolean(candidate));
const PYTHON_EXEC = PYTHON_CANDIDATES.find(
  (candidate) => spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0,
);
const HELPER = join(__dirname, "..", "..", "tests", "python", "interop_helper.py");
const hasPython = Boolean(PYTHON_EXEC);

// Cross-language tests require the local Python venv; skipped otherwise (e.g. Linux CI).
describe.skipIf(!hasPython)("v4 cross-language interop (Python <-> Web)", () => {
  it("Web reads a standard .elium written by Python", async () => {
    const text = "Bonjour depuis Python — document v4.";
    const blob = execFileSync(PYTHON_EXEC, [HELPER, "doc-encode", "standard", "-"], { input: text });

    const { file, integrity } = await readEliumPackage(new Uint8Array(blob));
    expect(file.manifest.profile).toBe("standard");
    expect(file.manifest.formatVersion).toBe(4);
    expect(extractText(file.document.doc)).toContain(text);
    expect(integrity.contentIntact).toBe(true);
  });

  it("Python reads a standard .elium written by Web", async () => {
    const file = await createEliumFile({
      title: "JS doc",
      profile: "standard",
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Bonjour depuis le Web" }] }] },
    });
    const blob = await writeEliumPackage(file);

    const out = execFileSync(PYTHON_EXEC, [HELPER, "doc-decode", "-"], {
      input: Buffer.from(blob),
      encoding: "utf-8",
    });
    const res = JSON.parse(out);
    expect(res.text).toContain("Bonjour depuis le Web");
    expect(res.integrity.contentIntact).toBe(true);
  });

  it("Web reads an encrypted .elium written by Python", async () => {
    const text = "Contenu chiffré interop";
    const blob = execFileSync(PYTHON_EXEC, [HELPER, "doc-encode", "encrypted", "s3cret-pass"], { input: text });

    const { file } = await readEliumPackage(new Uint8Array(blob), { password: "s3cret-pass" });
    expect(file.manifest.protection.encrypted).toBe(true);
    expect(extractText(file.document.doc)).toContain(text);
  });
});
