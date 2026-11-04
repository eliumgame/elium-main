import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDF_RECOVERY_SPEC } from "../src/format/db-specs";
import { openMigrated } from "../src/format/idb-migrate";
import { migratePdfRecoveryRecords, reencryptPdfRecovery } from "../src/workspace/pdf-recovery-vault";
import type { PdfDraft, PdfSourceRecord } from "../src/pdf/model/recovery";
import type { VaultSecret } from "../src/crypto/local-vault";

const SECRET: VaultSecret = { password: "pdf-vault-pw" };
const OTHER: VaultSecret = { password: "autre-mot-de-passe" };
const BYTES = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);
const STATE = { marker: "etat-du-brouillon" } as never;
const draft = (): PdfDraft =>
  ({ id: "d1", name: "a.pdf", updatedAt: "2026-10-01T00:00:00Z", size: 7, protected: false, state: STATE }) as PdfDraft;
const source = (): PdfSourceRecord => ({ id: "d1", protected: false, bytes: BYTES });

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("migratePdfRecoveryRecords", () => {
  it("scelle brouillons et sources, puis les rend en clair (aller-retour)", async () => {
    const sealed = await migratePdfRecoveryRecords([draft()], [source()], undefined, SECRET);
    expect(sealed.drafts[0]).toMatchObject({ id: "d1", protected: true });
    expect(sealed.drafts[0].state).toBeUndefined();
    expect(sealed.drafts[0].sealed).toBeTruthy();
    expect(sealed.sources[0]).toMatchObject({ id: "d1", protected: true });
    expect(sealed.sources[0].bytes).toBeUndefined();

    const clear = await migratePdfRecoveryRecords(sealed.drafts, sealed.sources, SECRET, undefined);
    expect(clear.drafts[0]).toMatchObject({ protected: false, state: STATE });
    expect(clear.sources[0].bytes).toEqual(BYTES);
  }, 60000);

  it("échoue avec un mauvais secret", async () => {
    const sealed = await migratePdfRecoveryRecords([draft()], [source()], undefined, SECRET);
    await expect(migratePdfRecoveryRecords(sealed.drafts, sealed.sources, OTHER, undefined)).rejects.toBeTruthy();
  }, 60000);

  it("copie source déclarée mais illisible : erreur explicite", async () => {
    const d = { ...draft(), source: undefined, sourceEnc: "illisible" } as PdfDraft;
    await expect(migratePdfRecoveryRecords([d], [], undefined, SECRET)).rejects.toBeTruthy();
  }, 60000);
});

describe("reencryptPdfRecovery (IndexedDB)", () => {
  async function seed() {
    const db = await openMigrated(PDF_RECOVERY_SPEC);
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(["drafts", "sources"], "readwrite");
      tx.objectStore("drafts").put(draft());
      tx.objectStore("sources").put(source());
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }
  async function dump() {
    const db = await openMigrated(PDF_RECOVERY_SPEC);
    try {
      return await new Promise<{ d: PdfDraft[]; s: PdfSourceRecord[] }>((res, rej) => {
        const tx = db.transaction(["drafts", "sources"], "readonly");
        const d = tx.objectStore("drafts").getAll();
        const s = tx.objectStore("sources").getAll();
        tx.oncomplete = () => res({ d: d.result, s: s.result });
        tx.onerror = () => rej(tx.error);
      });
    } finally {
      db.close();
    }
  }

  it("scelle puis déscelle les deux magasins", async () => {
    await seed();
    await reencryptPdfRecovery(undefined, SECRET);
    let { d, s } = await dump();
    expect(d[0]).toMatchObject({ protected: true });
    expect(d[0].state).toBeUndefined();
    expect(s[0]).toMatchObject({ protected: true });
    await reencryptPdfRecovery(SECRET, undefined);
    ({ d, s } = await dump());
    expect(d[0]).toMatchObject({ protected: false, state: STATE });
    expect(s[0].bytes).toEqual(BYTES);
  }, 60000);

  it("mauvais secret : rien n'est écrit, les deux magasins restent intacts", async () => {
    await seed();
    await reencryptPdfRecovery(undefined, SECRET);
    const before = await dump();
    await expect(reencryptPdfRecovery(OTHER, undefined)).rejects.toBeTruthy();
    const after = await dump();
    expect(after.d[0].sealed).toEqual(before.d[0].sealed);
    expect(after.s[0].sealed).toEqual(before.s[0].sealed);
    expect(after.d[0].protected).toBe(true);
  }, 60000);
});
