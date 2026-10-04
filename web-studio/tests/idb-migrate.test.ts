/**
 * Cadre de migration IndexedDB : planification, application idempotente des
 * étapes, étape à risque (déplacement des sources PDF) et sauvegarde préalable —
 * le tout sur une base factice en mémoire (vitest tourne sans IndexedDB).
 */
import { describe, it, expect } from "vitest";
import {
  KEEP,
  DROP,
  planMigration,
  runUpgrade,
  targetVersion,
  validateSpec,
  backupBeforeUpgrade,
  snapshotsToPrune,
  type BackupIo,
  type DbSpec,
  type SchemaDb,
  type SchemaStore,
  type UpgradeSnapshot,
} from "../src/format/idb-migrate";
import { ALL_DB_SPECS, PDF_RECOVERY_SPEC, DRIVE_SPEC } from "../src/format/db-specs";

class FakeStore implements SchemaStore {
  records = new Map<unknown, Record<string, unknown>>();
  indexes = new Set<string>();
  constructor(public keyPath: string) {}
  hasIndex(n: string) {
    return this.indexes.has(n);
  }
  createIndex(n: string) {
    this.indexes.add(n);
  }
  transform(fn: (v: unknown) => unknown) {
    for (const [k, v] of [...this.records]) {
      const out = fn(v);
      if (out === DROP) this.records.delete(k);
      else if (out !== KEEP) this.records.set(k, out as Record<string, unknown>);
    }
  }
  put(v: unknown) {
    const r = v as Record<string, unknown>;
    this.records.set(r[this.keyPath], r);
  }
}

class FakeDb implements SchemaDb {
  version = 0;
  stores = new Map<string, FakeStore>();
  has(s: string) {
    return this.stores.has(s);
  }
  ensureStore(name: string, o?: { keyPath?: string }) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeStore(o?.keyPath ?? "id"));
    return this.stores.get(name)!;
  }
  store(name: string) {
    const s = this.stores.get(name);
    if (!s) throw new Error("store absent " + name);
    return s;
  }
  open(spec: DbSpec) {
    const plan = planMigration(spec, this.version);
    runUpgrade(spec, this, this.version);
    if (!plan.newerThanSpec) this.version = Math.max(this.version, plan.to);
  }
}

describe("idb-migrate — planification", () => {
  it("la version cible est celle de la dernière étape", () => {
    expect(targetVersion(DRIVE_SPEC)).toBe(2);
    expect(targetVersion(PDF_RECOVERY_SPEC)).toBe(2);
  });

  it("une base neuve exécute toutes les étapes sans sauvegarde", () => {
    const p = planMigration(PDF_RECOVERY_SPEC, 0);
    expect(p.pending.map((s) => s.version)).toEqual([1, 2]);
    expect(p.needsBackup).toBe(false);
  });

  it("une étape à risque sur une base existante demande une sauvegarde", () => {
    const p = planMigration(PDF_RECOVERY_SPEC, 1);
    expect(p.pending.map((s) => s.version)).toEqual([2]);
    expect(p.needsBackup).toBe(true);
  });

  it("une base à jour ou plus récente que le build n'est pas touchée", () => {
    expect(planMigration(DRIVE_SPEC, 2).pending).toEqual([]);
    const newer = planMigration(DRIVE_SPEC, 9);
    expect(newer.pending).toEqual([]);
    expect(newer.newerThanSpec).toBe(true);
    expect(newer.needsBackup).toBe(false);
  });

  it("rejette une spécification aux versions non croissantes", () => {
    const bad: DbSpec = {
      name: "x",
      steps: [
        { version: 2, label: "a", up: () => {} },
        { version: 2, label: "b", up: () => {} },
      ],
    };
    expect(() => validateSpec(bad)).toThrow(/non croissantes/);
    expect(() => validateSpec({ name: "y", steps: [] })).toThrow(/sans étape/);
  });

  it("toutes les bases déclarées sont valides et de noms uniques", () => {
    for (const s of ALL_DB_SPECS) expect(() => validateSpec(s)).not.toThrow();
    const names = ALL_DB_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("idb-migrate — application", () => {
  it("monte une base v1 en v2 sans perdre ses données et de façon idempotente", () => {
    const db = new FakeDb();
    db.open({ name: "elium-drive", steps: [DRIVE_SPEC.steps[0]!] }); // v1
    db.store("docs").put({ id: "a", title: "Rapport" });
    db.version = 1;
    db.open(DRIVE_SPEC);
    expect(db.version).toBe(2);
    expect(db.store("docs").hasIndex("savedAt")).toBe(true);
    expect(db.store("docs").records.get("a")).toEqual({ id: "a", title: "Rapport" });
    // Rejouer les étapes ne casse rien.
    runUpgrade(DRIVE_SPEC, db, 0);
    expect(db.store("docs").records.size).toBe(1);
  });

  it("déplace les sources des brouillons PDF v1 vers leur table, une seule fois", () => {
    const db = new FakeDb();
    db.ensureStore("drafts");
    db.ensureStore("sources");
    db.store("drafts").put({ id: "d1", name: "a.pdf", source: new Uint8Array([1, 2, 3]) });
    db.store("drafts").put({ id: "d2", name: "b.pdf", sourceEnc: "AAA" });
    db.store("drafts").put({ id: "d3", name: "c.pdf" });
    db.version = 1;
    db.open(PDF_RECOVERY_SPEC);
    expect(db.version).toBe(2);
    const drafts = db.store("drafts").records;
    expect(drafts.get("d1")).toEqual({ id: "d1", name: "a.pdf" });
    expect(drafts.get("d2")).toEqual({ id: "d2", name: "b.pdf" });
    expect(drafts.get("d3")).toEqual({ id: "d3", name: "c.pdf" });
    const sources = db.store("sources").records;
    expect(sources.get("d1")).toMatchObject({ id: "d1", protected: false, bytes: new Uint8Array([1, 2, 3]) });
    expect(sources.get("d2")).toMatchObject({ protected: true, legacyEnc: "AAA" });
    // Deuxième ouverture : rien ne bouge.
    db.open(PDF_RECOVERY_SPEC);
    expect(sources.size).toBe(2);
  });

  it("une base neuve de version 0 n'exécute pas le déplacement de sources", () => {
    const db = new FakeDb();
    db.open(PDF_RECOVERY_SPEC);
    expect(db.version).toBe(2);
    expect(db.has("drafts") && db.has("sources")).toBe(true);
  });

  it("DROP retire un enregistrement dérivé, KEEP le laisse", () => {
    const db = new FakeDb();
    const spec: DbSpec = {
      name: "t",
      steps: [
        { version: 1, label: "init", up: (d) => void d.ensureStore("s") },
        {
          version: 2,
          label: "purge",
          up: (d) => d.store("s").transform((v) => ((v as { derived?: boolean }).derived ? DROP : KEEP)),
        },
      ],
    };
    db.open({ name: "t", steps: [spec.steps[0]!] });
    db.version = 1;
    db.store("s").put({ id: 1 });
    db.store("s").put({ id: 2, derived: true });
    db.open(spec);
    expect([...db.store("s").records.keys()]).toEqual([1]);
  });
});

class FakeBackupIo implements BackupIo {
  snaps: UpgradeSnapshot[] = [];
  constructor(
    public version: number,
    public data: Record<string, unknown[]>,
  ) {}
  async currentVersion() {
    return this.version;
  }
  async readAll() {
    return { version: this.version, stores: this.data };
  }
  async saveSnapshot(s: UpgradeSnapshot) {
    this.snaps.push(s);
  }
  async listSnapshots() {
    return this.snaps;
  }
  async deleteSnapshot(id: string) {
    this.snaps = this.snaps.filter((s) => s.id !== id);
  }
}

describe("idb-migrate — sauvegarde avant migration", () => {
  it("copie la base quand une étape à risque est en attente", async () => {
    const io = new FakeBackupIo(1, { drafts: [{ id: "d1" }], sources: [] });
    const id = await backupBeforeUpgrade(PDF_RECOVERY_SPEC, io, () => new Date("2026-10-01T10:00:00Z"));
    expect(id).toBe("elium-pdf-recovery@v1@2026-10-01T10:00:00.000Z");
    expect(io.snaps).toHaveLength(1);
    expect(io.snaps[0]!.stores.drafts).toEqual([{ id: "d1" }]);
  });

  it("ne sauvegarde rien pour une migration sans risque ou une base neuve", async () => {
    expect(await backupBeforeUpgrade(DRIVE_SPEC, new FakeBackupIo(1, {}))).toBeNull();
    expect(await backupBeforeUpgrade(PDF_RECOVERY_SPEC, new FakeBackupIo(0, {}))).toBeNull();
  });

  it("ne garde que les 2 instantanés les plus récents par base", () => {
    const all = [
      { id: "a1", db: "a", at: "2026-01-01" },
      { id: "a2", db: "a", at: "2026-02-01" },
      { id: "a3", db: "a", at: "2026-03-01" },
      { id: "b1", db: "b", at: "2026-01-01" },
    ];
    expect(snapshotsToPrune(all)).toEqual(["a1"]);
  });

  it("si la sauvegarde échoue, l'erreur remonte (la base n'est pas migrée)", async () => {
    const io = new FakeBackupIo(1, {});
    io.saveSnapshot = async () => {
      throw new Error("quota");
    };
    await expect(backupBeforeUpgrade(PDF_RECOVERY_SPEC, io)).rejects.toThrow("quota");
  });
});
