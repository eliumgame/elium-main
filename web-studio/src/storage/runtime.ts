/**
 * Câblage RÉEL du miroir de fichiers locaux (app Windows) sur les magasins de
 * l'application. Choisi à l'exécution par `detectPersistence()` : sur le site
 * (hébergé, PWA, dev) il n'y a pas de miroir, seulement la demande de stockage
 * persistant ; aucun module n'est dupliqué ni modifié.
 */
import type { VaultSecret } from "../crypto/local-vault";
import { loadPassport, savePassport } from "../passport/store";
import type { Catalog } from "../workspace/catalog";
import { pickKeys } from "../workspace/backup";
import { SYNC_SETTINGS_KEYS as SETTINGS_KEYS } from "../workspace/drive-sync";
import { createContentIO } from "../workspace/content";
import { EXTRA_PIECES, applyExtra, dumpExtra, packRecords, unpackRecords, type ExtraPiece } from "../workspace/extras";
import { DIRTY_EVENT } from "../workspace/sync-dirty";
import { FileMirror, type MirrorExtra, type MirrorStatus } from "./file-mirror";
import { syncDriveOrigin } from "./drive-origin";
import { detectPersistence, requestPersistentStorage } from "./persistence";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function passportExtra(getSecret: () => VaultSecret | undefined): MirrorExtra {
  return {
    id: "passport",
    dir: "Passeport",
    name: "passeport",
    async read() {
      try {
        const p = await loadPassport(getSecret());
        return p ? enc(JSON.stringify(p)) : undefined;
      } catch {
        return undefined; // coffre verrouillé : pas de miroir pour l'instant
      }
    },
    async write(bytes) {
      await savePassport(JSON.parse(dec(bytes)), getSecret());
    },
    async isEmpty() {
      try {
        return (await loadPassport(getSecret())) === null;
      } catch {
        return false;
      }
    },
  };
}

const idbReq = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

/** Brouillons, historique de versions, polices importées, annexes du passeport, circuits : un fichier par pièce. */
function pieceExtra(p: ExtraPiece): MirrorExtra {
  return {
    id: p.piece,
    dir: "Annexes",
    name: p.piece,
    ext: ".elium-extra",
    merge: true,
    watch: "dirty",
    async read() {
      const rec = await dumpExtra(p);
      return Object.values(rec).some((l) => l.length) ? packRecords(rec) : undefined;
    },
    async write(bytes) {
      await applyExtra(p, await unpackRecords(bytes));
    },
    async isEmpty() {
      const db = await p.open();
      try {
        for (const s of p.stores) {
          if (!db.objectStoreNames.contains(s.name)) continue;
          if ((await idbReq(db.transaction(s.name, "readonly").objectStore(s.name).count())) > 0) return false;
        }
        return true;
      } finally {
        db.close();
      }
    },
  };
}

/** Réglages sans secret (jamais les clés privées ni les identités) ; restauration : clés absentes seulement. */
function settingsExtra(): MirrorExtra {
  const get = (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  return {
    id: "reglages",
    dir: "Annexes",
    name: "reglages",
    merge: true,
    async read() {
      const o = pickKeys(Object.fromEntries(SETTINGS_KEYS.map((k) => [k, get(k)])), SETTINGS_KEYS);
      return Object.keys(o).length ? enc(JSON.stringify(o)) : undefined;
    },
    async write(bytes) {
      const o = pickKeys(JSON.parse(dec(bytes)) as Record<string, string | null>, SETTINGS_KEYS);
      for (const [k, v] of Object.entries(o)) if (get(k) === null) localStorage.setItem(k, v);
    },
    async isEmpty() {
      return SETTINGS_KEYS.every((k) => get(k) === null);
    },
  };
}

/** Démarre le miroir (app Windows) ou demande le stockage persistant (site). Jamais ne lève. */
export async function startStorage(opts: {
  catalog: Catalog;
  getSecret: () => VaultSecret | undefined;
  onStatus: (s: MirrorStatus) => void;
}): Promise<{ mirror: FileMirror | null; restored: number }> {
  const p = await detectPersistence();
  if (p.kind === "idb") {
    void requestPersistentStorage();
    return { mirror: null, restored: 0 };
  }
  // App Windows : autorise l'origine du serveur Drive saisie par l'utilisateur dans la CSP (rechargement unique).
  if ((await syncDriveOrigin()) === "reloaded") return { mirror: null, restored: 0 };
  const mirror = new FileMirror({
    backend: p.backend,
    catalog: opts.catalog,
    contents: createContentIO(opts.getSecret),
    getSecret: opts.getSecret,
    storage: {
      get: (k) => {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      },
      set: (k, v) => localStorage.setItem(k, v),
    },
    extras: [passportExtra(opts.getSecret), ...EXTRA_PIECES.map(pieceExtra), settingsExtra()],
    appVersion: typeof __ELIUM_VERSION__ === "string" ? __ELIUM_VERSION__ : undefined,
    onStatus: opts.onStatus,
  });
  try {
    const { restored } = await mirror.start();
    // Un magasin annexe qui change (brouillon, version, police…) → relu et réécrit au prochain passage.
    const onDirty = (e: Event) => {
      const piece = (e as CustomEvent<{ piece?: string }>).detail?.piece;
      if (piece && EXTRA_PIECES.some((x) => x.piece === piece)) mirror.markDirty(piece);
    };
    window.addEventListener(DIRTY_EVENT, onDirty);
    mirror.onDispose(() => window.removeEventListener(DIRTY_EVENT, onDirty));
    return { mirror, restored };
  } catch (e) {
    opts.onStatus({ state: "error", message: e instanceof Error ? e.message : String(e) });
    return { mirror: null, restored: 0 };
  }
}
