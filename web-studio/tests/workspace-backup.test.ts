import { describe, it, expect } from "vitest";
import { strToU8, zipSync } from "fflate";
import { Catalog } from "../src/workspace/catalog";
import { memoryKv } from "../src/workspace/kv";
import {
  BACKUP_EXTENSION,
  BackupFormatError,
  SECRET_KEYS,
  backupFileName,
  contentKey,
  decodeBackup,
  encodeBackup,
  planBackupRestore,
} from "../src/workspace/backup";
import {
  BackupPasswordRequired,
  BackupPasswordWrong,
  VaultLockedError,
  collectSnapshot,
  isPlainBackup,
  openBackup,
  packBackup,
  restoreSnapshot,
  type BackupDeps,
  type ContentIO,
} from "../src/workspace/backup-io";
import type { ContentStoreId, FolderRecord, ItemRecord, WorkItem } from "../src/workspace/types";
import type { VaultSecret } from "../src/crypto/local-vault";

const T = "2026-09-01T10:00:00.000Z";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

function memIO(): ContentIO & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    async read(item) {
      return map.get(item.id);
    },
    async write(item, bytes) {
      map.set(item.id, bytes);
    },
  };
}

function machine(opts: { secret?: VaultSecret; local?: Record<string, string> } = {}) {
  const items = memoryKv<ItemRecord>();
  const folders = memoryKv<FolderRecord>();
  const secretRef = { current: opts.secret };
  const catalog = new Catalog({
    items,
    folders,
    getSecret: () => secretRef.current,
    now: () => T,
    newId: () => "f-new",
  });
  const contents: Record<ContentStoreId, ReturnType<typeof memIO>> = {
    drive: memIO(),
    sheets: memIO(),
    slides: memIO(),
    pdfs: memIO(),
  };
  const store = new Map<string, string>(Object.entries(opts.local ?? {}));
  const deps: BackupDeps = {
    catalog,
    contents,
    getSecret: () => secretRef.current,
    storage: { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) },
    appVersion: "4.9.0",
    now: () => new Date(T),
    rewriteDoc: async (bytes, newId) => enc(`${dec(bytes)}#${newId}`),
  };
  return { catalog, contents, store, deps, secretRef };
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
  tags: ["t"],
  starred: false,
  vaultProtected: false,
  ...over,
});

async function seed(m: ReturnType<typeof machine>) {
  await m.catalog.putFolder({
    id: "f1",
    parentId: null,
    name: "Compta",
    createdAt: T,
    vaultProtected: !!m.secretRef.current,
  });
  await m.catalog.upsertItems([
    item("d1", { folderId: "f1", starred: true }),
    item("s1", { kind: "sheet", contentStore: "sheets", title: "Budget" }),
    item("p1", { kind: "pdf", contentStore: "pdfs", title: "Facture" }),
    item("x1", { trashedAt: "2026-09-02T00:00:00.000Z" }),
  ]);
  m.contents.drive.map.set("d1", enc("doc-un"));
  m.contents.drive.map.set("x1", enc("doc-corbeille"));
  m.contents.sheets.map.set("s1", enc('{"sheets":[]}'));
  m.contents.pdfs.map.set("p1", new Uint8Array([37, 80, 68, 70, 0, 255, 128]));
  m.store.set("elium_prefs", '{"recentCount":12}');
  m.store.set("elium_theme", "dark");
  m.store.set("elium_identity", '{"enc":"SECRET-BLOB"}');
}

describe("sauvegarde : aller-retour complet", () => {
  it("exporte puis restaure dans un espace vide, octet pour octet", async () => {
    const a = machine();
    await seed(a);
    const snap = await collectSnapshot(a.deps, { includeSecrets: false });
    const file = await packBackup(snap, { includeSecrets: false });
    expect(isPlainBackup(file)).toBe(true);

    const { manifest, snapshot } = await openBackup(file);
    expect(manifest.counts).toEqual({ items: 4, folders: 1, trashed: 1 });
    expect(manifest.includesSecrets).toBe(false);

    const b = machine();
    const plan = planBackupRestore([], [], snapshot, "keep_both");
    expect(plan.counts).toMatchObject({ add: 4, conflicts: 0 });
    const report = await restoreSnapshot(b.deps, snapshot, plan, { applySettings: true, applySecrets: false });
    expect(report).toMatchObject({ added: 4, foldersAdded: 1, errors: [] });

    const { items, folders } = await b.catalog.load();
    expect(items.map((i) => i.id).sort()).toEqual(["d1", "p1", "s1", "x1"]);
    expect(folders.map((f) => f.name)).toEqual(["Compta"]);
    const d1 = items.find((i) => i.id === "d1")!;
    expect(d1).toMatchObject({ title: "Titre d1", folderId: "f1", starred: true, tags: ["t"] });
    expect(items.find((i) => i.id === "x1")!.trashedAt).toBeTruthy(); // la corbeille voyage aussi
    expect(dec(b.contents.drive.map.get("d1"))).toBe("doc-un");
    expect(Array.from(b.contents.pdfs.map.get("p1")!)).toEqual([37, 80, 68, 70, 0, 255, 128]);
    expect(b.store.get("elium_theme")).toBe("dark");
    expect(b.store.get("elium_prefs")).toBe('{"recentCount":12}');
  });

  it("n'inclut JAMAIS les secrets sans demande explicite, et les inclut quand on le demande", async () => {
    const a = machine();
    await seed(a);
    const snap = await collectSnapshot(a.deps, { includeSecrets: false });
    const plain = encodeBackup(snap, { includeSecrets: false });
    expect(new TextDecoder("latin1").decode(plain)).not.toContain("SECRET-BLOB");
    const dec1 = decodeBackup(plain);
    expect(dec1.snapshot.secrets).toEqual({});
    expect(dec1.manifest.includesSecrets).toBe(false);

    const withSecrets = await collectSnapshot(a.deps, { includeSecrets: true });
    const file = await packBackup(withSecrets, { includeSecrets: true });
    const back = await openBackup(file);
    expect(back.manifest.includesSecrets).toBe(true);
    expect(back.snapshot.secrets["elium_identity"]).toContain("SECRET-BLOB");
    const b = machine();
    await restoreSnapshot(b.deps, back.snapshot, planBackupRestore([], [], back.snapshot, "skip"), {
      applySettings: false,
      applySecrets: true,
    });
    expect(b.store.get("elium_identity")).toContain("SECRET-BLOB");
    expect(b.store.has("elium_theme")).toBe(false); // réglages non demandés : non appliqués
    expect(SECRET_KEYS).toContain("elium_identity");
  });

  it("chiffrement par mot de passe : illisible sans lui, mauvais mot de passe refusé", async () => {
    const a = machine();
    await seed(a);
    const snap = await collectSnapshot(a.deps, { includeSecrets: false });
    const file = await packBackup(snap, { includeSecrets: false, password: "mot-de-passe-test" });
    expect(isPlainBackup(file)).toBe(false);
    expect(new TextDecoder("latin1").decode(file)).not.toContain("Compta");
    await expect(openBackup(file)).rejects.toBeInstanceOf(BackupPasswordRequired);
    await expect(openBackup(file, "faux")).rejects.toBeInstanceOf(BackupPasswordWrong);
    const ok = await openBackup(file, "mot-de-passe-test");
    expect(ok.snapshot.items).toHaveLength(4);
  }, 30000);

  it("avec le coffre actif : sauvegarde en clair logique (déchiffrée), restauration re-chiffrée sur l'autre machine", async () => {
    const a = machine({ secret: { password: "coffre-a" } });
    await seed(a);
    const snap = await collectSnapshot(a.deps, { includeSecrets: false });
    expect(snap.items.find((i) => i.id === "d1")!.title).toBe("Titre d1"); // titres lisibles dans l'archive
    const file = await packBackup(snap, { includeSecrets: false });
    const b = machine({ secret: { password: "coffre-b" } });
    const { snapshot } = await openBackup(file);
    await restoreSnapshot(b.deps, snapshot, planBackupRestore([], [], snapshot, "keep_both"), {
      applySettings: false,
      applySecrets: false,
    });
    const raw = (
      await (b.catalog as unknown as { deps: { items: ReturnType<typeof memoryKv<ItemRecord>> } }).deps.items.getAll()
    )[0]!;
    expect(raw.vaultProtected).toBe(true);
    expect(raw.title).toBeUndefined(); // chiffré par le coffre de la machine de destination
    expect((await b.catalog.getItem("d1"))!.title).toBe("Titre d1");
  }, 30000);

  it("refuse de sauvegarder tant que le coffre est verrouillé", async () => {
    const a = machine({ secret: { password: "coffre" } });
    await seed(a);
    a.secretRef.current = undefined;
    await expect(collectSnapshot(a.deps, { includeSecrets: false })).rejects.toBeInstanceOf(VaultLockedError);
  }, 30000);
});

describe("restauration : conflits", () => {
  async function conflictWorld() {
    const a = machine();
    await seed(a);
    const snapshot = decodeBackup(
      encodeBackup(await collectSnapshot(a.deps, { includeSecrets: false }), { includeSecrets: false }),
    ).snapshot;
    const b = machine();
    await b.catalog.putFolder({ id: "f1", parentId: null, name: "Dossier local", createdAt: T, vaultProtected: false });
    await b.catalog.upsertItem(item("d1", { title: "Version locale", folderId: "f1" }));
    b.contents.drive.map.set("d1", enc("contenu-local"));
    return { snapshot, b };
  }

  it("ignorer : l'existant n'est pas touché", async () => {
    const { snapshot, b } = await conflictWorld();
    const local = await b.catalog.load();
    const plan = planBackupRestore(local.items, local.folders, snapshot, "skip");
    expect(plan.counts).toMatchObject({ conflicts: 1, skip: 1, add: 3 });
    await restoreSnapshot(b.deps, snapshot, plan, { applySettings: false, applySecrets: false });
    expect(dec(b.contents.drive.map.get("d1"))).toBe("contenu-local");
    expect((await b.catalog.getItem("d1"))!.title).toBe("Version locale");
    expect((await b.catalog.load()).folders.find((f) => f.id === "f1")!.name).toBe("Dossier local"); // dossier existant conservé
  });

  it("remplacer : la sauvegarde l'emporte", async () => {
    const { snapshot, b } = await conflictWorld();
    const local = await b.catalog.load();
    const plan = planBackupRestore(local.items, local.folders, snapshot, "replace");
    const r = await restoreSnapshot(b.deps, snapshot, plan, { applySettings: false, applySecrets: false });
    expect(r.replaced).toBe(1);
    expect(dec(b.contents.drive.map.get("d1"))).toBe("doc-un");
    expect((await b.catalog.getItem("d1"))!.title).toBe("Titre d1");
  });

  it("garder les deux : copie sous un nouvel identifiant et un titre distinct, l'original local intact", async () => {
    const { snapshot, b } = await conflictWorld();
    const local = await b.catalog.load();
    const plan = planBackupRestore(local.items, local.folders, snapshot, "keep_both", new Map(), () => "copie-1");
    const r = await restoreSnapshot(b.deps, snapshot, plan, { applySettings: false, applySecrets: false });
    expect(r.copied).toBe(1);
    expect(dec(b.contents.drive.map.get("d1"))).toBe("contenu-local");
    expect(dec(b.contents.drive.map.get("copie-1"))).toBe("doc-un#copie-1"); // nouvel identifiant interne
    const copy = (await b.catalog.getItem("copie-1"))!;
    expect(copy.title).toBe("Titre d1 (restauré)");
    expect(copy.starred).toBe(false);
  });

  it("choix par élément prioritaire sur le choix par défaut", async () => {
    const { snapshot, b } = await conflictWorld();
    const local = await b.catalog.load();
    const plan = planBackupRestore(local.items, local.folders, snapshot, "skip", new Map([["d1", "replace"]]));
    expect(plan.actions.find((a) => a.item.id === "d1")!.action).toBe("replace");
  });

  it("un élément dont le contenu manque dans l'archive est ignoré sans casser la restauration", () => {
    const plan = planBackupRestore([], [], { items: [item("a")], folders: [], contents: new Map() }, "skip");
    expect(plan.actions[0]).toMatchObject({ action: "skip", reason: "no_content" });
    expect(plan.counts.skip).toBe(1);
  });

  it("une erreur d'écriture sur un élément n'empêche pas les autres", async () => {
    const { snapshot } = await conflictWorld();
    const c = machine();
    const realWrite = c.contents.sheets.write;
    c.contents.sheets.write = async (it, bytes) => {
      if (it.id === "s1") throw new Error("quota dépassé");
      return realWrite(it, bytes);
    };
    const r = await restoreSnapshot(c.deps, snapshot, planBackupRestore([], [], snapshot, "skip"), {
      applySettings: false,
      applySecrets: false,
    });
    expect(r.errors).toEqual([{ title: "Budget", message: "quota dépassé" }]);
    expect(r.added).toBe(3);
  });
});

describe("validation de l'archive", () => {
  it("rejette un fichier qui n'est pas une sauvegarde", () => {
    expect(() => decodeBackup(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(BackupFormatError);
    const notBackup = zipSync({ "manifest.json": strToU8('{"format":"autre"}') });
    expect(() => decodeBackup(notBackup)).toThrow(/pas une sauvegarde/);
  });

  it("rejette une version trop récente avec un message clair", () => {
    const z = zipSync({
      "manifest.json": strToU8('{"format":"elium-workspace","version":99}'),
      "catalog.json": strToU8('{"items":[],"folders":[]}'),
    });
    expect(() => decodeBackup(z)).toThrow(/plus récente/);
  });

  it("ignore les éléments mal formés et les clés de réglages hors liste blanche", () => {
    const z = zipSync({
      "manifest.json": strToU8('{"format":"elium-workspace","version":1,"createdAt":"2026-01-01T00:00:00Z"}'),
      "catalog.json": strToU8(
        JSON.stringify({
          folders: [{ id: "f", name: "ok" }, { name: "sans id" }],
          items: [
            { id: "a", title: "ok", kind: "doc", contentStore: "drive" },
            { id: "b", title: "x", kind: "pirate", contentStore: "drive" },
            42,
          ],
        }),
      ),
      "settings.json": strToU8(
        JSON.stringify({ elium_theme: "dark", elium_identity: "NE DOIT PAS PASSER", autre: "x" }),
      ),
      "content/drive/a": new Uint8Array([1]),
      "content/drive/../../evil": new Uint8Array([2]),
    });
    const { snapshot } = decodeBackup(z);
    expect(snapshot.items.map((i) => i.id)).toEqual(["a"]);
    expect(snapshot.folders.map((f) => f.id)).toEqual(["f"]);
    expect(snapshot.settings).toEqual({ elium_theme: "dark" });
    expect([...snapshot.contents.keys()]).toEqual(["drive/a"]); // pas de traversée de chemin
  });

  it("les identifiants à caractères spéciaux (docId ISO) survivent à l'aller-retour", () => {
    const id = "2026-09-01T10:00:00.000Z";
    const snap = {
      createdAt: T,
      folders: [],
      items: [item(id)],
      contents: new Map([[contentKey("drive", id), enc("x")]]),
      settings: {},
      secrets: {},
    };
    expect(decodeBackup(encodeBackup(snap, { includeSecrets: false })).snapshot.contents.has(`drive/${id}`)).toBe(true);
  });

  it("nom de fichier proposé", () => {
    expect(backupFileName(new Date("2026-10-03T12:00:00Z"))).toBe(`elium-espace-2026-10-03${BACKUP_EXTENSION}`);
  });
});
