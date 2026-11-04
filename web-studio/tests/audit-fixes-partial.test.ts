import { describe, it, expect, beforeEach } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createEliumFile } from "../src/format/document";
import { readEliumPackage, writeEliumPackage } from "../src/format/elium-package";
import type { ProseMirrorNode } from "../src/format/types";
import { checkSealPin } from "../src/sign/seal-pinning";
import type { EliumManifest } from "../src/format/types";
import { Catalog } from "../src/workspace/catalog";
import { memoryKv } from "../src/workspace/kv";
import { collectSnapshot, type BackupDeps, type ContentIO } from "../src/workspace/backup-io";
import { mergeIndex } from "../src/workspace/drive-sync";
import type { ContentStoreId, FolderRecord, ItemRecord, WorkItem } from "../src/workspace/types";

const doc = (text: string): ProseMirrorNode => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("fichier-clé : ancien fichier (manifeste false, en-tête true)", () => {
  it("recale keyfileRequired sur l'en-tête authentifié et impose le fichier-clé au réenregistrement", async () => {
    const kf = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
    const file = await createEliumFile({ title: "Ancien", profile: "encrypted", doc: doc("v1") });
    const bytes = await writeEliumPackage(file, { keyfile: kf });
    // Simule un fichier écrit par une ancienne version : le manifeste dit false.
    const entries = unzipSync(bytes);
    const m = JSON.parse(strFromU8(entries["manifest.json"]!));
    expect(m.protection.keyfileRequired).toBe(true);
    m.protection.keyfileRequired = false;
    const legacy = zipSync({ ...entries, "manifest.json": strToU8(JSON.stringify(m)) });

    const read = await readEliumPackage(legacy, { keyfile: kf });
    expect(read.file.manifest.protection.keyfileRequired).toBe(true);
    // Trousseau verrouillé : seul un mot de passe est fourni -> doit être refusé.
    await expect(writeEliumPackage(read.file, { password: "x" })).rejects.toThrow(/Fichier-clé requis/);
    const again = await writeEliumPackage(read.file, { keyfile: kf });
    expect((await readEliumPackage(again, { keyfile: kf })).file.manifest.protection.keyfileRequired).toBe(true);
  });
});

describe("seal-pinning : localStorage corrompu", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  const manifest = (): EliumManifest =>
    ({
      createdAt: "2026-01-01T00:00:00Z",
      seal: { publicKeyHex: "ab".repeat(32), fingerprint: "fp" },
    }) as unknown as EliumManifest;

  it.each(["null", "42", '"x"', "[]", "{pas du json"])("ne lève pas pour %s", (raw) => {
    store.set("elium_seal_pins", raw);
    expect(checkSealPin(manifest()).status).toBe("new");
  });

  it("ignore les entrées invalides mais garde les valides", () => {
    const m = manifest();
    store.set(
      "elium_seal_pins",
      JSON.stringify({
        "seal:2026-01-01T00:00:00Z": { fingerprint: 3, publicKeyHex: null },
        autre: null,
      }),
    );
    expect(checkSealPin(m).status).toBe("new");
    store.set(
      "elium_seal_pins",
      JSON.stringify({ "seal:2026-01-01T00:00:00Z": { fingerprint: "fp", publicKeyHex: "ab".repeat(32) } }),
    );
    expect(checkSealPin(m).status).toBe("pinned");
  });
});

describe("sauvegarde : miroirs de clés dérivées non exportés", () => {
  const T = "2026-09-01T10:00:00.000Z";
  function deps(storage: Map<string, string>): BackupDeps {
    const io: ContentIO = { read: async () => undefined, write: async () => {} };
    return {
      catalog: new Catalog({
        items: memoryKv<ItemRecord>(),
        folders: memoryKv<FolderRecord>(),
        getSecret: () => undefined,
        now: () => T,
        newId: () => "x",
      }),
      contents: { drive: io, sheets: io, slides: io, pdfs: io } as Record<ContentStoreId, ContentIO>,
      getSecret: () => undefined,
      storage: { get: (k) => storage.get(k) ?? null, set: (k, v) => void storage.set(k, v) },
    };
  }
  it("n'exporte pas un miroir dont enc est vide, mais garde ceux qui portent une clé chiffrée", async () => {
    const s = new Map([
      ["elium_identity", JSON.stringify({ publicKeyHex: "aa", fingerprint: "bb", enc: "" })],
      ["elium_recipient_key", JSON.stringify({ publicHex: "04", fingerprint: "cc", enc: "abcd" })],
      ["elium_trust_book", "[]"],
    ]);
    const snap = await collectSnapshot(deps(s), { includeSecrets: true });
    expect(snap.secrets["elium_identity"]).toBeUndefined();
    expect(snap.secrets["elium_recipient_key"]).toContain("abcd");
    expect(snap.secrets["elium_trust_book"]).toBe("[]");
    expect((await collectSnapshot(deps(s), { includeSecrets: false })).secrets).toEqual({});
  });
});

describe("mergeIndex", () => {
  const T = "2026-09-01T10:00:00.000Z";
  const it_ = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
    id,
    kind: "doc",
    contentStore: "drive",
    title: id,
    size: 1,
    createdAt: T,
    modifiedAt: T,
    folderId: null,
    tags: [],
    starred: false,
    vaultProtected: false,
    ...over,
  });
  const rawItem = (id: string, folderId: string | null = null) => ({
    id,
    kind: "doc",
    contentStore: "drive",
    title: id,
    size: 1,
    createdAt: T,
    modifiedAt: T,
    folderId,
  });
  const fold = (id: string, parentId: string | null = null) => ({ id, name: id, parentId, createdAt: T });

  it("garde l'espace local et ajoute les éléments inconnus d'un autre appareil, avec leurs dossiers", () => {
    const r = mergeIndex([it_("a")], [], [], {
      items: [rawItem("a"), rawItem("b", "f2")],
      folders: [fold("f1"), fold("f2", "f1")],
      deleted: [],
    });
    expect(r.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(r.folders.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
  });

  it("un élément supprimé ici devient pierre tombale et n'est pas réintroduit", () => {
    const r = mergeIndex([], [], ["gone"], { items: [rawItem("gone"), rawItem("keep")], deleted: ["old"] });
    expect(r.items.map((i) => i.id)).toEqual(["keep"]);
    expect(r.deleted.sort()).toEqual(["gone", "old"]);
  });

  it("un élément présent localement l'emporte sur une suppression distante", () => {
    const r = mergeIndex([it_("a")], [], [], { items: [], deleted: ["a", "z"] });
    expect(r.items.map((i) => i.id)).toEqual(["a"]);
    expect(r.deleted).toEqual(["z"]);
  });

  it("ignore un index distant absent ou mal formé et les entrées invalides", () => {
    expect(mergeIndex([it_("a")], [], [], null)).toEqual({ items: [it_("a")], folders: [], deleted: [] });
    const r = mergeIndex([], [], [], {
      items: [null, 3, { id: 1 }, rawItem("ok")],
      folders: "x" as never,
      deleted: [1, "t"],
    });
    expect(r.items.map((i) => i.id)).toEqual(["ok"]);
    expect(r.deleted).toEqual(["t"]);
  });

  it("borne les pierres tombales à 5000 en gardant les plus récentes", () => {
    const many = Array.from({ length: 5200 }, (_, i) => `t${i}`);
    const r = mergeIndex([], [], many, null);
    expect(r.deleted).toHaveLength(5000);
    expect(r.deleted[4999]).toBe("t5199");
  });
});
