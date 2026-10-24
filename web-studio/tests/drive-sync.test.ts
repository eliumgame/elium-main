import { describe, it, expect } from "vitest";
import { Catalog } from "../src/workspace/catalog";
import { memoryKv } from "../src/workspace/kv";
import type { BackupDeps, ContentIO } from "../src/workspace/backup-io";
import {
  LEGACY_FILE,
  changedItems,
  emptyState,
  itemFileName,
  itemIdFromName,
  markReady,
  probeRemote,
  restoreIncremental,
  syncOnce,
  type RemoteEntry,
  type SyncEnv,
  type SyncRemote,
  type SyncState,
} from "../src/workspace/drive-sync";
import { mergePlan, packRecords, unpackRecords } from "../src/workspace/extras";
import type { ContentStoreId, FolderRecord, ItemRecord, WorkItem } from "../src/workspace/types";

const T = "2026-09-01T10:00:00.000Z";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

function memIO(): ContentIO & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    read: async (item) => map.get(item.id),
    write: async (item, bytes) => void map.set(item.id, bytes),
  };
}

/** Un « Drive » partagé entre plusieurs appareils : dossier + fichiers en mémoire. */
function memoryDrive() {
  const files = new Map<string, { entry: RemoteEntry; bytes: Uint8Array }>();
  let folder: string | null = null;
  let n = 0;
  let clock = 0;
  const stamp = () => `2026-10-01T00:00:${String(clock++).padStart(2, "0")}Z`;
  const remote = (): SyncRemote => ({
    findFolder: async () => folder,
    ensureFolder: async () => (folder ??= "folder-1"),
    list: async () => [...files.values()].map((f) => f.entry),
    upload: async (_f, name, bytes) => {
      const entry = { id: `n${++n}`, name, modifiedAt: stamp() };
      files.set(entry.id, { entry, bytes });
      return entry;
    },
    update: async (id, bytes) => {
      const cur = files.get(id);
      if (!cur) throw new Error("introuvable");
      const entry = { ...cur.entry, modifiedAt: stamp() };
      files.set(id, { entry, bytes });
      return entry;
    },
    rename: async (id, name) => {
      const cur = files.get(id);
      if (cur) cur.entry = { ...cur.entry, name };
    },
    download: async (e) => files.get(e.id)!.bytes,
    findLegacy: async () => [...files.values()].map((f) => f.entry).find((e) => e.name === LEGACY_FILE) ?? null,
  });
  return { files, remote };
}

function device(drive: ReturnType<typeof memoryDrive>) {
  const items = memoryKv<ItemRecord>();
  const folders = memoryKv<FolderRecord>();
  const catalog = new Catalog({ items, folders, getSecret: () => undefined, now: () => T, newId: () => "f-new" });
  const contents: Record<ContentStoreId, ReturnType<typeof memIO>> = {
    drive: memIO(),
    sheets: memIO(),
    slides: memIO(),
    pdfs: memIO(),
  };
  const storage = new Map<string, string>();
  const deps: BackupDeps = {
    catalog,
    contents,
    getSecret: () => undefined,
    storage: { get: (k) => storage.get(k) ?? null, set: (k, v) => void storage.set(k, v) },
    rewriteDoc: async (b, id) => enc(`${dec(b)}#${id}`),
  };
  let state: SyncState = emptyState();
  const dirty = new Set<string>();
  const extraRecords = new Map<string, unknown[]>();
  const pieces = [{ piece: "brouillons", label: "Brouillons", open: async () => ({}) as IDBDatabase, stores: [] }];
  const env: SyncEnv = {
    remote: drive.remote(),
    store: { load: () => structuredClone(state), save: (s) => void (state = structuredClone(s)) },
    deps,
    extras: {
      pieces,
      dump: async () => ({ drafts: extraRecords.get("drafts") ?? [] }),
      apply: async (_p, r) => {
        const list = r.drafts ?? [];
        extraRecords.set("drafts", list);
        return list.length;
      },
      pack: packRecords,
      unpack: unpackRecords,
    },
    dirty: { list: () => [...dirty], clear: (p) => void dirty.delete(p) },
  };
  return { env, catalog, contents, storage, dirty, extraRecords, getState: () => state };
}

const item = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id,
  kind: "doc",
  contentStore: "drive",
  title: `Titre ${id}`,
  size: 3,
  createdAt: T,
  modifiedAt: T,
  folderId: null,
  tags: [],
  starred: false,
  vaultProtected: false,
  ...over,
});

describe("noms de fichiers de sauvegarde", () => {
  it("porte l'identifiant et le retrouve, même avec un titre piégeux", () => {
    const n = itemFileName(item("abc-1", { title: 'Budget [2026] /: "final"' }));
    expect(n).toMatch(/\[abc-1\]\.elium$/);
    expect(itemIdFromName(n)).toBe("abc-1");
    expect(itemIdFromName("_index.json")).toBeNull();
  });
});

describe("sauvegarde incrémentale", () => {
  it("ne pousse rien tant que l'espace n'est pas réconcilié", async () => {
    const d = device(memoryDrive());
    await d.catalog.upsertItems([item("d1")]);
    d.contents.drive.map.set("d1", enc("un"));
    expect(await syncOnce(d.env)).toBeNull();
  });

  it("envoie un fichier par élément, puis seulement ce qui change", async () => {
    const drive = memoryDrive();
    const d = device(drive);
    markReady(d.env);
    await d.catalog.upsertItems([item("d1"), item("s1", { kind: "sheet", contentStore: "sheets" })]);
    d.contents.drive.map.set("d1", enc("un"));
    d.contents.sheets.map.set("s1", enc("{}"));
    const r1 = await syncOnce(d.env);
    expect(r1?.items).toBe(2);
    const names = [...drive.files.values()].map((f) => f.entry.name);
    expect(names.some((n) => n.endsWith("[d1].elium"))).toBe(true);
    expect(names.some((n) => n.endsWith("[s1].classeur.json"))).toBe(true);
    expect(names).toContain("_index.json");
    // Rien n'a changé : plus aucun envoi d'élément.
    expect((await syncOnce(d.env))?.items).toBe(0);
    // Un élément modifié : un seul envoi, nouvelle version du même nœud.
    await d.catalog.upsertItems([item("d1", { modifiedAt: "2026-09-02T10:00:00.000Z", size: 5 })]);
    d.contents.drive.map.set("d1", enc("deux!"));
    const before = drive.files.size;
    expect((await syncOnce(d.env))?.items).toBe(1);
    expect(drive.files.size).toBe(before);
    expect(changedItems((await d.catalog.load()).items, d.getState())).toHaveLength(0);
  });

  it("n'envoie les pièces annexes que quand elles sont signalées modifiées", async () => {
    const drive = memoryDrive();
    const d = device(drive);
    markReady(d.env);
    d.extraRecords.set("drafts", [{ id: "x", updatedAt: T }]);
    d.dirty.add("brouillons");
    expect((await syncOnce(d.env))?.pieces).toBeGreaterThanOrEqual(1);
    expect([...drive.files.values()].some((f) => f.entry.name === "_brouillons.elium-extra")).toBe(true);
    expect(d.dirty.size).toBe(0);
  });

  it("aller-retour : un appareil vierge retrouve tout à l'identique", async () => {
    const drive = memoryDrive();
    const a = device(drive);
    markReady(a.env);
    await a.catalog.putFolder({ id: "f1", parentId: null, name: "Compta", createdAt: T, vaultProtected: false });
    await a.catalog.upsertItems([
      item("d1", { folderId: "f1", starred: true, tags: ["urgent"] }),
      item("p1", { kind: "pdf", contentStore: "pdfs", title: "Facture" }),
      item("x1", { trashedAt: "2026-09-02T00:00:00.000Z" }),
    ]);
    a.contents.drive.map.set("d1", enc("doc-un"));
    a.contents.drive.map.set("x1", enc("corbeille"));
    a.contents.pdfs.map.set("p1", new Uint8Array([37, 80, 68, 70, 0, 255, 128]));
    a.storage.set("elium_theme", "dark");
    a.extraRecords.set("drafts", [{ id: "brouillon-1", title: "Non enregistré", updatedAt: T }]);
    a.dirty.add("brouillons");
    await syncOnce(a.env);

    const b = device(drive); // navigateur vierge, même Drive
    const probe = await probeRemote(b.env);
    expect(probe.kind).toBe("incremental");
    expect(probe.items.map((i) => i.id).sort()).toEqual(["d1", "p1", "x1"]);
    const rep = await restoreIncremental(b.env, probe, "keep_both");
    expect(rep.errors).toEqual([]);
    expect(rep.added).toBe(3);
    expect(rep.extras).toBe(1);
    const restored = await b.catalog.load();
    const d1 = restored.items.find((i) => i.id === "d1")!;
    expect(d1).toMatchObject({ folderId: "f1", starred: true, tags: ["urgent"], title: "Titre d1" });
    expect(restored.items.find((i) => i.id === "x1")?.trashedAt).toBeTruthy();
    expect(restored.folders.map((f) => f.name)).toEqual(["Compta"]);
    expect(dec(b.contents.drive.map.get("d1"))).toBe("doc-un");
    expect(Array.from(b.contents.pdfs.map.get("p1")!)).toEqual([37, 80, 68, 70, 0, 255, 128]);
    expect(b.storage.get("elium_theme")).toBe("dark");
    expect(b.extraRecords.get("drafts")).toEqual([{ id: "brouillon-1", title: "Non enregistré", updatedAt: T }]);
    // Réconcilié, et rien à renvoyer : la restauration n'est pas ré-uploadée.
    expect(b.getState().ready).toBe(true);
    expect((await syncOnce(b.env))?.items).toBe(0);
  });

  it("conflit : « garder les deux » conserve le local et ajoute la copie restaurée", async () => {
    const drive = memoryDrive();
    const a = device(drive);
    markReady(a.env);
    await a.catalog.upsertItems([item("d1")]);
    a.contents.drive.map.set("d1", enc("version-drive"));
    await syncOnce(a.env);
    const b = device(drive);
    await b.catalog.upsertItems([item("d1", { modifiedAt: "2026-09-03T00:00:00.000Z" })]);
    b.contents.drive.map.set("d1", enc("version-locale"));
    const probe = await probeRemote(b.env);
    const rep = await restoreIncremental(b.env, probe, "keep_both");
    expect(rep.copied).toBe(1);
    expect(dec(b.contents.drive.map.get("d1"))).toBe("version-locale");
    const all = (await b.catalog.load()).items;
    expect(all).toHaveLength(2);
    expect(all.some((i) => i.title.includes("(restauré)"))).toBe(true);
  });

  it("espace local vidé après une sauvegarde : rien n'est poussé, la détection est relancée", async () => {
    const drive = memoryDrive();
    const d = device(drive);
    markReady(d.env);
    await d.catalog.upsertItems([item("d1")]);
    d.contents.drive.map.set("d1", enc("un"));
    await syncOnce(d.env);
    const indexBefore = [...drive.files.values()].find((f) => f.entry.name === "_index.json")!.bytes.length;
    const empty = device(drive);
    empty.env.store.save(d.getState()); // même état que l'ancien appareil, mais catalogue vide (données effacées)
    expect(await syncOnce(empty.env)).toBeNull();
    expect(empty.getState().ready).toBe(false);
    expect([...drive.files.values()].find((f) => f.entry.name === "_index.json")!.bytes.length).toBe(indexBefore);
  });

  it("détecte une ancienne archive monolithique", async () => {
    const drive = memoryDrive();
    const a = device(drive);
    await a.env.remote.upload("racine", LEGACY_FILE, enc("zip"));
    expect((await probeRemote(a.env)).kind).toBe("legacy");
  });

  it("rien dans le Drive : kind none", async () => {
    expect((await probeRemote(device(memoryDrive()).env)).kind).toBe("none");
  });
});

describe("pièces annexes : encodage et fusion", () => {
  it("aller-retour binaire sans perte (Uint8Array, Blob, imbriqués)", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const out = await unpackRecords(
      await packRecords({
        fonts: [{ name: "Marianne", bytes, nested: { list: [bytes, "x"] } }],
        passport: [{ id: "main", data: { a: 1 } }],
      }),
    );
    const f = out.fonts![0] as { name: string; bytes: Uint8Array; nested: { list: [Uint8Array, string] } };
    expect(f.name).toBe("Marianne");
    expect(Array.from(f.bytes)).toEqual([0, 1, 2, 250, 255]);
    expect(Array.from(f.nested.list[0])).toEqual([0, 1, 2, 250, 255]);
    expect(out.passport).toEqual([{ id: "main", data: { a: 1 } }]);
  });

  it("brouillons : le plus récent gagne, les inconnus sont ajoutés", () => {
    const keyOf = (v: unknown) => (v as { id: string }).id;
    const local = [{ id: "a", updatedAt: "2026-01-02" }];
    const remote = [
      { id: "a", updatedAt: "2026-01-01" },
      { id: "b", updatedAt: "2026-01-01" },
    ];
    expect(mergePlan({ name: "drafts", merge: "keyed" }, local, remote, keyOf)).toEqual([remote[1]]);
    expect(
      mergePlan({ name: "drafts", merge: "keyed" }, [], [{ id: "a", updatedAt: "2026-01-03" }], keyOf),
    ).toHaveLength(1);
  });

  it("versions : dédupliquées par document+date, clé auto retirée ; passeport jamais écrasé", () => {
    const keyOf = (v: unknown) => String((v as { id?: number }).id);
    const local = [{ id: 1, docKey: "d", ts: "t1" }];
    const remote = [
      { id: 7, docKey: "d", ts: "t1" },
      { id: 8, docKey: "d", ts: "t2" },
    ];
    expect(mergePlan({ name: "versions", merge: "versions" }, local, remote, keyOf)).toEqual([
      { docKey: "d", ts: "t2" },
    ]);
    expect(
      mergePlan({ name: "passport", merge: "keyed", onlyIfEmpty: true }, [{ id: "main" }], [{ id: "main" }], keyOf),
    ).toEqual([]);
  });
});
