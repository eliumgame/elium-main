import { describe, it, expect } from "vitest";
import {
  forgetHandle,
  planSave,
  recallHandle,
  rememberHandle,
  setHandleStoreForTests,
  suggestedFileName,
  writeToHandle,
  type FsFileHandle,
  type HandleRecord,
} from "../src/workspace/fs-access";
import type { KvStore } from "../src/workspace/kv";

/** Magasin sans clonage : une poignée réelle est clonable par IndexedDB, pas une poignée factice à méthodes. */
function plainKv(): KvStore<HandleRecord> {
  const m = new Map<string, HandleRecord>();
  return {
    get: async (id) => m.get(id),
    getAll: async () => [...m.values()],
    keys: async () => [...m.keys()],
    put: async (v) => void m.set(v.id, v),
    putMany: async (vs) => vs.forEach((v) => m.set(v.id, v)),
    delete: async (id) => void m.delete(id),
    deleteMany: async (ids) => ids.forEach((i) => m.delete(i)),
    clear: async () => m.clear(),
  };
}

describe("planSave", () => {
  const base = { supported: true, hasHandle: true, permission: "granted" as const, forcePick: false };

  it("repli téléchargement quand l'API fichier n'existe pas", () => {
    expect(planSave({ ...base, supported: false })).toEqual({ kind: "download" });
    expect(planSave({ ...base, supported: false, forcePick: true })).toEqual({ kind: "download" });
  });

  it("écrit en place dans le fichier lié quand la permission est accordée", () => {
    expect(planSave(base)).toEqual({ kind: "write", reason: "linked" });
  });

  it("redemande la permission quand le navigateur l'a retirée (prompt / inconnue)", () => {
    expect(planSave({ ...base, permission: "prompt" })).toEqual({ kind: "request_then_write" });
    expect(planSave({ ...base, permission: "unknown" })).toEqual({ kind: "request_then_write" });
  });

  it("permission refusée ou pas de fichier lié : on demande un emplacement ; « sous… » force toujours le sélecteur", () => {
    expect(planSave({ ...base, permission: "denied" })).toEqual({ kind: "pick" });
    expect(planSave({ ...base, hasHandle: false })).toEqual({ kind: "pick" });
    expect(planSave({ ...base, forcePick: true })).toEqual({ kind: "pick" });
  });
});

describe("nom de fichier proposé", () => {
  it("assainit les caractères interdits et ajoute l'extension une seule fois", () => {
    expect(suggestedFileName("Rapport: T3/2026")).toBe("Rapport T3 2026.elium");
    expect(suggestedFileName("note.elium")).toBe("note.elium");
    expect(suggestedFileName("NOTE.ELIUM")).toBe("NOTE.ELIUM");
    expect(suggestedFileName("")).toBe("document.elium");
    expect(suggestedFileName('a<b>c"d|e?f*')).toBe("a b c d e f.elium");
    expect(suggestedFileName("x".repeat(500)).length).toBeLessThanOrEqual(126);
  });
});

function fakeHandle(name: string, opts: { failWrite?: boolean } = {}) {
  const log: string[] = [];
  const h: FsFileHandle & { log: string[]; written: Blob[] } = {
    kind: "file",
    name,
    log,
    written: [],
    async getFile() {
      return new File([], name);
    },
    async createWritable() {
      return {
        async write(data) {
          if (opts.failWrite) throw new Error("disque plein");
          h.written.push(data as Blob);
          log.push("write");
        },
        async close() {
          log.push("close");
        },
        async abort() {
          log.push("abort");
        },
      };
    },
  };
  return h;
}

describe("poignées conservées", () => {
  it("mémorise, retrouve et oublie une poignée par identifiant de document", async () => {
    setHandleStoreForTests(plainKv());
    const h = fakeHandle("a.elium");
    expect(await recallHandle("doc-1")).toBeUndefined();
    await rememberHandle("doc-1", h);
    expect((await recallHandle("doc-1"))?.name).toBe("a.elium");
    await forgetHandle("doc-1");
    expect(await recallHandle("doc-1")).toBeUndefined();
    setHandleStoreForTests(null);
  });
});

describe("écriture", () => {
  it("écrit puis ferme le flux", async () => {
    const h = fakeHandle("a.elium");
    await writeToHandle(h, new Uint8Array([1, 2, 3]));
    expect(h.log).toEqual(["write", "close"]);
    expect(h.written[0]!.size).toBe(3);
  });

  it("en cas d'échec abandonne le flux (le fichier d'origine reste intact) et remonte l'erreur", async () => {
    const h = fakeHandle("a.elium", { failWrite: true });
    await expect(writeToHandle(h, new Uint8Array([1]))).rejects.toThrow("disque plein");
    expect(h.log).toEqual(["abort"]);
  });
});
