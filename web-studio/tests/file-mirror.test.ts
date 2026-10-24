import { describe, it, expect } from "vitest";
import { Catalog } from "../src/workspace/catalog";
import { memoryKv } from "../src/workspace/kv";
import type { ContentIO } from "../src/workspace/backup-io";
import type { ContentStoreId, FolderRecord, ItemRecord, WorkItem } from "../src/workspace/types";
import type { VaultSecret } from "../src/crypto/local-vault";
import { launcherFilesBackend, requestPersistentStorage, type FileBackend } from "../src/storage/persistence";
import {
  CATALOG_PLAIN,
  CATALOG_SEALED,
  FileMirror,
  fileFor,
  openFromDisk,
  safeTitle,
  sealForDisk,
  type MirrorExtra,
  type MirrorStatus,
} from "../src/storage/file-mirror";
import { mergePlan, packRecords, unpackRecords } from "../src/workspace/extras";

const T = "2026-10-01T10:00:00.000Z";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

function memBackend() {
  const files = new Map<string, Uint8Array>();
  const trash: string[] = [];
  let writes = 0;
  const backend: FileBackend = {
    root: "C:\\Documents\\Elium",
    async list() {
      return [...files].map(([p, b]) => ({ p, size: b.length, mtime: 0 }));
    },
    async read(p) {
      return files.get(p);
    },
    async write(p, b) {
      writes++;
      files.set(p, b);
    },
    async remove(p, o) {
      if (files.delete(p) && !o?.hard) trash.push(p);
    },
  };
  return { backend, files, trash, writes: () => writes };
}

function machine(secret?: VaultSecret) {
  const ref = { current: secret };
  const catalog = new Catalog({
    items: memoryKv<ItemRecord>(),
    folders: memoryKv<FolderRecord>(),
    getSecret: () => ref.current,
    now: () => T,
    newId: () => "f-new",
  });
  const maps: Record<ContentStoreId, Map<string, Uint8Array>> = {
    drive: new Map(),
    sheets: new Map(),
    slides: new Map(),
    pdfs: new Map(),
  };
  const io = (s: ContentStoreId): ContentIO => ({
    read: async (i) => maps[s].get(i.id),
    write: async (i, b) => void maps[s].set(i.id, b),
  });
  const kv = new Map<string, string>();
  const passport = { data: undefined as Uint8Array | undefined };
  const statuses: MirrorStatus[] = [];
  const make = (backend: FileBackend, more: MirrorExtra[] = []) =>
    new FileMirror({
      backend,
      catalog,
      contents: { drive: io("drive"), sheets: io("sheets"), slides: io("slides"), pdfs: io("pdfs") },
      getSecret: () => ref.current,
      storage: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
      now: () => new Date(T),
      onStatus: (s) => statuses.push(s),
      extras: [
        {
          id: "passport",
          dir: "Passeport",
          name: "passeport",
          read: async () => passport.data,
          write: async (b) => void (passport.data = b),
          isEmpty: async () => !passport.data,
        },
        ...more,
      ],
    });
  return { catalog, maps, ref, make, passport, statuses };
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

async function seed(m: ReturnType<typeof machine>) {
  await m.catalog.upsertItems([
    item("d1"),
    item("s1", { kind: "sheet", contentStore: "sheets", title: "Budget: 2026/Q1?" }),
    item("p1", { kind: "pdf", contentStore: "pdfs", title: "Facture" }),
  ]);
  m.maps.drive.set("d1", enc("SECRET-DOC"));
  m.maps.sheets.set("s1", enc('{"sheets":[]}'));
  m.maps.pdfs.set("p1", new Uint8Array([37, 80, 68, 70, 0, 255]));
}

describe("noms de fichiers", () => {
  it("assainit les titres et garde l'id entre crochets", () => {
    expect(safeTitle('a<b>:"c"/d\\e|f?g*')).toBe("a b c d e f g");
    expect(safeTitle("   ...  ")).toBe("Sans titre");
    expect(fileFor({ id: "i-1", title: "Mon doc.", contentStore: "drive" }, false)).toBe(
      "Documents/Mon doc [i-1].elium",
    );
    expect(fileFor({ id: "i-1", title: "Secret", contentStore: "pdfs" }, true)).toBe("PDF/[i-1].vault");
  });
});

describe("miroir en fichiers", () => {
  it("1er lancement : copie de sécurité puis miroir complet, octet pour octet", async () => {
    const a = machine();
    await seed(a);
    const { backend, files } = memBackend();
    await a.make(backend).start();
    expect(dec(files.get("Documents/Titre d1 [d1].elium"))).toBe("SECRET-DOC");
    expect(files.get("PDF/Facture [p1].pdf")).toEqual(new Uint8Array([37, 80, 68, 70, 0, 255]));
    expect([...files.keys()].some((k) => k.startsWith("Sauvegardes/avant-migration-"))).toBe(true);
    expect(files.has(CATALOG_PLAIN)).toBe(true);
    expect([...files.keys()].every((k) => !/[<>:"|?*]/.test(k.split("/")[1]!))).toBe(true);
  });

  it("n'écrit que ce qui a changé", async () => {
    const a = machine();
    await seed(a);
    const m = memBackend();
    const mirror = a.make(m.backend);
    await mirror.start();
    const base = m.writes();
    await mirror.sync();
    expect(m.writes()).toBe(base);
    a.maps.drive.set("d1", enc("SECRET-DOC v2"));
    await a.catalog.patchItems(["d1"], { size: 13, modifiedAt: "2026-10-02T00:00:00.000Z" });
    await mirror.sync();
    expect(m.writes()).toBe(base + 2); // le contenu + le catalogue
  });

  it("restaure sur un espace vide (port changé / profil effacé), sans doublon ensuite", async () => {
    const a = machine();
    await seed(a);
    a.passport.data = enc('{"p":1}');
    const { backend } = memBackend();
    await a.make(backend).start();
    const b = machine(); // IndexedDB vierge, mêmes fichiers
    const r = await b.make(backend).start();
    expect(r.restored).toBe(3);
    expect(dec(b.maps.drive.get("d1"))).toBe("SECRET-DOC");
    expect(b.maps.pdfs.get("p1")).toEqual(new Uint8Array([37, 80, 68, 70, 0, 255]));
    expect((await b.catalog.load()).items).toHaveLength(3);
    expect(dec(b.passport.data)).toBe('{"p":1}');
    expect((await b.make(backend).start()).restored).toBe(0);
  });

  it("garde-fou : si la restauration échoue, rien n'est retiré du dossier", async () => {
    const a = machine();
    await seed(a);
    const { backend, files, trash } = memBackend();
    await a.make(backend).start();
    const before = new Map(files);
    const b = machine();
    b.catalog.upsertItem = async () => {
      throw new Error("écriture refusée");
    };
    const mb = b.make(backend);
    await mb.start().catch(() => undefined);
    await mb.sync().catch(() => undefined);
    expect(trash).toEqual([]);
    for (const k of before.keys()) expect(files.has(k)).toBe(true);
  });

  it("suppression définitive → fichier dans la corbeille du dossier, jamais perdu", async () => {
    const a = machine();
    await seed(a);
    const { backend, files, trash } = memBackend();
    const mirror = a.make(backend);
    await mirror.start();
    await a.catalog.removeItems(["d1"]);
    await mirror.sync();
    expect(files.has("Documents/Titre d1 [d1].elium")).toBe(false);
    expect(trash).toContain("Documents/Titre d1 [d1].elium");
    const saved = JSON.parse(dec(files.get(CATALOG_PLAIN))!) as { items: { id: string }[] };
    expect(saved.items.map((i) => i.id).sort()).toEqual(["p1", "s1"]);
  });
});

describe("coffre local : rien en clair sur disque", () => {
  const secret: VaultSecret = { password: "coffre" };

  it("contenu, catalogue et passeport sont scellés ; aucun titre dans les noms", async () => {
    const a = machine(secret);
    await seed(a);
    a.passport.data = enc("PASSEPORT-CLAIR");
    const { backend, files } = memBackend();
    await a.make(backend).start();
    expect([...files.keys()]).toContain("Documents/[d1].vault");
    expect(files.has(CATALOG_SEALED)).toBe(true);
    expect(files.has(CATALOG_PLAIN)).toBe(false);
    for (const [k, v] of files) {
      expect(k).not.toMatch(/Titre|Budget|Facture/);
      expect(dec(v)).not.toContain("SECRET-DOC");
      expect(dec(v)).not.toContain("PASSEPORT-CLAIR");
      expect(dec(v)).not.toContain("Titre d1");
    }
  });

  it("restauration : exige le coffre déverrouillé, sinon bloque sans rien écraser", async () => {
    const a = machine(secret);
    await seed(a);
    const { backend, files } = memBackend();
    await a.make(backend).start();
    const snapshot = new Map(files);

    const locked = machine(); // coffre non déverrouillé
    await locked.make(backend).start();
    expect(locked.statuses.at(-1)?.state).toBe("blocked");
    expect(files).toEqual(snapshot);

    const wrong = machine({ password: "autre" });
    await wrong.make(backend).start();
    expect(wrong.statuses.at(-1)?.state).toBe("blocked");
    expect(files).toEqual(snapshot);

    const ok = machine(secret);
    expect((await ok.make(backend).start()).restored).toBe(3);
    expect(dec(ok.maps.drive.get("d1"))).toBe("SECRET-DOC");
  });

  it("activer le coffre après coup : les copies en clair sont effacées définitivement", async () => {
    const a = machine();
    await seed(a);
    const { backend, files, trash } = memBackend();
    const mirror = a.make(backend);
    await mirror.start();
    expect(files.has("Documents/Titre d1 [d1].elium")).toBe(true);
    a.ref.current = secret;
    const { items } = await a.catalog.load();
    await a.catalog.upsertItems(items.map((i) => ({ ...i, vaultProtected: true })));
    await mirror.sync();
    expect(files.has("Documents/Titre d1 [d1].elium")).toBe(false);
    expect(files.has(CATALOG_PLAIN)).toBe(false);
    expect(files.has("Documents/[d1].vault")).toBe(true);
    expect(trash).toEqual([]);
    for (const v of files.values()) expect(dec(v)).not.toContain("SECRET-DOC");
  });

  it("enveloppe disque : aller-retour et rejet d'un mauvais secret", async () => {
    const sealed = await sealForDisk(enc("abc"), secret);
    expect(dec(await openFromDisk(sealed, secret))).toBe("abc");
    await expect(openFromDisk(sealed, { password: "x" })).rejects.toBeTruthy();
    await expect(openFromDisk(enc("trop court et pas scellé du tout, vraiment pas"), secret)).rejects.toBeTruthy();
  });
});

describe("choix du backend à l'exécution", () => {
  it("hors lanceur (pas de jeton) → null", async () => {
    expect(await launcherFilesBackend((() => Promise.reject(new Error("no"))) as unknown as typeof fetch)).toBeNull();
  });

  it("persist() : demandé côté site, jamais d'exception", async () => {
    expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => true })).toBe(true);
    expect(await requestPersistentStorage({ persisted: async () => true, persist: async () => false })).toBe(true);
    expect(await requestPersistentStorage({ persist: async () => Promise.reject(new Error("x")) } as never)).toBe(
      false,
    );
    expect(await requestPersistentStorage(undefined)).toBe(false);
  });
});

/** Faux magasin annexe (brouillons…) : enregistrements { k, updatedAt, v } fusionnés « le plus récent gagne ». */
function fakePiece(id: string, initial: { k: string; updatedAt: string; v: string }[] = []) {
  const rows = new Map(initial.map((r) => [r.k, r]));
  let reads = 0;
  const extra: MirrorExtra = {
    id,
    dir: "Annexes",
    name: id,
    ext: ".elium-extra",
    merge: true,
    watch: "dirty",
    async read() {
      reads++;
      return rows.size ? packRecords({ drafts: [...rows.values()] }) : undefined;
    },
    async write(bytes) {
      const remote = (await unpackRecords(bytes)).drafts ?? [];
      const plan = mergePlan(
        { name: "drafts", merge: "keyed" },
        [...rows.values()],
        remote,
        (v) => (v as { k: string }).k,
      );
      for (const r of plan as { k: string; updatedAt: string; v: string }[]) rows.set(r.k, r);
    },
    async isEmpty() {
      return rows.size === 0;
    },
  };
  return { extra, rows, reads: () => reads };
}

describe("annexes : brouillons, versions, polices, réglages", () => {
  const secret: VaultSecret = { password: "coffre" };
  const T1 = "2026-10-01T10:00:00.000Z";
  const T2 = "2026-10-02T10:00:00.000Z";

  it("cache vidé : tout revient automatiquement au démarrage, sans passage par l'interface", async () => {
    const a = machine();
    await seed(a);
    const pa = fakePiece("brouillons", [{ k: "d1", updatedAt: T1, v: "brouillon-un" }]);
    const { backend, files } = memBackend();
    await a.make(backend, [pa.extra]).start();
    expect(files.has("Annexes/brouillons.elium-extra")).toBe(true);

    const b = machine(); // profil neuf, mêmes fichiers
    const pb = fakePiece("brouillons");
    await b.make(backend, [pb.extra]).start();
    expect(pb.rows.get("d1")?.v).toBe("brouillon-un");
  });

  it("doublon : la version la plus récente gagne, l'ancienne ne remplace jamais la locale", async () => {
    const a = machine();
    const pa = fakePiece("brouillons", [{ k: "d1", updatedAt: T1, v: "ancien" }]);
    const { backend } = memBackend();
    await a.make(backend, [pa.extra]).start();

    const newer = machine();
    const pn = fakePiece("brouillons", [{ k: "d1", updatedAt: T2, v: "local-recent" }]);
    await newer.make(backend, [pn.extra]).start();
    expect(pn.rows.get("d1")?.v).toBe("local-recent"); // fichier plus ancien : le local reste

    const older = machine();
    const po = fakePiece("brouillons", [{ k: "d1", updatedAt: "2026-09-01T00:00:00.000Z", v: "local-vieux" }]);
    await older.make(backend, [po.extra]).start();
    // le fichier (T2, écrit par « newer ») est plus récent que le local
    expect(po.rows.get("d1")?.v).toBe("local-recent");
  });

  it("n'écrit un extra lourd que s'il est signalé (markDirty), pas à chaque passage", async () => {
    const a = machine();
    const pa = fakePiece("versions", [{ k: "v1", updatedAt: T1, v: "x" }]);
    const m = memBackend();
    const mirror = a.make(m.backend, [pa.extra]);
    await mirror.start();
    const readsAfterStart = pa.reads();
    await mirror.sync();
    await mirror.sync();
    expect(pa.reads()).toBe(readsAfterStart);
    pa.rows.set("v2", { k: "v2", updatedAt: T2, v: "y" });
    mirror.markDirty("versions");
    await mirror.flush();
    expect(pa.reads()).toBe(readsAfterStart + 1);
    const again = unpackRecords(m.files.get("Annexes/versions.elium-extra")!);
    expect(((await again).drafts ?? []).length).toBe(2);
  });

  it("coffre actif : annexes scellées, et restauration impossible sans le bon secret", async () => {
    const a = machine(secret);
    const pa = fakePiece("polices", [{ k: "f", updatedAt: T1, v: "POLICE-SECRETE" }]);
    const { backend, files } = memBackend();
    await a.make(backend, [pa.extra]).start();
    expect(files.has("Annexes/polices.vault")).toBe(true);
    expect(files.has("Annexes/polices.elium-extra")).toBe(false);
    for (const v of files.values()) expect(dec(v)).not.toContain("POLICE-SECRETE");

    const wrong = machine({ password: "autre" });
    const pw = fakePiece("polices");
    await wrong.make(backend, [pw.extra]).start();
    expect(pw.rows.size).toBe(0);

    const ok = machine(secret);
    const po = fakePiece("polices");
    await ok.make(backend, [po.extra]).start();
    expect(po.rows.get("f")?.v).toBe("POLICE-SECRETE");
  });

  it("un extra illisible ne bloque pas le reste de la restauration", async () => {
    const a = machine();
    await seed(a);
    const { backend, files } = memBackend();
    await a.make(backend, [fakePiece("brouillons", [{ k: "d1", updatedAt: T1, v: "ok" }]).extra]).start();
    files.set("Annexes/brouillons.elium-extra", enc("pas un zip"));
    const b = machine();
    const r = await b.make(backend, [fakePiece("brouillons").extra]).start();
    expect(r.restored).toBe(3);
  });
});
