/**
 * `drive-cloud/circuit-sync.ts` — the "circuit not yet synced" marker that
 * makes a failed `syncCircuitForSignRequest`/`alignCircuitWithRequest`
 * (see `parapheur-bridge.test.ts`) survive closing SignRequestDialog, unlike
 * the ephemeral component-local warning it replaces.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getPendingCircuitSync, setPendingCircuitSync, clearPendingCircuitSync } from "../src/drive-cloud/circuit-sync";

// Minimal localStorage shim for the Node test environment (same pattern as
// tests/seal-pinning.test.ts).
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});

describe("circuit-sync (marqueur persistant de resynchronisation en échec)", () => {
  it("n'a rien à signaler tant qu'aucun échec n'a été enregistré", () => {
    expect(getPendingCircuitSync("node-1")).toBeNull();
  });

  it("mémorise un échec et le restitue — survit à un rechargement (nouvelle lecture depuis localStorage)", () => {
    setPendingCircuitSync("node-1", [{ partyId: "p1", label: "Alice" }], "panne réseau");
    const pending = getPendingCircuitSync("node-1");
    expect(pending).not.toBeNull();
    expect(pending!.parties).toEqual([{ partyId: "p1", label: "Alice" }]);
    expect(pending!.lastError).toBe("panne réseau");
    expect(pending!.attempts).toBe(1);
  });

  it("incrémente le compteur de tentatives à chaque nouvel échec, sans perdre les précédentes", () => {
    setPendingCircuitSync("node-1", [{ partyId: "p1" }], "erreur 1");
    setPendingCircuitSync("node-1", [{ partyId: "p1" }], "erreur 2");
    const pending = getPendingCircuitSync("node-1");
    expect(pending!.attempts).toBe(2);
    expect(pending!.lastError).toBe("erreur 2");
  });

  it("garde des marqueurs indépendants par nœud", () => {
    setPendingCircuitSync("node-1", [{ partyId: "p1" }], "erreur A");
    setPendingCircuitSync("node-2", [{ partyId: "p2" }], "erreur B");
    expect(getPendingCircuitSync("node-1")!.lastError).toBe("erreur A");
    expect(getPendingCircuitSync("node-2")!.lastError).toBe("erreur B");
  });

  it("efface le marqueur une fois la resynchronisation réussie — plus rien à afficher", () => {
    setPendingCircuitSync("node-1", [{ partyId: "p1" }], "panne réseau");
    expect(getPendingCircuitSync("node-1")).not.toBeNull();
    clearPendingCircuitSync("node-1");
    expect(getPendingCircuitSync("node-1")).toBeNull();
  });

  it("effacer un nœud sans marqueur ne fait rien (pas d'exception)", () => {
    expect(() => clearPendingCircuitSync("no-such-node")).not.toThrow();
  });

  it("tolère un localStorage indisponible/corrompu (lecture privée, quota, JSON invalide)", () => {
    localStorage.setItem("elium_drive_circuit_sync_v1", "{not-json");
    expect(getPendingCircuitSync("node-1")).toBeNull();
    // Une écriture ultérieure doit pouvoir repartir proprement plutôt que
    // planter sur l'état corrompu précédent.
    expect(() => setPendingCircuitSync("node-1", [{ partyId: "p1" }], "erreur")).not.toThrow();
  });
});
