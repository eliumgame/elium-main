import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { createEliumFile, extractText } from "../src/format/document";
import { readEliumPackage, writeEliumPackage } from "../src/format/elium-package";
import type { ProseMirrorNode } from "../src/format/types";

// Same Python-resolution pattern as tests/interop.test.ts and tests/interop_v4.test.ts.
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
const hasPython = Boolean(PYTHON_EXEC);

// `tests/python/interop_helper.py`'s existing `doc-encode`/`doc-decode` commands
// don't accept a keyfile argument, and it must not be modified for this fix.
// These small inline scripts call the exact same `write_elium`/`read_elium`
// entry points the helper uses, just with `keyfile=` wired through.
const PY_DECODE_KEYFILE = [
  "import sys, json",
  "from elium.format.package import read_elium",
  "from elium.format.document import extract_text",
  "blob = sys.stdin.buffer.read()",
  "keyfile = bytes.fromhex(sys.argv[1])",
  "result = read_elium(blob, keyfile=keyfile)",
  "out = {",
  "    'title': result['manifest']['title'],",
  "    'profile': result['manifest']['profile'],",
  "    'text': extract_text(result['document']['doc']).strip(),",
  "}",
  // Write raw UTF-8 bytes rather than `print(...)`: on Windows, Python's
  // text-mode stdout encoding defaults to the console codepage (not UTF-8)
  // once stdout is a pipe rather than a real console, which mangles
  // non-ASCII text. Writing to `sys.stdout.buffer` sidesteps that entirely.
  "sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))",
].join("\n");

const PY_ENCODE_KEYFILE = [
  "import sys",
  "from elium.format.document import create_document_model, text_to_doc",
  "from elium.format.package import write_elium",
  "text = sys.stdin.buffer.read().decode('utf-8')",
  "keyfile = bytes.fromhex(sys.argv[1])",
  "model = create_document_model(text_to_doc(text))",
  "blob = write_elium(model, profile='encrypted', title='interop-keyfile', keyfile=keyfile)",
  "sys.stdout.buffer.write(blob)",
].join("\n");

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Cross-language regression test for the keyfile-only credential path: a
 * `.elium` file protected by a keyfile ALONE (empty password, valid keyfile)
 * must be creatable and openable by BOTH the TS app and the Python core —
 * neither side should require a password when a keyfile is present.
 *
 * `web-studio/tests/keyfile.test.ts` already covers the TS-only round-trip;
 * this file covers the cross-language directions that it doesn't.
 */
describe.skipIf(!hasPython)("Keyfile-only .elium — cross-language interop (Python <-> Web)", () => {
  it("Python opens a keyfile-only .elium written by Web", async () => {
    const keyfile = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 42, 42]);
    const text = "Contenu protégé par fichier-clé (Web -> Python)";
    const doc: ProseMirrorNode = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    };
    const file = await createEliumFile({ title: "Keyfile interop W2P", profile: "encrypted", doc });
    const bytes = await writeEliumPackage(file, { keyfile }); // no password at all

    const out = execFileSync(PYTHON_EXEC!, ["-c", PY_DECODE_KEYFILE, hex(keyfile)], {
      input: Buffer.from(bytes),
      encoding: "utf-8",
    });
    const result = JSON.parse(out);

    expect(result.profile).toBe("encrypted");
    expect(result.text).toContain(text);
  });

  it("Web opens a keyfile-only .elium written by Python", async () => {
    const keyfile = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const text = "Contenu protégé par fichier-clé (Python -> Web)";

    const blob = execFileSync(PYTHON_EXEC!, ["-c", PY_ENCODE_KEYFILE, hex(keyfile)], {
      input: text, // no password argument passed at all
    });

    const { file } = await readEliumPackage(new Uint8Array(blob), { keyfile });
    expect(file.manifest.profile).toBe("encrypted");
    expect(file.manifest.protection.encrypted).toBe(true);
    expect(file.manifest.protection.keyfileRequired).toBe(true);
    expect(extractText(file.document.doc)).toContain(text);

    // Still must refuse without the keyfile, and with the wrong one.
    await expect(readEliumPackage(new Uint8Array(blob), {})).rejects.toBeTruthy();
    await expect(readEliumPackage(new Uint8Array(blob), { keyfile: new Uint8Array([9, 9, 9]) })).rejects.toBeTruthy();
  });
});
