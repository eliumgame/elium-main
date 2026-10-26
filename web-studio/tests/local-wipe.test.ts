/**
 * `claimLocalWorkspace` est le garde-fou qui empêche qu'un compte voie l'espace
 * de travail local (IndexedDB) d'un AUTRE compte précédemment connecté sur le
 * même navigateur — voir drive-cloud/session.tsx `finishAuth`. Bug réel :
 * déconnexion puis connexion à un compte différent sur le même navigateur
 * laissait les documents du premier compte visibles au second.
 *
 * Complété suite au réaudit du 26/10/2026 : inventaire des bases (elium-pdf-ids
 * oublié), suppression réellement attendue (pas fire-and-forget), et profil
 * local pré-existant sans propriétaire enregistré tracé plutôt qu'adopté en
 * silence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimLocalWorkspace, wipeLocalWorkspaceData, LOCAL_WORKSPACE_DATABASES } from "../src/workspace/local-wipe";

// Minimal localStorage shim for the Node test environment (same pattern as
// tests/circuit-sync.test.ts), backed by a plain object so that
// `Object.keys(localStorage)` — used by wipeLocalWorkspaceData for prefixed
// keys — sees real enumerable properties, like a genuine Storage would.
beforeEach(() => {
  const store: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = new Proxy(store, {
    get(target, prop) {
      if (prop === "getItem") return (k: string) => (k in target ? target[k]! : null);
      if (prop === "setItem")
        return (k: string, v: string) => {
          target[k] = v;
        };
      if (prop === "removeItem")
        return (k: string) => {
          delete target[k];
        };
      if (prop === "clear")
        return () => {
          for (const k of Object.keys(target)) delete target[k];
        };
      return target[prop as string];
    },
  });
});

type IdbBehavior = "success" | "error" | "blocked";

/** Fake indexedDB: `databases()` reports a fixed set, `deleteDatabase` settles
 *  asynchronously per-name according to `behavior` (defaults to "success"). */
function installFakeIndexedDB(opts: { existing?: string[]; behavior?: Record<string, IdbBehavior> } = {}) {
  const existing = opts.existing ?? [];
  const calls: string[] = [];
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    databases: async () => existing.map((name) => ({ name, version: 1 })),
    deleteDatabase: (name: string) => {
      calls.push(name);
      const req: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {};
      const behavior = opts.behavior?.[name] ?? "success";
      queueMicrotask(() => {
        if (behavior === "success") req.onsuccess?.();
        else if (behavior === "error") req.onerror?.();
        else req.onblocked?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  };
  return calls;
}

describe("claimLocalWorkspace", () => {
  it("premier usage, espace vide (aucune base présente) : n'efface rien, enregistre le compte", async () => {
    installFakeIndexedDB({ existing: [] });
    localStorage.setItem("elium_prefs", '{"x":1}');
    expect(await claimLocalWorkspace("user-a")).toBe(false);
    expect(localStorage.getItem("elium_prefs")).toBe('{"x":1}');
    expect(localStorage.getItem("elium_local_workspace_owner")).toBe("user-a");
    expect(localStorage.getItem("elium_local_workspace_unverified_claim")).toBeNull();
  });

  it("premier usage, mais des bases existent déjà (profil antérieur à ce mécanisme) : adopte SANS purger, mais trace la réclamation non vérifiée", async () => {
    installFakeIndexedDB({ existing: ["elium-workspace"] });
    localStorage.setItem("elium_prefs", '{"x":1}'); // des préférences existent déjà : ne doivent pas disparaître
    expect(await claimLocalWorkspace("user-a")).toBe(false); // pas de rechargement : rien n'a été détruit
    expect(localStorage.getItem("elium_prefs")).toBe('{"x":1}');
    expect(localStorage.getItem("elium_local_workspace_owner")).toBe("user-a");
    expect(localStorage.getItem("elium_local_workspace_unverified_claim")).toContain("user-a");
  });

  it("même compte qui se reconnecte : n'efface rien", async () => {
    installFakeIndexedDB({ existing: [] });
    await claimLocalWorkspace("user-a");
    localStorage.setItem("elium_prefs", '{"x":1}');
    expect(await claimLocalWorkspace("user-a")).toBe(false);
    expect(localStorage.getItem("elium_prefs")).toBe('{"x":1}');
  });

  it("compte DIFFÉRENT : efface les données locales et renvoie true", async () => {
    installFakeIndexedDB({ existing: [] });
    await claimLocalWorkspace("user-a");
    localStorage.setItem("elium_prefs", '{"x":1}');
    localStorage.setItem("elium_recent_commands", '["doc-a"]');
    localStorage.setItem("elium_drive_sync_v1:org-a", '{"ready":true}');
    localStorage.setItem("elium_identity", '{"legacy":true}');
    localStorage.setItem("elium_drive_prf_v1", '{"wrapped":"..."}');

    expect(await claimLocalWorkspace("user-b")).toBe(true);

    expect(localStorage.getItem("elium_prefs")).toBeNull();
    expect(localStorage.getItem("elium_recent_commands")).toBeNull();
    expect(localStorage.getItem("elium_drive_sync_v1:org-a")).toBeNull();
    expect(localStorage.getItem("elium_identity")).toBeNull();
    expect(localStorage.getItem("elium_drive_prf_v1")).toBeNull();
    // Le nouveau compte est maintenant l'unique propriétaire enregistré.
    expect(localStorage.getItem("elium_local_workspace_owner")).toBe("user-b");
  });

  it("ne touche jamais à la session Drive en cours (jetons du compte qui vient de se connecter)", async () => {
    installFakeIndexedDB({ existing: [] });
    await claimLocalWorkspace("user-a");
    localStorage.setItem("elium_drive_session_v1", '{"tokens":"keep-me"}');
    await claimLocalWorkspace("user-b");
    expect(localStorage.getItem("elium_drive_session_v1")).toBe('{"tokens":"keep-me"}');
  });
});

describe("wipeLocalWorkspaceData", () => {
  it("efface les préférences locales connues sans lever d'exception", async () => {
    installFakeIndexedDB({ existing: [] });
    localStorage.setItem("elium_theme", "dark");
    localStorage.setItem("elium_view_mode", "grid");
    await expect(wipeLocalWorkspaceData()).resolves.toBeUndefined();
    expect(localStorage.getItem("elium_theme")).toBeNull();
    expect(localStorage.getItem("elium_view_mode")).toBeNull();
  });

  it("supprime TOUTES les bases de l'inventaire, y compris elium-pdf-ids (identités PDF)", async () => {
    const calls = installFakeIndexedDB({ existing: [] });
    await wipeLocalWorkspaceData();
    expect(calls).toContain("elium-pdf-ids");
    expect(new Set(calls)).toEqual(new Set(LOCAL_WORKSPACE_DATABASES));
  });

  it("n'avance qu'après succès RÉEL de chaque suppression (pas fire-and-forget)", async () => {
    let resolved = false;
    installFakeIndexedDB({ existing: [] });
    const p = wipeLocalWorkspaceData().then(() => {
      resolved = true;
    });
    // Juste après l'appel, les suppressions (microtâches) n'ont pas encore pu régler.
    expect(resolved).toBe(false);
    await p;
    expect(resolved).toBe(true);
  });

  it("une base bloquée par un autre onglet n'est pas traitée comme un succès silencieux immédiat", async () => {
    vi.useFakeTimers();
    try {
      installFakeIndexedDB({ existing: [], behavior: { "elium-drive": "blocked" } });
      let resolved = false;
      const p = wipeLocalWorkspaceData().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(resolved).toBe(false); // toujours en attente du délai de blocage
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      expect(resolved).toBe(true); // finit par avancer après le délai, sans bloquer indéfiniment
    } finally {
      vi.useRealTimers();
    }
  });
});
