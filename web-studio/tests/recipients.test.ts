import { describe, it, expect } from "vitest";
import {
  generateRecipientKeypair,
  encryptForRecipients,
  decryptAsRecipient,
  listRecipientFingerprints,
  recipientFingerprint,
  RECIPIENTS_SCHEMA,
} from "../src/crypto/recipients";
import {
  writeEliumPackage, readEliumPackage, EliumRecipientKeyRequired,
} from "../src/format/elium-package";
import { createEliumFile } from "../src/format/document";
import { unzipSync, strFromU8 } from "fflate";

const te = new TextEncoder();
const td = new TextDecoder();

describe("multi-recipient encryption (TypeScript)", () => {
  it("two recipients each decrypt; an outsider cannot", async () => {
    const a = await generateRecipientKeypair();
    const b = await generateRecipientKeypair();
    const intruder = await generateRecipientKeypair();
    const msg = te.encode("Document ultra confidentiel.");

    const blob = await encryptForRecipients(msg, [a.publicHex, b.publicHex]);
    expect(td.decode(await decryptAsRecipient(blob, a))).toBe("Document ultra confidentiel.");
    expect(td.decode(await decryptAsRecipient(blob, b))).toBe("Document ultra confidentiel.");
    await expect(decryptAsRecipient(blob, intruder)).rejects.toThrow();

    const env = JSON.parse(td.decode(blob));
    expect(env.schema).toBe(RECIPIENTS_SCHEMA);
    expect(env.recipients).toHaveLength(2);
    expect(td.decode(blob)).not.toContain("confidentiel");
    const fprs = listRecipientFingerprints(blob);
    expect(fprs).toContain(await recipientFingerprint(a.publicHex));
  });

  it("rejects a tampered content ciphertext", async () => {
    const a = await generateRecipientKeypair();
    const blob = await encryptForRecipients(te.encode("secret"), [a.publicHex]);
    const env = JSON.parse(td.decode(blob));
    const ct = env.content as string;
    env.content = ct.slice(0, ct.length - 2) + (ct.slice(-2) === "00" ? "01" : "00");
    await expect(decryptAsRecipient(te.encode(JSON.stringify(env)), a)).rejects.toThrow();
  });

  // Cross-language interop: this envelope was produced by the PYTHON core
  // (crypto/recipients.py) for the fixed P-256 recipient key below. If TS can
  // decrypt it, the wire format (points, HKDF, AEAD, AAD) matches byte-for-byte.
  it("decrypts an envelope produced by the Python core", async () => {
    const kp = {
      privateHex: "4f3c2d1e0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d",
      publicHex:
        "0492a65196fc0195a01362d9442c2647ac647bb1191b495640cfd1e2097897fd5d6ac802fa25a84b7fd2ebcae9d6a80830cbcdb2f98f670eb50fb325d6e3875577",
    };
    const B64 =
      "eyJzY2hlbWEiOiJlbGl1bS1yZWNpcGllbnRzLzEiLCJhbGciOiJlY2RoLWVzLXAyNTYrYWVzLTI1Ni1nY20iLCJjb250ZW50Tm9uY2UiOiI2OGI2ODM3ZGIyOTMxYWNkYzAxOGNhOTYiLCJjb250ZW50IjoiNjg1ODUwMjE3YmE0NjViOTRkZGY3ODk4NGNjODY1YTgyZjE0MWUwOWI3YjRiNzk2YjVlOTJjMDJlZjgwYzRlYTJlYmU3ZmE2YTU4YmQ1ZTAyZGQ4YmRhM2Q4YTJkMDc4IiwicmVjaXBpZW50cyI6W3siZnByIjoiM2I3Y2RkMmRkNjA2OGRhNDU2YzhjNjg4NmNkYjljZGI0ODAzMTczNDVmNjAzMTQ3MzI0YTEyMGUzZDk1OGI3OSIsImVwayI6IjA0NDViOWM2NDk2YmY5ODNhNGQyYjgxM2ZmNTNjZGVmYmVhMmZlNTJhYmU3ZDIyMjViNmE3OTY3MTAyYzI4ZmM5ZWY0MGMzZDFkMWIzNjEzOWFlMzFmNDdkMWFjOWEwNDE2YzA0Y2JhNWQ0MjgxY2Q0NDUwZDdiOTNmMTU1ZjZhOTgiLCJub25jZSI6ImI3OGQ1NTViYTliOTUxNGI0NTJjMzlhMSIsIndyYXAiOiJmMzkyYzE3MWNlOTQzNWM0YzNkNTI5ZTAxYjNiNGI5NGNiNWRjZjZjODY5ZDNlZmZlMDQ5YWU3ZDZmYWJlNWM0ODQ0OTViODNhZGM1MjU5YzY1ODg5ZGEyN2FlZGY4OTMifV19";
    const bin = atob(B64);
    const blob = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) blob[i] = bin.charCodeAt(i);

    const out = td.decode(await decryptAsRecipient(blob, kp));
    expect(out).toBe("Interop OK: Python -> TypeScript");
  });
});

describe("multi-recipient .elium package", () => {
  it("encrypts to recipients (no password) and only a recipient can open it", async () => {
    const alice = await generateRecipientKeypair();
    const bob = await generateRecipientKeypair();
    const intruder = await generateRecipientKeypair();

    const file = await createEliumFile({ title: "Note multi-destinataires", profile: "encrypted" });
    const bytes = await writeEliumPackage(file, { recipients: [alice.publicHex, bob.publicHex] });

    // No password was needed; the clear manifest lists recipient fingerprints.
    const manifest = JSON.parse(strFromU8(unzipSync(bytes)["manifest.json"]));
    expect(manifest.protection.recipients).toHaveLength(2);
    expect(manifest.protection.recipients).toContain(await recipientFingerprint(alice.publicHex));

    // Opening requires a recipient key.
    await expect(readEliumPackage(bytes)).rejects.toBeInstanceOf(EliumRecipientKeyRequired);

    const rAlice = await readEliumPackage(bytes, { recipientKey: alice });
    expect(rAlice.file.manifest.title).toBe("Note multi-destinataires");
    const rBob = await readEliumPackage(bytes, { recipientKey: bob });
    expect(rBob.file.manifest.title).toBe("Note multi-destinataires");

    await expect(readEliumPackage(bytes, { recipientKey: intruder })).rejects.toThrow();
  });

  it("combines with metadata encryption (F-7): nothing leaks in the clear", async () => {
    const alice = await generateRecipientKeypair();
    const file = await createEliumFile({ title: "Secret destinataires", profile: "secure_max" });
    const bytes = await writeEliumPackage(file, { recipients: [alice.publicHex], encryptMetadata: true });

    const clear =
      strFromU8(unzipSync(bytes)["manifest.json"]) + strFromU8(unzipSync(bytes)["signatures/signatures.json"]);
    expect(clear).not.toContain("Secret destinataires");

    const r = await readEliumPackage(bytes, { recipientKey: alice });
    expect(r.file.manifest.title).toBe("Secret destinataires");
  });
});

// Local counterpart of the cloud "revocation → key rotation" hardening: on the
// local .elium format there is no server, so revocation == re-saving the file
// for a reduced recipient set. Because every encrypt draws a FRESH CEK
// (recipients.ts:119), the re-saved package is sealed under a brand-new key and
// a removed recipient can no longer open it. These lock that semantics in.
describe("rotation de clé à la révocation (local, .elium)", () => {
  it("primitive : un destinataire retiré ne peut plus déchiffrer la nouvelle enveloppe", async () => {
    const alice = await generateRecipientKeypair();
    const bob = await generateRecipientKeypair();
    const msg = te.encode("Contenu sensible à faire tourner.");

    const before = await encryptForRecipients(msg, [alice.publicHex, bob.publicHex]);
    expect(td.decode(await decryptAsRecipient(before, alice))).toBe("Contenu sensible à faire tourner.");
    expect(td.decode(await decryptAsRecipient(before, bob))).toBe("Contenu sensible à faire tourner.");

    // Rotation: re-encrypt the SAME payload for Alice only (Bob revoked).
    const after = await encryptForRecipients(msg, [alice.publicHex]);
    expect(td.decode(await decryptAsRecipient(after, alice))).toBe("Contenu sensible à faire tourner.");
    await expect(decryptAsRecipient(after, bob)).rejects.toThrow();

    // Fresh CEK: the content ciphertext must differ, and Bob's fingerprint is gone.
    const envBefore = JSON.parse(td.decode(before));
    const envAfter = JSON.parse(td.decode(after));
    expect(envAfter.content).not.toBe(envBefore.content);
    const fprsAfter = listRecipientFingerprints(after);
    expect(fprsAfter).not.toContain(await recipientFingerprint(bob.publicHex));
    expect(fprsAfter).toContain(await recipientFingerprint(alice.publicHex));
  });

  it("paquet .elium : re-sauvegarder sans un destinataire le prive du nouveau fichier", async () => {
    const alice = await generateRecipientKeypair();
    const bob = await generateRecipientKeypair();

    const file = await createEliumFile({ title: "Dossier à révoquer", profile: "encrypted" });
    const shared = await writeEliumPackage(file, { recipients: [alice.publicHex, bob.publicHex] });
    // Both can open the original package.
    expect((await readEliumPackage(shared, { recipientKey: alice })).file.manifest.title).toBe("Dossier à révoquer");
    const opened = await readEliumPackage(shared, { recipientKey: bob });
    expect(opened.file.manifest.title).toBe("Dossier à révoquer");

    // Revoke Bob: re-save the reopened document for Alice only (fresh CEK).
    const rotated = await writeEliumPackage(opened.file, { recipients: [alice.publicHex] });
    const manifest = JSON.parse(strFromU8(unzipSync(rotated)["manifest.json"]));
    expect(manifest.protection.recipients).toHaveLength(1);
    expect(manifest.protection.recipients).not.toContain(await recipientFingerprint(bob.publicHex));

    // Alice still opens the rotated file; Bob cannot.
    expect((await readEliumPackage(rotated, { recipientKey: alice })).file.manifest.title).toBe("Dossier à révoquer");
    await expect(readEliumPackage(rotated, { recipientKey: bob })).rejects.toThrow();
  });
});
