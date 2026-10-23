/**
 * Câblage RÉEL du miroir de fichiers locaux (app Windows) sur les magasins de
 * l'application. Choisi à l'exécution par `detectPersistence()` : sur le site
 * (hébergé, PWA, dev) il n'y a pas de miroir, seulement la demande de stockage
 * persistant ; aucun module n'est dupliqué ni modifié.
 */
import type { VaultSecret } from "../crypto/local-vault";
import { loadPassport, savePassport } from "../passport/store";
import type { Catalog } from "../workspace/catalog";
import { createContentIO } from "../workspace/content";
import { FileMirror, type MirrorExtra, type MirrorStatus } from "./file-mirror";
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
    extras: [passportExtra(opts.getSecret)],
    appVersion: typeof __ELIUM_VERSION__ === "string" ? __ELIUM_VERSION__ : undefined,
    onStatus: opts.onStatus,
  });
  try {
    const { restored } = await mirror.start();
    return { mirror, restored };
  } catch (e) {
    opts.onStatus({ state: "error", message: e instanceof Error ? e.message : String(e) });
    return { mirror: null, restored: 0 };
  }
}
