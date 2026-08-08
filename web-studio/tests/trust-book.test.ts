import { describe, it, expect, beforeEach } from "vitest";
import {
  findContact,
  upsertContact,
  withoutContact,
  isTrustKeyHex,
  normalizeKeyHex,
  loadTrustBook,
  trustContact,
  untrustContact,
  attributeKey,
  migrateLegacyTrustedKey,
  type TrustedContact,
} from "../src/sign/trust-book";

// Shim localStorage minimal pour l'environnement Node de vitest.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});

const KEY_A = "aa".repeat(32);
const KEY_B = "bb".repeat(32);

function contact(name: string, publicKeyHex: string): TrustedContact {
  return { name, publicKeyHex, fingerprint: `fp-${publicKeyHex}`, addedAt: "2026-01-01T00:00:00Z" };
}

describe("trust-book — cœur pur", () => {
  it("valide le format d'une clé Ed25519 (64 hex)", () => {
    expect(isTrustKeyHex(KEY_A)).toBe(true);
    expect(isTrustKeyHex(KEY_A.toUpperCase())).toBe(true);
    expect(isTrustKeyHex("  " + KEY_A + "  ")).toBe(true);
    expect(isTrustKeyHex("aa".repeat(31))).toBe(false); // trop court
    expect(isTrustKeyHex("zz".repeat(32))).toBe(false); // non hex
  });

  it("findContact compare la clé sans tenir compte de la casse", () => {
    const list = [contact("Alice", KEY_A)];
    expect(findContact(list, KEY_A.toUpperCase())?.name).toBe("Alice");
    expect(findContact(list, KEY_B)).toBeUndefined();
  });

  it("upsertContact dédoublonne par clé et trie par nom", () => {
    let list = upsertContact([], contact("Bob", KEY_B));
    list = upsertContact(list, contact("Alice", KEY_A));
    expect(list.map((c) => c.name)).toEqual(["Alice", "Bob"]);
    // Même clé, nouveau nom → remplace (pas de doublon).
    list = upsertContact(list, contact("Alice Martin", KEY_A));
    expect(list.filter((c) => c.publicKeyHex === KEY_A)).toHaveLength(1);
    expect(findContact(list, KEY_A)?.name).toBe("Alice Martin");
  });

  it("upsertContact normalise la clé stockée en minuscules", () => {
    const list = upsertContact([], contact("Alice", KEY_A.toUpperCase()));
    expect(list[0]!.publicKeyHex).toBe(KEY_A);
  });

  it("withoutContact retire la bonne entrée", () => {
    const list = [contact("Alice", KEY_A), contact("Bob", KEY_B)];
    expect(withoutContact(list, KEY_A).map((c) => c.name)).toEqual(["Bob"]);
  });
});

describe("trust-book — persistance + attribution", () => {
  it("ajoute, attribue puis retire un contact", async () => {
    expect(loadTrustBook()).toEqual([]);
    await trustContact("Alice", KEY_A);
    expect(attributeKey(KEY_A)?.name).toBe("Alice");
    expect(attributeKey(KEY_A.toUpperCase())?.name).toBe("Alice"); // insensible à la casse
    expect(attributeKey(KEY_B)).toBeUndefined();
    untrustContact(KEY_A);
    expect(attributeKey(KEY_A)).toBeUndefined();
  });

  it("calcule une empreinte réelle (déterministe) à l'ajout", async () => {
    const list = await trustContact("Alice", KEY_A);
    const fp = list[0]!.fingerprint;
    expect(fp).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    // Idempotent : ré-ajouter la même clé garde une seule entrée.
    const again = await trustContact("Alice (bis)", KEY_A);
    expect(again).toHaveLength(1);
    expect(again[0]!.fingerprint).toBe(fp);
  });

  it("rejette une clé mal formée", async () => {
    await expect(trustContact("X", "pas-une-clé")).rejects.toThrow();
  });

  it("migre l'ancienne clé de confiance unique vers un contact nommé, puis l'efface", async () => {
    localStorage.setItem("elium_trusted_key", KEY_A.toUpperCase());
    await migrateLegacyTrustedKey();
    expect(attributeKey(KEY_A)?.name).toBe("Ma clé de confiance");
    expect(localStorage.getItem("elium_trusted_key")).toBeNull();
    // Idempotente : un 2e appel ne recrée rien.
    await migrateLegacyTrustedKey();
    expect(loadTrustBook()).toHaveLength(1);
  });

  it("migration : une clé legacy mal formée est ignorée puis consommée", async () => {
    localStorage.setItem("elium_trusted_key", "bidon");
    await migrateLegacyTrustedKey();
    expect(loadTrustBook()).toEqual([]);
    expect(localStorage.getItem("elium_trusted_key")).toBeNull();
  });

  it("migration : ne duplique pas une clé déjà au carnet", async () => {
    await trustContact("Alice", KEY_A);
    localStorage.setItem("elium_trusted_key", KEY_A);
    await migrateLegacyTrustedKey();
    expect(loadTrustBook()).toHaveLength(1);
    expect(attributeKey(KEY_A)?.name).toBe("Alice"); // nom conservé
  });

  it("normalizeKeyHex trim + minuscules", () => {
    expect(normalizeKeyHex("  ABCD  ")).toBe("abcd");
  });
});
