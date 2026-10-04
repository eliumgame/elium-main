/**
 * Cadre de migration des bases IndexedDB d'Elium.
 *
 * Chaque base locale (brouillons, bibliothèque, classeurs, présentations,
 * espace de travail…) déclare un `DbSpec` : une suite ORDONNÉE d'étapes
 * `{ version, up }`. La version cible de la base est celle de sa dernière étape ;
 * à l'ouverture, seules les étapes de version > ancienne version s'exécutent.
 *
 * Règles (jamais destructif) :
 *  - une étape est idempotente : `ensureStore` / `createIndex` ne créent que ce
 *    qui manque, et aucune étape ne supprime de données utilisateur ;
 *  - une étape qui réécrit des enregistrements existants se déclare `risky` : avant
 *    de monter la version, on copie la base dans `elium-backups` (voir
 *    `backupBeforeUpgrade`) pour pouvoir revenir en arrière ;
 *  - une base déjà à une version PLUS RÉCENTE que la cible (autre build, autre
 *    branche) s'ouvre telle quelle, sans tentative de rétrogradation.
 *
 * La logique (planification, application des étapes, rétention des sauvegardes)
 * est PURE et testée avec une base factice ; seuls `idbSchemaDb` /
 * `openMigrated` / `IdbBackupIo` touchent IndexedDB.
 */

/** Marqueur : l'étape a traité cet enregistrement sans le modifier. */
export const KEEP: unique symbol = Symbol("keep");
/** Marqueur : l'étape retire cet enregistrement (réservé aux données DÉRIVÉES, jamais utilisateur). */
export const DROP: unique symbol = Symbol("drop");

export interface SchemaStore {
  hasIndex(name: string): boolean;
  createIndex(name: string, keyPath: string, unique?: boolean): void;
  /** Visite chaque enregistrement ; la valeur retournée le remplace (KEEP = inchangé, DROP = retiré). */
  transform(fn: (value: unknown) => unknown): void;
  put(value: unknown): void;
}

export interface SchemaDb {
  has(store: string): boolean;
  /** Crée la table si absente ; la renvoie dans tous les cas. */
  ensureStore(name: string, options?: { keyPath?: string; autoIncrement?: boolean }): SchemaStore;
  store(name: string): SchemaStore;
}

export interface MigrationStep {
  /** Version de la base APRÈS cette étape (entiers croissants, à partir de 1). */
  version: number;
  label: string;
  /** Réécrit des enregistrements existants : une sauvegarde est prise avant. */
  risky?: boolean;
  up(db: SchemaDb, fromVersion: number): void;
}

export interface DbSpec {
  name: string;
  steps: MigrationStep[];
}

export function validateSpec(spec: DbSpec): void {
  let last = 0;
  for (const s of spec.steps) {
    if (!Number.isInteger(s.version) || s.version <= last)
      throw new Error(`Spécification « ${spec.name} » invalide : versions non croissantes (${s.version}).`);
    last = s.version;
  }
  if (spec.steps.length === 0) throw new Error(`Spécification « ${spec.name} » sans étape.`);
}

export function targetVersion(spec: DbSpec): number {
  return spec.steps[spec.steps.length - 1]!.version;
}

export interface MigrationPlan {
  from: number;
  to: number;
  pending: MigrationStep[];
  needsBackup: boolean;
  /** La base est plus récente que ce build : on l'ouvre sans la modifier. */
  newerThanSpec: boolean;
}

/** Plan pur : quelles étapes exécuter pour passer de `from` à la version cible. */
export function planMigration(spec: DbSpec, from: number): MigrationPlan {
  validateSpec(spec);
  const to = targetVersion(spec);
  const pending = from >= to ? [] : spec.steps.filter((s) => s.version > from);
  return {
    from,
    to,
    pending,
    // Une base inexistante (from = 0) n'a rien à perdre : pas de sauvegarde.
    needsBackup: from > 0 && pending.some((s) => s.risky),
    newerThanSpec: from > to,
  };
}

/** Applique les étapes en attente ; renvoie les versions appliquées. */
export function runUpgrade(spec: DbSpec, db: SchemaDb, oldVersion: number): number[] {
  const { pending } = planMigration(spec, oldVersion);
  const applied: number[] = [];
  for (const step of pending) {
    step.up(db, oldVersion);
    applied.push(step.version);
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Adaptateur IndexedDB réel
// ---------------------------------------------------------------------------

function idbSchemaStore(os: IDBObjectStore): SchemaStore {
  return {
    hasIndex: (n) => os.indexNames.contains(n),
    createIndex(name, keyPath, unique = false) {
      if (!os.indexNames.contains(name)) os.createIndex(name, keyPath, { unique });
    },
    transform(fn) {
      const req = os.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const out = fn(cursor.value);
        if (out === DROP) cursor.delete();
        else if (out !== KEEP) cursor.update(out);
        cursor.continue();
      };
    },
    put: (v) => void os.put(v),
  };
}

export function idbSchemaDb(db: IDBDatabase, tx: IDBTransaction): SchemaDb {
  return {
    has: (s) => db.objectStoreNames.contains(s),
    ensureStore(name, options) {
      const os = db.objectStoreNames.contains(name)
        ? tx.objectStore(name)
        : db.createObjectStore(name, { keyPath: options?.keyPath ?? "id", autoIncrement: options?.autoIncrement });
      return idbSchemaStore(os);
    },
    store: (name) => idbSchemaStore(tx.objectStore(name)),
  };
}

// ---------------------------------------------------------------------------
// Sauvegarde avant migration à risque
// ---------------------------------------------------------------------------

export const BACKUP_DB = "elium-backups";
export const BACKUP_STORE = "snapshots";
/** Nombre de sauvegardes de migration conservées par base. */
export const BACKUPS_PER_DB = 2;

export interface UpgradeSnapshot {
  id: string;
  db: string;
  version: number;
  at: string;
  stores: Record<string, unknown[]>;
}

/** Entrées/sorties de la sauvegarde — abstraites pour pouvoir être testées sans IndexedDB. */
export interface BackupIo {
  /** Version courante de la base, 0 si elle n'existe pas. */
  currentVersion(name: string): Promise<number>;
  readAll(name: string): Promise<{ version: number; stores: Record<string, unknown[]> }>;
  saveSnapshot(snap: UpgradeSnapshot): Promise<void>;
  listSnapshots(): Promise<UpgradeSnapshot[]>;
  deleteSnapshot(id: string): Promise<void>;
}

/** Quels instantanés supprimer pour n'en garder que `keep` par base (les plus récents). Pur. */
export function snapshotsToPrune(all: Pick<UpgradeSnapshot, "id" | "db" | "at">[], keep = BACKUPS_PER_DB): string[] {
  const byDb = new Map<string, typeof all>();
  for (const s of all) byDb.set(s.db, [...(byDb.get(s.db) ?? []), s]);
  const drop: string[] = [];
  for (const list of byDb.values()) {
    const sorted = [...list].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    for (const old of sorted.slice(keep)) drop.push(old.id);
  }
  return drop;
}

const prepared = new Set<string>();

/**
 * Si la migration de `spec` contient une étape à risque et que la base existe,
 * en copie le contenu dans `elium-backups`. Renvoie l'instantané créé (ou null).
 * Échec de sauvegarde = on N'OUVRE PAS la base à la version supérieure.
 */
export async function backupBeforeUpgrade(spec: DbSpec, io: BackupIo, now = () => new Date()): Promise<string | null> {
  const from = await io.currentVersion(spec.name);
  const plan = planMigration(spec, from);
  if (!plan.needsBackup) return null;
  const data = await io.readAll(spec.name);
  const at = now().toISOString();
  const snap: UpgradeSnapshot = {
    id: `${spec.name}@v${data.version}@${at}`,
    db: spec.name,
    version: data.version,
    at,
    stores: data.stores,
  };
  await io.saveSnapshot(snap);
  for (const id of snapshotsToPrune(await io.listSnapshots())) await io.deleteSnapshot(id);
  return snap.id;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openRaw(name: string, version?: number, upgrade?: (db: IDBDatabase, tx: IDBTransaction, old: number) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    if (upgrade) req.onupgradeneeded = (e) => upgrade(req.result, req.transaction!, e.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Bloquée par une autre fenêtre ouverte : elle se ferme d'elle-même (onversionchange) ; on attend.
    req.onblocked = () => console.warn(`[elium] base « ${name} » en attente de la fermeture d'une autre fenêtre`);
  });
}

export const IdbBackupIo: BackupIo = {
  async currentVersion(name) {
    const lister = (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string; version?: number }[]> })
      .databases;
    if (typeof lister !== "function") return 0;
    const all = await lister.call(indexedDB);
    return all.find((d) => d.name === name)?.version ?? 0;
  },
  async readAll(name) {
    const db = await openRaw(name); // sans version : n'altère pas la base
    try {
      const stores: Record<string, unknown[]> = {};
      const names = Array.from(db.objectStoreNames);
      if (names.length) {
        const tx = db.transaction(names, "readonly");
        for (const n of names) stores[n] = await promisify(tx.objectStore(n).getAll());
      }
      return { version: db.version, stores };
    } finally {
      db.close();
    }
  },
  async saveSnapshot(snap) {
    const db = await openMigrated(BACKUPS_SPEC, { skipBackup: true });
    try {
      await promisify(db.transaction(BACKUP_STORE, "readwrite").objectStore(BACKUP_STORE).put(snap));
    } finally {
      db.close();
    }
  },
  async listSnapshots() {
    const db = await openMigrated(BACKUPS_SPEC, { skipBackup: true });
    try {
      return await promisify(db.transaction(BACKUP_STORE, "readonly").objectStore(BACKUP_STORE).getAll());
    } finally {
      db.close();
    }
  },
  async deleteSnapshot(id) {
    const db = await openMigrated(BACKUPS_SPEC, { skipBackup: true });
    try {
      await promisify(db.transaction(BACKUP_STORE, "readwrite").objectStore(BACKUP_STORE).delete(id));
    } finally {
      db.close();
    }
  },
};

export const BACKUPS_SPEC: DbSpec = {
  name: BACKUP_DB,
  steps: [{ version: 1, label: "Table des instantanés", up: (db) => void db.ensureStore(BACKUP_STORE) }],
};

/**
 * Ouvre une base d'Elium à sa version cible en jouant les migrations en attente.
 * Une base plus récente que la cible est ouverte telle quelle (VersionError →
 * ouverture sans version). Les migrations à risque sont précédées d'une sauvegarde.
 */
export async function openMigrated(spec: DbSpec, opts: { skipBackup?: boolean } = {}): Promise<IDBDatabase> {
  validateSpec(spec);
  if (!opts.skipBackup && !prepared.has(spec.name)) {
    await backupBeforeUpgrade(spec, IdbBackupIo);
    prepared.add(spec.name);
  }
  const target = targetVersion(spec);
  let db: IDBDatabase;
  try {
    db = await openRaw(spec.name, target, (d, tx, old) => runUpgrade(spec, idbSchemaDb(d, tx), old));
  } catch (e) {
    if ((e as DOMException)?.name === "VersionError") db = await openRaw(spec.name);
    else throw e;
  }
  db.onversionchange = () => db.close(); // une autre instance veut migrer : on s'efface
  return db;
}

/** Test uniquement : oublie les bases déjà préparées. */
export function resetPreparedForTests(): void {
  prepared.clear();
}
