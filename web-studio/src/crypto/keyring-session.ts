/**
 * Session de déverrouillage du trousseau : UN mot de passe (ou une passkey, ou
 * le secret maître récupéré) déverrouille identité ET clé de réception ensemble ;
 * un verrouillage automatique par inactivité (réglable, 15 min par défaut) et un
 * verrouillage manuel effacent tout secret de la mémoire.
 *
 * Les secrets ne vivent QUE dans cet objet (jamais dans l'état React ni dans un
 * ref du composant) : `lock()` les zéroïse et notifie l'interface, qui n'a donc
 * rien d'autre à purger que ce qu'elle a copié elle-même (cf. use-keyring.ts).
 *
 * Aucune dépendance au DOM : le planificateur est injectable (tests).
 */
import { KeyringError, getMasterRecord, unwrapMasterWithPassword, type KeyEntry, type KeyringStore } from "./keyring";
import { deriveEd25519, deriveP256 } from "./keyring-derive";
import { decryptPrivateKey } from "../sign/identity-store";

export const DEFAULT_IDLE_MINUTES = 15;
export const IDLE_SETTING_KEY = "elium_keyring_idle_min";
/** Valeurs proposées dans les réglages (0 = jamais). */
export const IDLE_CHOICES = [1, 5, 15, 30, 60, 0] as const;

export function loadIdleMinutes(storage: Pick<Storage, "getItem">): number {
  try {
    const raw = storage.getItem(IDLE_SETTING_KEY);
    if (raw === null) return DEFAULT_IDLE_MINUTES;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 24 * 60 ? Math.floor(n) : DEFAULT_IDLE_MINUTES;
  } catch {
    return DEFAULT_IDLE_MINUTES;
  }
}

export function saveIdleMinutes(storage: Pick<Storage, "setItem">, minutes: number): void {
  try {
    storage.setItem(IDLE_SETTING_KEY, String(minutes));
  } catch {
    /* quota / mode privé : la valeur par défaut s'appliquera */
  }
}

export interface UnlockResult {
  /** kid des clés déverrouillées. */
  unlocked: string[];
  /** kid des clés héritées protégées par un AUTRE mot de passe. */
  failed: string[];
  masterUnlocked: boolean;
}

export interface SessionOptions {
  idleMinutes?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  onLock?: () => void;
}

export class KeyringSession {
  private master: Uint8Array | null = null;
  private privates = new Map<string, string>();
  private timer: unknown = null;
  private idleMs: number;
  private listeners = new Set<() => void>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(opts: SessionOptions = {}) {
    this.idleMs = (opts.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (opts.onLock) this.listeners.add(opts.onLock);
  }

  get unlocked(): boolean {
    return this.master !== null || this.privates.size > 0;
  }

  get hasMaster(): boolean {
    return this.master !== null;
  }

  /** Copie du secret maître (l'appelant ne doit pas la conserver). */
  getMaster(): Uint8Array | null {
    this.touch();
    return this.master ? new Uint8Array(this.master) : null;
  }

  getPrivate(kid: string): string | undefined {
    this.touch();
    return this.privates.get(kid);
  }

  isKeyUnlocked(kid: string): boolean {
    return this.privates.has(kid);
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  setIdleMinutes(minutes: number): void {
    this.idleMs = Math.max(0, minutes) * 60_000;
    this.touch();
  }

  /** Réarme le minuteur d'inactivité (à appeler à chaque usage d'une clé). */
  touch(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.unlocked && this.idleMs > 0) this.timer = this.setTimer(() => this.lock(), this.idleMs);
  }

  /** Verrouille : zéroïse le secret maître, oublie toutes les clés privées. */
  lock(): void {
    const was = this.unlocked;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.master?.fill(0);
    this.master = null;
    this.privates.clear();
    if (was) for (const cb of [...this.listeners]) cb();
  }

  /** Déverrouille avec le secret maître déjà connu (passkey, phrase, parts Shamir). */
  async unlockWithMaster(entries: KeyEntry[], master: Uint8Array): Promise<UnlockResult> {
    if (master.length !== 32) throw new KeyringError("Secret maître invalide.");
    this.master = new Uint8Array(master);
    const unlocked: string[] = [];
    for (const e of entries) {
      if (e.protection === "derived" && e.derivationIndex !== undefined && (await this.deriveInto(e))) unlocked.push(e.id);
    }
    this.touch();
    this.listeners.forEach((cb) => cb());
    return { unlocked, failed: [], masterUnlocked: true };
  }

  /**
   * UN mot de passe : déverrouille le secret maître (s'il existe) puis chaque clé
   * héritée qui se déchiffre avec ce même mot de passe. Les clés héritées
   * protégées par un autre mot de passe sont listées dans `failed`.
   */
  async unlockWithPassword(store: KeyringStore, password: string): Promise<UnlockResult> {
    const entries = await store.getAll();
    const record = await getMasterRecord(store);
    let master: Uint8Array | null = null;
    if (record?.passwordWrap) {
      try {
        master = await unwrapMasterWithPassword(record.passwordWrap, password);
      } catch {
        master = null;
      }
    }
    const unlocked: string[] = [];
    const failed: string[] = [];
    if (master) {
      this.master = master;
      for (const e of entries) {
        if (e.protection === "derived" && e.derivationIndex !== undefined && (await this.deriveInto(e))) unlocked.push(e.id);
      }
    }
    for (const e of entries) {
      if (e.protection !== "password" || !e.enc) continue;
      try {
        this.privates.set(e.id, await decryptPrivateKey(e.enc, password));
        unlocked.push(e.id);
      } catch {
        failed.push(e.id);
      }
    }
    if (!master && unlocked.length === 0) {
      throw new KeyringError("Mot de passe du trousseau incorrect.");
    }
    this.touch();
    this.listeners.forEach((cb) => cb());
    return { unlocked, failed, masterUnlocked: master !== null };
  }

  /** Ajoute une clé privée déjà en clair (génération, import) sans redemander le mot de passe. */
  adopt(kid: string, privateHex: string): void {
    this.privates.set(kid, privateHex);
    this.touch();
    this.listeners.forEach((cb) => cb());
  }

  adoptMaster(master: Uint8Array): void {
    this.master = new Uint8Array(master);
    this.touch();
    this.listeners.forEach((cb) => cb());
  }

  private async deriveInto(e: KeyEntry): Promise<boolean> {
    if (!this.master || e.derivationIndex === undefined) return false;
    if (e.type === "identity-ed25519") {
      this.privates.set(e.id, (await deriveEd25519(this.master, e.derivationIndex)).privateKeyHex);
      return true;
    }
    if (e.type === "recipient-p256") {
      this.privates.set(e.id, (await deriveP256(this.master, e.derivationIndex)).privateHex);
      return true;
    }
    return false;
  }
}
