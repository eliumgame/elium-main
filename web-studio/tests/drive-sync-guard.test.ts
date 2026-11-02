import { describe, it, expect } from "vitest";
import { Catalog } from "../src/workspace/catalog";
import { memoryKv } from "../src/workspace/kv";
import type { BackupDeps, ContentIO } from "../src/workspace/backup-io";
import {
  SETTINGS_FILE,
  emptyState,
  importTrustFromDrive,
  markReady,
  probeRemote,
  restoreIncremental,
  syncOnce,
  type RemoteEntry,
  type SyncEnv,
  type SyncRemote,
  type SyncState,
} from "../src/workspace/drive-sync";
import { EXTRA_PIECES, packRecords, unpackRecords, type ExtraPiece, type Records } from "../src/workspace/extras";
import {
  backupFolderCandidates,
  backupOrgsKey,
  needsOrgConsent,
  parseBackupOrgs,
  ownedBy,
  sharesArePrivate,
  splitTrustRecords,
  TRUST_SETTINGS_KEYS,
} from "../src/workspace/sync-guard";
import type { ContentStoreId, FolderRecord, ItemRecord, WorkItem } from "../src/workspace/types";

const T = "2026-09-01T10:00:00.000Z";
const enc = (s: string) => new TextEncoder().encode(s);

describe("dossier « Sauvegarde Elium » : seul celui du compte est accepté", () => {
  const f = (id: string, ownerUserId: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "folder",
    name: "Sauvegarde Elium",
    trashedAt: null,
    ownerUserId,
    parentId: null,
    ...over,
  });

  it("écarte un dossier homonyme créé (et partagé) par un autre membre, même plus ancien", () => {
    const roots = [f("mallory", "u-mallory"), f("mien", "u-alice")];
    expect(backupFolderCandidates(roots, "u-alice", "Sauvegarde Elium")).toEqual(["mien"]);
    expect(backupFolderCandidates([f("mallory", "u-mallory")], "u-alice", "Sauvegarde Elium")).toEqual([]);
  });

  it("préfère l'identifiant épinglé ; ignore corbeille, sous-dossier et mauvais nom", () => {
    const roots = [
      f("a", "u"),
      f("b", "u"),
      f("c", "u", { trashedAt: T }),
      f("d", "u", { parentId: "x" }),
      f("e", "u", { name: "Autre" }),
    ];
    expect(backupFolderCandidates(roots, "u", "Sauvegarde Elium", "b")).toEqual(["b", "a"]);
  });

  it("partages : seulement le compte et son organisation", () => {
    const me = { principalType: "user", principalId: "u" };
    const org = { principalType: "org", principalId: "o" };
    expect(sharesArePrivate([me, org], "u", "o")).toBe(true);
    expect(sharesArePrivate([me, { principalType: "user", principalId: "mallory" }], "u", "o")).toBe(false);
    expect(sharesArePrivate([me, { principalType: "group", principalId: "g" }], "u", "o")).toBe(false);
    expect(sharesArePrivate([me, { principalType: "org", principalId: "autre" }], "u", "o")).toBe(false);
  });

  it("fichiers : seuls ceux déposés par le compte", () => {
    expect(
      ownedBy(
        [
          { id: "1", ownerUserId: "u" },
          { id: "2", ownerUserId: "m" },
        ],
        "u",
      ).map((e) => e.id),
    ).toEqual(["1"]);
  });
});

describe("ancres de confiance : jamais restaurées automatiquement", () => {
  it("le magasin des identités PDF approuvées est marqué « confiance » ; racines C2PA listées", () => {
    const marks = EXTRA_PIECES.find((p) => p.piece === "marques-pdf")!;
    expect(marks.stores.find((s) => s.name === "trusted")?.trust).toBe(true);
    expect(marks.stores.find((s) => s.name === "marks")?.trust).toBeFalsy();
    expect(TRUST_SETTINGS_KEYS).toContain("elium.detector.c2paTrust.v1");
    const { kept, trust, trustCount } = splitTrustRecords(marks.stores, { marks: [1], trusted: [2, 3] });
    expect(kept).toEqual({ marks: [1] });
    expect(trust).toEqual({ trusted: [2, 3] });
    expect(trustCount).toBe(2);
  });
});

// --- Moteur : Drive en mémoire + dossier vérifiable -------------------------------------------------

function memIO(): ContentIO & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return { map, read: async (i) => map.get(i.id), write: async (i, b) => void map.set(i.id, b) };
}

function setup() {
  const files = new Map<string, { entry: RemoteEntry; bytes: Uint8Array }>();
  let n = 0;
  let folderOk = true;
  const remote: SyncRemote = {
    findFolder: async () => (folderOk ? "dossier" : null),
    ensureFolder: async () => "dossier",
    checkFolder: async () => folderOk,
    list: async () => [...files.values()].map((f) => f.entry),
    upload: async (_f, name, bytes) => {
      const entry = { id: `n${++n}`, name, modifiedAt: T };
      files.set(entry.id, { entry, bytes });
      return entry;
    },
    update: async (id, bytes) => {
      const cur = files.get(id)!;
      files.set(id, { entry: cur.entry, bytes });
      return cur.entry;
    },
    rename: async () => undefined,
    download: async (e) => files.get(e.id)!.bytes,
    findLegacy: async () => null,
  };
  const catalog = new Catalog({
    items: memoryKv<ItemRecord>(),
    folders: memoryKv<FolderRecord>(),
    getSecret: () => undefined,
    now: () => T,
    newId: () => "f",
  });
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
    rewriteDoc: async (b) => b,
  };
  let state: SyncState = emptyState();
  const applied: Records[] = [];
  const marks: ExtraPiece = {
    piece: "marques-pdf",
    label: "Marques",
    open: async () => ({}) as IDBDatabase,
    stores: [
      { name: "marks", merge: "keyed" },
      { name: "trusted", merge: "keyed", trust: true },
    ],
  };
  const env: SyncEnv = {
    remote,
    store: { load: () => structuredClone(state), save: (s) => void (state = structuredClone(s)) },
    deps,
    extras: {
      pieces: [marks],
      dump: async () => ({}),
      apply: async (_p, r) => {
        applied.push(r);
        return Object.values(r).reduce((a, l) => a + l.length, 0);
      },
      pack: packRecords,
      unpack: unpackRecords,
    },
    dirty: { list: () => [], clear: () => undefined },
  };
  const put = async (name: string, bytes: Uint8Array) => remote.upload("dossier", name, bytes);
  return {
    env,
    catalog,
    contents,
    storage,
    applied,
    put,
    setFolderOk: (v: boolean) => (folderOk = v),
    getState: () => state,
  };
}

const item = (id: string): WorkItem => ({
  id,
  kind: "doc",
  contentStore: "drive",
  title: id,
  size: 3,
  createdAt: T,
  modifiedAt: T,
  folderId: null,
  tags: [],
  starred: false,
  vaultProtected: false,
});

describe("moteur : dossier compromis et ancres de confiance", () => {
  it("dossier devenu invalide (autre propriétaire / partagé) : rien n'est envoyé, l'état est oublié", async () => {
    const s = setup();
    markReady(s.env, "dossier");
    await s.catalog.upsertItems([item("d1")]);
    s.contents.drive.map.set("d1", enc("abc"));
    s.setFolderOk(false);
    expect(await syncOnce(s.env)).toBeNull();
    expect(s.getState()).toEqual(emptyState());
    s.setFolderOk(true);
    markReady(s.env, "dossier");
    expect((await syncOnce(s.env))?.items).toBe(1);
  });

  it("restauration : réglages ordinaires appliqués, racines C2PA et identités approuvées retenues", async () => {
    const s = setup();
    await s.put(SETTINGS_FILE, enc(JSON.stringify({ elium_theme: "dark", "elium.detector.c2paTrust.v1": "[{},{}]" })));
    await s.put("_index.json", enc(JSON.stringify({ items: [], folders: [] })));
    await s.put("_marques-pdf.elium-extra", await packRecords({ marks: [{ id: "m" }], trusted: [{ id: "cert" }] }));
    const probe = await probeRemote(s.env);
    const r = await restoreIncremental(s.env, probe, "keep_both");
    expect(s.storage.get("elium_theme")).toBe("dark");
    expect(s.storage.has("elium.detector.c2paTrust.v1")).toBe(false);
    expect(r.trustHeld).toBe(3);
    expect(s.applied).toEqual([{ marks: [{ id: "m" }] }]);

    // Importation explicite : décompte d'abord (rien n'est écrit), puis application.
    expect(await importTrustFromDrive(s.env, { apply: false })).toEqual({ c2pa: 2, pdf: 1 });
    expect(s.storage.has("elium.detector.c2paTrust.v1")).toBe(false);
    expect(await importTrustFromDrive(s.env, { apply: true })).toEqual({ c2pa: 2, pdf: 1 });
    expect(s.storage.get("elium.detector.c2paTrust.v1")).toBe("[{},{}]");
    expect(s.applied.at(-1)).toEqual({ trusted: [{ id: "cert" }] });
  });
});

describe("seconde organisation : pas de première sauvegarde automatique sans accord", () => {
  it("première organisation acceptée d'office, une autre demande confirmation", () => {
    expect(needsOrgConsent([], "A")).toBe(false);
    expect(needsOrgConsent(["A"], "A")).toBe(false);
    expect(needsOrgConsent(["A"], "B")).toBe(true);
    expect(needsOrgConsent(["A", "B"], "B")).toBe(false);
  });

  it("liste mémorisée par compte, robuste aux valeurs corrompues", () => {
    expect(backupOrgsKey("u1")).toBe("elium_drive_backup_orgs_v1:u1");
    expect(parseBackupOrgs(null)).toEqual([]);
    expect(parseBackupOrgs("{")).toEqual([]);
    expect(parseBackupOrgs("null")).toEqual([]);
    expect(parseBackupOrgs('["A", 3, "B"]')).toEqual(["A", "B"]);
  });
});
