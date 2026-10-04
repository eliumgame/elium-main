import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import {
  buildKeyBundle,
  parseKeyBundle,
  openKeyBundle,
  parseAnyKeyFile,
  bundleFileName,
  type BundleKey,
} from "../src/crypto/keyfile-v2";
import { generateIdentity } from "../src/sign/keys";
import { generateRecipientKeypair, recipientFingerprint } from "../src/crypto/recipients";
import { buildKeyFile, encryptPrivateKey, EliumKeyFileError } from "../src/sign/identity-store";
import { createSuccession, verifySuccession } from "../src/sign/succession";
import { fromHex, toHex } from "../src/format/canonical";

async function sampleKeys(): Promise<{ keys: BundleKey[]; ed: Awaited<ReturnType<typeof generateIdentity>> }> {
  const ed = await generateIdentity();
  const p = await generateRecipientKeypair();
  const pfp = await recipientFingerprint(p.publicHex);
  return {
    ed,
    keys: [
      {
        meta: {
          kid: ed.fingerprint.slice(0, 16),
          type: "identity-ed25519",
          suite: "ed25519/1",
          label: "Identité principale",
          createdAt: "2026-10-01T10:00:00.000Z",
          status: "active",
          publicHex: ed.publicKeyHex,
          fingerprint: ed.fingerprint,
        },
        privateHex: ed.privateKeyHex!,
      },
      {
        meta: {
          kid: pfp.slice(0, 16),
          type: "recipient-p256",
          suite: "p256-ecdh-es/1",
          label: "Réception — éè ✓",
          createdAt: "2026-10-01T10:01:00.000Z",
          expiresAt: "2028-10-01T10:01:00.000Z",
          status: "retired",
          publicHex: p.publicHex,
          fingerprint: pfp,
        },
        privateHex: p.privateHex,
      },
    ],
  };
}

describe(".eliumkey v2 (TypeScript)", () => {
  it("aller-retour : Ed25519 + P-256 + secret maître", async () => {
    const { keys } = await sampleKeys();
    const master = new Uint8Array(32).map((_, i) => i * 3);
    const file = await buildKeyBundle(keys, "mdp-solide", master);
    expect(file.version).toBe(2);
    expect(JSON.stringify(file)).not.toContain(keys[0].privateHex);
    const parsed = parseAnyKeyFile(JSON.stringify(file));
    expect(parsed.version).toBe(2);
    const opened = await openKeyBundle(parseKeyBundle(JSON.stringify(file)), "mdp-solide");
    expect(opened.keys.map((k) => k.privateHex)).toEqual(keys.map((k) => k.privateHex));
    expect(toHex(opened.master!)).toBe(toHex(master));
  }, 30000);

  it("refuse un mauvais mot de passe", async () => {
    const { keys } = await sampleKeys();
    const file = await buildKeyBundle(keys, "bon");
    await expect(openKeyBundle(file, "mauvais")).rejects.toThrow(EliumKeyFileError);
  }, 30000);

  it("détecte une modification de l'en-tête externe (libellé, statut, expiration)", async () => {
    const { keys } = await sampleKeys();
    const file = await buildKeyBundle(keys, "pw");
    const tampered = structuredClone(file);
    tampered.keys[1].status = "active";
    await expect(openKeyBundle(tampered, "pw")).rejects.toThrow(/modifiée/);
    const t2 = structuredClone(file);
    t2.keys[0].label = "Pirate";
    await expect(openKeyBundle(t2, "pw")).rejects.toThrow(/modifiée/);
  }, 30000);

  it("détecte des kdf/cipher qui mentent par rapport au conteneur", async () => {
    const { keys } = await sampleKeys();
    const file = await buildKeyBundle(keys, "pw");
    const t = structuredClone(file);
    t.kdf = { ...t.kdf, t: 5 };
    await expect(openKeyBundle(t, "pw")).rejects.toThrow(/incohérente/);
  }, 30000);

  it("parseKeyBundle rejette cipher/kdf/suite inconnus ou hors bornes", async () => {
    const { keys } = await sampleKeys();
    const file = await buildKeyBundle(keys, "pw");
    const mut = (f: (o: Record<string, unknown>) => void) => {
      const o = structuredClone(file) as unknown as Record<string, unknown>;
      f(o);
      return JSON.stringify(o);
    };
    expect(() => parseKeyBundle(mut((o) => (o.cipher = "chacha20-poly1305")))).toThrow(EliumKeyFileError);
    expect(() => parseKeyBundle(mut((o) => (o.suite = "elium-keybundle/9")))).toThrow(EliumKeyFileError);
    expect(() => parseKeyBundle(mut((o) => ((o.kdf as Record<string, unknown>).alg = "scrypt")))).toThrow(
      EliumKeyFileError,
    );
    expect(() => parseKeyBundle(mut((o) => ((o.kdf as Record<string, unknown>).m = 10 ** 9)))).toThrow(
      EliumKeyFileError,
    );
    expect(() =>
      parseKeyBundle(mut((o) => ((o.keys as Record<string, unknown>[])[0].suite = "rsa/1"))),
    ).toThrow(EliumKeyFileError);
    expect(() => parseKeyBundle(mut((o) => ((o.keys as Record<string, unknown>[])[0].type = "x")))).toThrow(
      EliumKeyFileError,
    );
    expect(() => parseKeyBundle(mut((o) => (o.keys = [])))).toThrow(EliumKeyFileError);
  }, 30000);

  it("garde un lecteur v1 et ne met aucune empreinte dans le nom de fichier", async () => {
    const id = await generateIdentity();
    const enc = await encryptPrivateKey(id.privateKeyHex!, "pw");
    const v1 = buildKeyFile({ publicKeyHex: id.publicKeyHex, fingerprint: id.fingerprint, enc });
    const parsed = parseAnyKeyFile(JSON.stringify(v1));
    expect(parsed.version).toBe(1);
    expect(bundleFileName(new Date("2026-10-03T00:00:00Z"))).toBe("elium-cles-2026-10-03.eliumkey");
    // Un v1 dont kdf/cipher mentent est refusé.
    expect(() => parseAnyKeyFile(JSON.stringify({ ...v1, kdf: "scrypt" }))).toThrow(EliumKeyFileError);
    expect(() => parseAnyKeyFile(JSON.stringify({ ...v1, cipher: "chacha20-poly1305" }))).toThrow(EliumKeyFileError);
  }, 30000);
});

describe("certificat de succession", () => {
  it("est vérifiable et inviolable", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const cert = await createSuccession({
      oldPrivateKeyHex: a.privateKeyHex!,
      oldPublicKeyHex: a.publicKeyHex,
      newPrivateKeyHex: b.privateKeyHex!,
      newPublicKeyHex: b.publicKeyHex,
    });
    expect(await verifySuccession(cert)).toBe(true);
    const c = await generateIdentity();
    expect(await verifySuccession({ ...cert, newPublicKeyHex: c.publicKeyHex })).toBe(false);
    expect(await verifySuccession({ ...cert, issuedAt: "2020-01-01T00:00:00.000Z" })).toBe(false);
    expect(await verifySuccession({ ...cert, newSig: cert.oldSig })).toBe(false);
    expect(await verifySuccession({ ...cert, oldPublicKeyHex: cert.newPublicKeyHex })).toBe(false);
  });
});

// --- Interop Python -----------------------------------------------------------

const WINDOWS_VENV_PYTHON = join(__dirname, "..", "..", ".venv", "Scripts", "python.exe");
const PYTHON_EXEC = [process.env.PYTHON, existsSync(WINDOWS_VENV_PYTHON) ? WINDOWS_VENV_PYTHON : undefined, "python3", "python"]
  .filter((c): c is string => Boolean(c))
  .find((c) => spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0);
const env = { ...process.env, PYTHONPATH: join(__dirname, "..", "..", "src"), PYTHONIOENCODING: "utf-8" };

const PY_OPEN = [
  "import sys, json",
  "from elium.crypto.keybundle import parse_key_bundle, open_key_bundle",
  "f = parse_key_bundle(sys.stdin.buffer.read().decode('utf-8'))",
  "r = open_key_bundle(f, sys.argv[1])",
  "sys.stdout.buffer.write(json.dumps(r, ensure_ascii=False).encode('utf-8'))",
].join("\n");

const PY_BUILD = [
  "import sys, json",
  "from elium.crypto.keybundle import build_key_bundle",
  "d = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
  "f = build_key_bundle(d['keys'], sys.argv[1], d.get('master'))",
  "sys.stdout.buffer.write(json.dumps(f, ensure_ascii=False).encode('utf-8'))",
].join("\n");

const PY_SUCCESSION = [
  "import sys, json",
  "from elium.crypto.keybundle import create_succession, verify_succession",
  "mode = sys.argv[1]",
  "if mode == 'create':",
  "    out = create_succession(sys.argv[2], sys.argv[3], sys.argv[4])",
  "else:",
  "    out = {'ok': verify_succession(json.loads(sys.stdin.buffer.read().decode('utf-8')))}",
  "sys.stdout.buffer.write(json.dumps(out).encode('utf-8'))",
].join("\n");

describe.skipIf(!PYTHON_EXEC)(".eliumkey v2 — interop Python <-> Web", () => {
  it("Python ouvre un bundle écrit par le Web (métadonnées Unicode incluses)", async () => {
    const { keys } = await sampleKeys();
    const master = new Uint8Array(32).fill(7);
    const file = await buildKeyBundle(keys, "interop-pw", master);
    const out = JSON.parse(
      execFileSync(PYTHON_EXEC!, ["-c", PY_OPEN, "interop-pw"], { input: JSON.stringify(file), env, encoding: "utf-8" }),
    );
    expect(out.keys.map((k: { privateHex: string }) => k.privateHex)).toEqual(keys.map((k) => k.privateHex));
    expect(out.master).toBe(toHex(master));
  }, 60000);

  it("Python rejette un bundle Web dont l'en-tête a été modifié", async () => {
    const { keys } = await sampleKeys();
    const file = await buildKeyBundle(keys, "pw");
    file.keys[0].label = "autre";
    const r = spawnSync(PYTHON_EXEC!, ["-c", PY_OPEN, "pw"], { input: JSON.stringify(file), env, encoding: "utf-8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("modifiée");
  }, 60000);

  it("le Web ouvre un bundle écrit par Python", async () => {
    const { keys } = await sampleKeys();
    const input = JSON.stringify({ keys, master: "ab".repeat(32) });
    const built = execFileSync(PYTHON_EXEC!, ["-c", PY_BUILD, "py-pw"], { input, env, encoding: "utf-8" });
    const opened = await openKeyBundle(parseKeyBundle(built), "py-pw");
    expect(opened.keys.map((k) => k.privateHex)).toEqual(keys.map((k) => k.privateHex));
    expect(toHex(opened.master!)).toBe("ab".repeat(32));
  }, 60000);

  it("succession : le Web vérifie un certificat Python et inversement", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const pyCert = JSON.parse(
      execFileSync(PYTHON_EXEC!, ["-c", PY_SUCCESSION, "create", a.privateKeyHex!, b.privateKeyHex!, "2026-10-03T00:00:00Z"], {
        env,
        encoding: "utf-8",
      }),
    );
    expect(pyCert.oldPublicKeyHex).toBe(a.publicKeyHex);
    expect(await verifySuccession(pyCert)).toBe(true);

    const tsCert = await createSuccession({
      oldPrivateKeyHex: a.privateKeyHex!,
      oldPublicKeyHex: a.publicKeyHex,
      newPrivateKeyHex: b.privateKeyHex!,
      newPublicKeyHex: b.publicKeyHex,
      issuedAt: "2026-10-03T00:00:00Z",
    });
    const verdict = JSON.parse(
      execFileSync(PYTHON_EXEC!, ["-c", PY_SUCCESSION, "verify"], { input: JSON.stringify(tsCert), env, encoding: "utf-8" }),
    );
    expect(verdict.ok).toBe(true);
    // fromHex importé pour garder le test honnête sur la longueur des signatures.
    expect(fromHex(tsCert.oldSig)).toHaveLength(64);
  }, 60000);
});
