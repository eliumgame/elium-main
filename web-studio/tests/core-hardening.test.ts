import { describe, it, expect } from "vitest";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { createEliumFile } from "../src/format/document";
import { fromHex, sha256Hex } from "../src/format/canonical";
import { writeEliumPackage, readEliumPackage } from "../src/format/elium-package";
import { EliumCryptoEngine } from "../src/crypto/elium-crypto";
import {
  encryptForRecipients,
  decryptAsRecipient,
  generateRecipientKeypair,
  MAX_RECIPIENTS,
} from "../src/crypto/recipients";
import { deriveAccountSecrets } from "../src/drive-cloud/kdf";

describe("CORE-04 cohérence manifeste/profil", () => {
  it("rejette un manifeste incohérent, accepte les fichiers légitimes", async () => {
    const file = await createEliumFile({ title: "x", profile: "standard" });
    const blob = await writeEliumPackage(file);
    const entries = unzipSync(blob);
    const man = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
    const mutations: Array<(m: any) => void> = [
      (m) => (m.profile = "nope"),
      (m) => (m.protection.encrypted = true),
      (m) => (m.protection.locked = true),
      (m) => (m.protection.contentEntry = "content/document.elium"),
      (m) => delete m.protection,
    ];
    for (const mutate of mutations) {
      const m = structuredClone(man);
      mutate(m);
      const bad = zipSync({ ...entries, "manifest.json": strToU8(JSON.stringify(m)) });
      await expect(readEliumPackage(bad)).rejects.toThrow();
    }
    const ok = await readEliumPackage(blob);
    expect(ok.file.manifest.profile).toBe("standard");
  });
});

describe("CORE-06 ressource listée mais absente", () => {
  it("est signalée resourcesTampered", async () => {
    const file = await createEliumFile({ title: "r", profile: "standard" });
    const bytes = new Uint8Array([1, 2, 3]);
    const id = await sha256Hex(bytes);
    file.resourceIndex.push({ id, name: "a.bin", mime: "application/octet-stream", size: 3, kind: "image" });
    file.resources.set(id, bytes);
    const entries = unzipSync(await writeEliumPackage(file));
    delete entries[`resources/${id}`];
    const r = await readEliumPackage(zipSync(entries));
    expect(r.integrity.resourcesTampered).toContain(id);
  });
});

describe("CORE-07 plafond de destinataires", () => {
  it("refuse > MAX_RECIPIENTS à l'écriture et à la lecture", async () => {
    const kp = await generateRecipientKeypair();
    await expect(
      encryptForRecipients(new Uint8Array([1]), Array(MAX_RECIPIENTS + 1).fill(kp.publicHex)),
    ).rejects.toThrow(/Trop de destinataires/);
    const blob = await encryptForRecipients(new Uint8Array([1]), [kp.publicHex]);
    expect(Array.from(await decryptAsRecipient(blob, kp))).toEqual([1]);
    const env = JSON.parse(new TextDecoder().decode(blob));
    env.recipients = Array(MAX_RECIPIENTS + 1).fill(env.recipients[0]);
    await expect(decryptAsRecipient(strToU8(JSON.stringify(env)), kp)).rejects.toThrow(/plus de/);
  });
});

describe("CLIENT-09 fromHex strict", () => {
  it("valide /^[0-9a-fA-F]*$/ et longueur paire", () => {
    expect(Array.from(fromHex("00ffAb"))).toEqual([0, 255, 171]);
    expect(fromHex("").length).toBe(0);
    expect(() => fromHex("abc")).toThrow();
    expect(() => fromHex("zz")).toThrow();
    expect(() => fromHex("0x12")).toThrow();
    expect(() => fromHex("1g")).toThrow();
  });
});

describe("CLIENT-07 bornes Argon2id", () => {
  it("refuse des paramètres serveur hors bornes avant toute dérivation", async () => {
    const salt = "00".repeat(16);
    for (const params of [
      { alg: "argon2id", t: 3, m: 4_000_000, p: 4 },
      { alg: "argon2id", t: 1000, m: 65536, p: 1 },
      { alg: "argon2id", t: 3, m: 65536, p: 999 },
      { alg: "argon2id", t: 3, m: 100, p: 1 },
      { alg: "argon2id", t: 3.5, m: 65536, p: 1 },
      { alg: "scrypt", t: 3, m: 65536, p: 1 },
    ]) {
      await expect(deriveAccountSecrets("pw", salt, params as any)).rejects.toThrow(/KDF|hors bornes/);
    }
    await expect(EliumCryptoEngine.deriveMasterKey("pw", new Uint8Array(16), 3, 999_999_999, 1)).rejects.toThrow(
      /out of bounds/,
    );
  });
});

describe("CORE-10 conteneur malformé", () => {
  it("lève des erreurs propres sur une entrée tronquée", async () => {
    const good = await EliumCryptoEngine.encodeContainer(new Uint8Array([1, 2, 3]), "pw", "a.json");
    for (const cut of [7, 12, 40, good.length - 1]) {
      await expect(EliumCryptoEngine.decodeContainer(good.slice(0, cut), "pw")).rejects.toThrow();
    }
    // longueur de chiffré annoncée démesurée : refusée AVANT Argon2
    const dv = new DataView(good.buffer, good.byteOffset, good.byteLength);
    const hl = dv.getUint32(6, false);
    const bad = good.slice();
    new DataView(bad.buffer).setBigUint64(10 + hl, 10n ** 12n, false);
    await expect(EliumCryptoEngine.decodeContainer(bad, "pw")).rejects.toThrow(/Truncated/);
    expect((await EliumCryptoEngine.decodeContainer(good, "pw")).payload.length).toBe(3);
  });
});
