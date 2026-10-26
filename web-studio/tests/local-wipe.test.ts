/**
 * `claimLocalWorkspace` est le garde-fou qui empêche qu'un compte voie l'espace
 * de travail local (IndexedDB) d'un AUTRE compte précédemment connecté sur le
 * même navigateur — voir drive-cloud/session.tsx `finishAuth`. Bug réel :
 * déconnexion puis connexion à un compte différent sur le même navigateur
 * laissait les documents du premier compte visibles au second.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { claimLocalWorkspace, wipeLocalWorkspaceData } from "../src/workspace/local-wipe";

// Minimal localStorage shim for the Node test environment (same pattern as
// tests/circuit-sync.test.ts), backed by a plain object so that
// `Object.keys(localStorage)` — used by wipeLocalWorkspaceData for prefixed
// keys — sees real enumerable properties, like a genuine Storage would.
beforeEach(() => {
  const store: Record<string, string> = {};
  // A Proxy over the plain backing object: setItem/getItem/removeItem/clear are
  // intercepted methods, while keys set through them stay real, enumerable
  // properties of `store` — so `Object.keys(localStorage)` (used by
  // wipeLocalWorkspaceData for prefixed keys) sees them like a genuine Storage would.
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

describe("claimLocalWorkspace", () => {
  it("premier usage (aucun propriétaire enregistré) : n'efface rien, enregistre le compte", () => {
    localStorage.setItem("elium_prefs", '{"x":1}');
    expect(claimLocalWorkspace("user-a")).toBe(false);
    expect(localStorage.getItem("elium_prefs")).toBe('{"x":1}');
    expect(localStorage.getItem("elium_local_workspace_owner")).toBe("user-a");
  });

  it("même compte qui se reconnecte : n'efface rien", () => {
    claimLocalWorkspace("user-a");
    localStorage.setItem("elium_prefs", '{"x":1}');
    expect(claimLocalWorkspace("user-a")).toBe(false);
    expect(localStorage.getItem("elium_prefs")).toBe('{"x":1}');
  });

  it("compte DIFFÉRENT : efface les données locales et renvoie true", () => {
    claimLocalWorkspace("user-a");
    localStorage.setItem("elium_prefs", '{"x":1}');
    localStorage.setItem("elium_recent_commands", '["doc-a"]');
    localStorage.setItem("elium_drive_sync_v1:org-a", '{"ready":true}');

    expect(claimLocalWorkspace("user-b")).toBe(true);

    expect(localStorage.getItem("elium_prefs")).toBeNull();
    expect(localStorage.getItem("elium_recent_commands")).toBeNull();
    expect(localStorage.getItem("elium_drive_sync_v1:org-a")).toBeNull();
    // Le nouveau compte est maintenant l'unique propriétaire enregistré.
    expect(localStorage.getItem("elium_local_workspace_owner")).toBe("user-b");
  });

  it("ne touche jamais à la session Drive en cours (jetons du compte qui vient de se connecter)", () => {
    claimLocalWorkspace("user-a");
    localStorage.setItem("elium_drive_session_v1", '{"tokens":"keep-me"}');
    claimLocalWorkspace("user-b");
    expect(localStorage.getItem("elium_drive_session_v1")).toBe('{"tokens":"keep-me"}');
  });
});

describe("wipeLocalWorkspaceData", () => {
  it("efface les préférences locales connues sans lever d'exception (IndexedDB absent en test)", () => {
    localStorage.setItem("elium_theme", "dark");
    localStorage.setItem("elium_view_mode", "grid");
    expect(() => wipeLocalWorkspaceData()).not.toThrow();
    expect(localStorage.getItem("elium_theme")).toBeNull();
    expect(localStorage.getItem("elium_view_mode")).toBeNull();
  });
});
