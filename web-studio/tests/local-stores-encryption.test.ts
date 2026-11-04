import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getDriveDoc, putDriveDoc } from "../src/format/drive-store";
import { getWorkflow, saveWorkflow, type Workflow } from "../src/format/parapheur-store";
import { setVaultPassword, verifyVaultPassword } from "../src/format/vault-store";
import { generateAndStoreRecipientKey, unlockRecipientKey } from "../src/crypto/recipient-key-store";

const password = "test-only vault password";
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

async function raw(dbName: string, store: string, key: string): Promise<Record<string, unknown>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store);
      const req = tx.objectStore(store).get(key);
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

it("Drive : réécrire en mode coffre retire les titres, profil et octets en clair", async () => {
  const input = { id: "drive-g23", title: "Titre confidentiel", profile: "standard", savedAt: "2026-11-04", size: 4, bytes: new Uint8Array([1, 2, 3, 4]) };
  await putDriveDoc(input);
  await putDriveDoc(input, { password });
  const stored = await raw("elium-drive", "docs", input.id);
  expect(stored.vaultProtected).toBe(true);
  for (const field of ["title", "profile", "bytes"]) expect(stored).not.toHaveProperty(field);
  expect(stored.enc).toEqual(expect.any(String));
  expect(stored.encBytes).toEqual(expect.any(String));
  expect(JSON.stringify(stored)).not.toContain(input.title);
  expect(await getDriveDoc(input.id, { password })).toEqual(input);
  await expect(getDriveDoc(input.id, { password: "wrong" })).rejects.toThrow();
});

it("Parapheur : les signataires disparaissent du stockage brut lorsque le coffre est activé", async () => {
  const wf: Workflow = { docKey: "g23-parapheur", createdAt: "2026-11-04", parties: [{ id: "p", name: "Signataire confidentiel", role: "Validateur", status: "pending" }] };
  await saveWorkflow(wf);
  await saveWorkflow(wf, { password });
  const stored = await raw("elium-parapheur", "workflows", wf.docKey);
  expect(stored).not.toHaveProperty("parties");
  expect(stored.enc).toEqual(expect.any(String));
  expect(JSON.stringify(stored)).not.toContain(wf.parties[0].name);
  expect(await getWorkflow(wf.docKey, { password })).toEqual(wf);
  await expect(getWorkflow(wf.docKey, { password: "wrong" })).rejects.toThrow();
});

it("Coffre : seul le vérificateur chiffré est persistant, mauvais secret refusé", async () => {
  await setVaultPassword(password);
  const stored = await raw("elium-vault", "config", "config");
  expect(Object.keys(stored).sort()).toEqual(["id", "verifier"]);
  expect(JSON.stringify(stored)).not.toContain(password);
  expect(JSON.stringify(stored)).not.toContain("elium-vault-v1");
  expect(await verifyVaultPassword(password)).toBe(true);
  expect(await verifyVaultPassword("wrong")).toBe(false);
});

it("Clé destinataire : localStorage ne contient pas le scalaire privé", async () => {
  const pub = await generateAndStoreRecipientKey(password);
  const unlocked = await unlockRecipientKey(password);
  const stored = localStorage.getItem("elium_recipient_key")!;
  expect(JSON.parse(stored)).toMatchObject({ ...pub, enc: expect.any(String) });
  expect(stored).not.toContain(unlocked.privateHex);
  expect(stored).not.toContain(password);
  await expect(unlockRecipientKey("wrong")).rejects.toThrow();
});
