/**
 * Miroir de l'espace de travail en fichiers locaux (app Windows).
 *
 * IndexedDB reste le cache de travail de tous les modules ; ce service recopie
 * le catalogue et le contenu de chaque élément dans le dossier de travail via
 * un `FileBackend` (API loopback du lanceur), et RÉIMPORTE au démarrage les
 * éléments présents en fichiers mais absents d'IndexedDB (port changé, données
 * du navigateur effacées). Garanties :
 *  - jamais destructif côté IndexedDB (restauration = ajout seulement) ;
 *  - un fichier d'élément supprimé part dans la corbeille du dossier ;
 *  - coffre local actif → rien en clair sur disque (contenu et catalogue scellés) ;
 *  - 1er lancement : copie de sécurité complète (`Sauvegardes/avant-migration-*`).
 * Toutes les E/S sont injectées : testé sans navigateur ni lanceur.
 */
import type { VaultSecret } from "../crypto/local-vault";
import { decryptAtRest, encryptAtRest, hasVaultSecret, openSealedBytes, sealBytesAtRest } from "../crypto/local-vault";
import type { Catalog } from "../workspace/catalog";
import { cleanFolder, cleanItem, contentKey, planBackupRestore, type BackupSnapshot } from "../workspace/backup";
import {
  collectSnapshot,
  packBackup,
  restoreSnapshot,
  type ContentIO,
  type KeyValueIO,
} from "../workspace/backup-io";
import type { ContentStoreId, WorkFolder, WorkItem } from "../workspace/types";
import type { FileBackend } from "./persistence";

export const CATALOG_PLAIN = "_elium/catalogue.json";
export const CATALOG_SEALED = "_elium/catalogue.vault";
export const STATE_FILE = "_elium/state.json";

const DIRS: Record<ContentStoreId, string> = {
  drive: "Documents",
  sheets: "Classeurs",
  slides: "Presentations",
  pdfs: "PDF",
};
const EXTS: Record<ContentStoreId, string> = {
  drive: ".elium",
  sheets: ".classeur.json",
  slides: ".presentation.json",
  pdfs: ".pdf",
};

/** Donnée hors espace de travail à miroiter (ex. passeport E4) : un seul fichier. */
export interface MirrorExtra {
  id: string;
  dir: "Passeport";
  name: string;
  read(): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array): Promise<void>;
  isEmpty(): Promise<boolean>;
}

export type MirrorStatus =
  | { state: "idle"; lastSyncAt?: string; restored?: number; root?: string }
  | { state: "syncing" }
  | { state: "blocked"; message: string }
  | { state: "error"; message: string };

export interface MirrorDeps {
  backend: FileBackend;
  catalog: Catalog;
  contents: Record<ContentStoreId, ContentIO>;
  getSecret: () => VaultSecret | undefined;
  storage: KeyValueIO;
  extras?: MirrorExtra[];
  appVersion?: string;
  now?: () => Date;
  onStatus?: (s: MirrorStatus) => void;
  debounceMs?: number;
}

type CatalogEntry = WorkItem & { file: string };
interface CatalogFile {
  schema: 1;
  savedAt: string;
  sealed: boolean;
  appVersion?: string;
  folders: WorkFolder[];
  items: CatalogEntry[];
}

// --- Enveloppe binaire du coffre : "ELVF" | v1 | sel 16 | iv 12 | chiffré -------------
const MAGIC = [0x45, 0x4c, 0x56, 0x46, 1];

export async function sealForDisk(bytes: Uint8Array, secret: VaultSecret): Promise<Uint8Array> {
  const s = await sealBytesAtRest(bytes, secret);
  const out = new Uint8Array(MAGIC.length + 16 + 12 + s.ct.length);
  out.set(MAGIC, 0);
  out.set(s.salt, MAGIC.length);
  out.set(s.iv, MAGIC.length + 16);
  out.set(s.ct, MAGIC.length + 28);
  return out;
}

export async function openFromDisk(bytes: Uint8Array, secret: VaultSecret): Promise<Uint8Array> {
  if (bytes.length < MAGIC.length + 28 || MAGIC.some((b, i) => bytes[i] !== b))
    throw new Error("Fichier scellé illisible.");
  const o = MAGIC.length;
  return openSealedBytes(
    { v: 3, salt: bytes.slice(o, o + 16), iv: bytes.slice(o + 16, o + 28), ct: bytes.slice(o + 28) },
    secret,
  );
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

export function safeTitle(t: string): string {
  const s = t
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .trim();
  return s || "Sans titre";
}

/** Chemin logique d'un élément. Coffre actif : l'identifiant seul (le titre est une donnée protégée). */
export function fileFor(item: Pick<WorkItem, "id" | "title" | "contentStore">, sealed: boolean): string {
  const id = item.id.replace(/[^A-Za-z0-9_-]/g, "_");
  const dir = DIRS[item.contentStore];
  return sealed ? `${dir}/[${id}].vault` : `${dir}/${safeTitle(item.title)} [${id}]${EXTS[item.contentStore]}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class FileMirror {
  private prev: CatalogFile | null = null;
  private lastCatalogJson = "";
  private ready = false;
  private sawItems = false;
  private protectedIds = new Set<string>();
  private extraHashes = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private deps: MirrorDeps) {}

  private status(s: MirrorStatus) {
    this.deps.onStatus?.(s);
  }
  private get sealed() {
    return hasVaultSecret(this.deps.getSecret());
  }
  private now() {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  // --- lecture du catalogue en fichiers ------------------------------------------
  private async readCatalogFile(): Promise<{ cat: CatalogFile | null; blocked?: string }> {
    const { backend } = this.deps;
    const plain = await backend.read(CATALOG_PLAIN);
    const sealed = plain ? undefined : await backend.read(CATALOG_SEALED);
    try {
      if (plain) return { cat: JSON.parse(dec(plain)) as CatalogFile };
      if (sealed) {
        const secret = this.deps.getSecret();
        if (!hasVaultSecret(secret))
          return { cat: null, blocked: "Les fichiers locaux sont protégés par le coffre : déverrouillez-le." };
        return { cat: await decryptAtRest<CatalogFile>(dec(sealed), secret) };
      }
    } catch {
      return {
        cat: null,
        blocked: "Le catalogue des fichiers locaux est illisible (mauvais mot de passe du coffre ou fichier abîmé).",
      };
    }
    return { cat: null };
  }

  /** Démarrage : restauration non destructive, copie de sécurité au 1er lancement, premier miroir. */
  async start(): Promise<{ restored: number }> {
    this.status({ state: "syncing" });
    const { cat, blocked } = await this.readCatalogFile();
    if (blocked) {
      this.status({ state: "blocked", message: blocked });
      return { restored: 0 };
    }
    let restored = 0;
    if (cat && Array.isArray(cat.items)) {
      this.prev = { ...cat, items: cat.items.filter((i) => typeof i?.file === "string") };
      this.lastCatalogJson = this.catalogJson(this.prev);
      restored = await this.restoreMissing(this.prev);
    } else if ((await this.deps.catalog.load()).items.length > 0) {
      await this.safetyCopy();
    }
    this.ready = true;
    await this.sync();
    await this.deps.backend.write(
      STATE_FILE,
      enc(JSON.stringify({ schema: 1, startedAt: this.now(), appVersion: this.deps.appVersion })),
    );
    return { restored };
  }

  private async safetyCopy(): Promise<void> {
    const secret = this.deps.getSecret();
    // Coffre à clé-fichier seule : pas de mot de passe pour chiffrer l'archive → pas de copie en clair.
    if (hasVaultSecret(secret) && !secret.password) return;
    try {
      const snap = await collectSnapshot(this.deps, { includeSecrets: false });
      const bytes = await packBackup(snap, { includeSecrets: false, password: secret?.password });
      const day = this.now().slice(0, 10);
      await this.deps.backend.write(`Sauvegardes/avant-migration-${day}.elium-workspace`, bytes);
    } catch {
      /* coffre verrouillé ou archive trop lourde : le miroir lui-même est non destructif */
    }
  }

  /** Réimporte (sans jamais écraser) les éléments présents en fichiers et absents d'IndexedDB. */
  private async restoreMissing(file: CatalogFile): Promise<number> {
    const { backend } = this.deps;
    const local = await this.deps.catalog.load();
    const have = new Set(local.items.map((i) => i.id));
    const secret = this.deps.getSecret();
    const items: WorkItem[] = [];
    const contents = new Map<string, Uint8Array>();
    for (const raw of file.items) {
      if (have.has(raw.id)) continue;
      const item = cleanItem(raw);
      if (!item) continue;
      try {
        let bytes = await backend.read(raw.file);
        if (!bytes) continue;
        if (raw.file.endsWith(".vault")) {
          if (!hasVaultSecret(secret)) continue;
          bytes = await openFromDisk(bytes, secret);
        }
        items.push(item);
        contents.set(contentKey(item.contentStore, item.id), bytes);
      } catch {
        /* fichier illisible : l'élément reste protégé dans les fichiers (cf. protectedIds) */
      }
    }
    if (items.length) {
      const folders = (file.folders ?? []).map(cleanFolder).filter((f): f is WorkFolder => !!f);
      const snap: BackupSnapshot = { createdAt: file.savedAt, folders, items, contents, settings: {}, secrets: {} };
      const plan = planBackupRestore([], local.folders, snap, "skip");
      await restoreSnapshot(this.deps, snap, plan, { applySettings: false, applySecrets: false });
    }
    // Tout ce qui est en fichiers mais toujours absent d'IndexedDB est PROTÉGÉ : ni retiré ni oublié.
    const after = new Set((await this.deps.catalog.load()).items.map((i) => i.id));
    this.protectedIds = new Set(file.items.filter((i) => !after.has(i.id)).map((i) => i.id));
    if (after.size > 0) this.sawItems = true;
    for (const extra of this.deps.extras ?? []) {
      try {
        const base = `${extra.dir}/${extra.name}`;
        const sealedBytes = await backend.read(`${base}.vault`);
        const plainBytes = sealedBytes ? undefined : await backend.read(`${base}.json`);
        if (!(await extra.isEmpty())) continue;
        if (plainBytes) await extra.write(plainBytes);
        else if (sealedBytes && hasVaultSecret(secret)) await extra.write(await openFromDisk(sealedBytes, secret));
      } catch {
        /* meilleur effort */
      }
    }
    return items.filter((i) => after.has(i.id)).length;
  }

  private catalogJson(c: CatalogFile): string {
    return JSON.stringify({ ...c, savedAt: "" });
  }

  /** Un passage de miroir (n'écrit que ce qui a changé). */
  async sync(): Promise<void> {
    if (!this.ready) return;
    const { backend, catalog, contents } = this.deps;
    const sealed = this.sealed;
    const secret = this.deps.getSecret();
    const { items, folders } = await catalog.load();
    if (items.some((i) => i.locked) || folders.some((f) => f.locked)) return; // coffre verrouillé
    if (items.length > 0) this.sawItems = true;
    const prev = this.prev;
    const prevById = new Map((prev?.items ?? []).map((i) => [i.id, i]));
    const sealedChanged = !!prev && prev.sealed !== sealed;
    // Copies en clair remplacées par des copies scellées : effacement définitif, pas de corbeille.
    const hardOld = sealedChanged && prev?.sealed === false;
    const toDisk = async (b: Uint8Array) => (sealed ? sealForDisk(b, secret as VaultSecret) : b);
    const next: CatalogEntry[] = [];
    const errors: string[] = [];

    for (const item of items) {
      const file = fileFor(item, sealed);
      const old = prevById.get(item.id);
      const same =
        !!old && !sealedChanged && old.file === file && old.modifiedAt === item.modifiedAt && old.size === item.size;
      if (!same) {
        try {
          const bytes = await contents[item.contentStore].read(item);
          if (!bytes) {
            if (old) next.push(old);
            continue;
          }
          await backend.write(file, await toDisk(bytes));
          if (old && old.file !== file) await backend.remove(old.file, { hard: hardOld });
        } catch (e) {
          errors.push(`${item.title} : ${msg(e)}`);
          if (old) next.push(old);
          continue;
        }
      }
      next.push({ ...item, file });
    }

    // Éléments disparus du catalogue (suppression définitive) → corbeille du dossier. Pas de retrait
    // massif si le catalogue local est vide sans avoir jamais contenu d'élément (données effacées).
    const currentIds = new Set(items.map((i) => i.id));
    const massWipe = items.length === 0 && (prev?.items.length ?? 0) > 0 && !this.sawItems;
    for (const old of prev?.items ?? []) {
      if (currentIds.has(old.id)) continue;
      if (massWipe || this.protectedIds.has(old.id)) {
        next.push(old);
        continue;
      }
      try {
        await backend.remove(old.file, { hard: hardOld });
      } catch (e) {
        errors.push(`${old.title} : ${msg(e)}`);
        next.push(old);
      }
    }

    const cat: CatalogFile = {
      schema: 1,
      savedAt: this.now(),
      sealed,
      appVersion: this.deps.appVersion,
      folders,
      items: next,
    };
    const json = this.catalogJson(cat);
    if (json !== this.lastCatalogJson || sealedChanged) {
      const body = JSON.stringify(cat);
      if (sealed) await backend.write(CATALOG_SEALED, enc(await encryptAtRest(cat, secret as VaultSecret, body)));
      else await backend.write(CATALOG_PLAIN, enc(body));
      if (sealedChanged) await backend.remove(sealed ? CATALOG_PLAIN : CATALOG_SEALED, { hard: true });
      this.lastCatalogJson = json;
    }
    this.prev = cat;

    for (const extra of this.deps.extras ?? []) {
      try {
        const bytes = await extra.read();
        if (!bytes) continue;
        const h = await sha256Hex(bytes);
        if (this.extraHashes.get(extra.id) === h && !sealedChanged) continue;
        const base = `${extra.dir}/${extra.name}`;
        await backend.write(sealed ? `${base}.vault` : `${base}.json`, await toDisk(bytes));
        if (sealedChanged) await backend.remove(sealed ? `${base}.json` : `${base}.vault`, { hard: true });
        this.extraHashes.set(extra.id, h);
      } catch (e) {
        errors.push(`${extra.id} : ${msg(e)}`);
      }
    }

    if (errors.length) this.status({ state: "error", message: errors.slice(0, 3).join(" ; ") });
    else this.status({ state: "idle", lastSyncAt: this.now(), root: backend.root });
  }

  /** Planifie un passage (anti-rebond) ; les passages sont sérialisés. */
  schedule(): void {
    if (!this.ready) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.deps.debounceMs ?? 2500);
  }

  /** Passage immédiat, après ceux déjà en cours. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    const run = this.chain.then(() => this.sync());
    this.chain = run.catch((e) => this.status({ state: "error", message: msg(e) }));
    return this.chain as Promise<void>;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
