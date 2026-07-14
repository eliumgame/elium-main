import { describe, it, expect, beforeEach } from "vitest";
import { checkSealPin, pinSeal, repinSeal, forgetSealPin } from "../src/sign/seal-pinning";
import type { EliumManifest } from "../src/format/types";

// Minimal localStorage shim for the Node test environment.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});

function manifest(pub: string, createdAt = "2026-01-01T00:00:00Z"): EliumManifest {
  return {
    format: "elium",
    formatVersion: 4,
    profile: "signed",
    generator: "test",
    createdAt,
    modifiedAt: createdAt,
    title: "Contrat",
    language: "fr",
    protection: { encrypted: false, locked: false, keyfileRequired: false, contentEntry: "content/document.json" },
    integrity: { algorithm: "sha-256", contentHash: "ab".repeat(32) },
    features: { signatures: true, tracking: false, resources: 0 },
    rgpd: { localOnly: true, storedPersonalData: [], notice: "" },
    seal: { alg: "ed25519", publicKeyHex: pub, fingerprint: `fp-${pub}`, sealedAt: createdAt, signatureHex: "00" },
  } as EliumManifest;
}

describe("seal TOFU pinning", () => {
  it("reports 'none' when the document is not sealed", () => {
    const m = manifest("aa".repeat(32));
    delete m.seal;
    expect(checkSealPin(m).status).toBe("none");
  });

  it("first sight is 'new', then 'pinned' for the same key", () => {
    const m = manifest("aa".repeat(32));
    expect(checkSealPin(m).status).toBe("new");
    pinSeal(m);
    expect(checkSealPin(m).status).toBe("pinned");
  });

  it("flags a key change as 'changed' for the same document identity", () => {
    const original = manifest("aa".repeat(32));
    pinSeal(original);
    const attacker = manifest("bb".repeat(32)); // same createdAt, different seal key
    const check = checkSealPin(attacker);
    expect(check.status).toBe("changed");
    expect(check.pinned?.publicKeyHex).toBe("aa".repeat(32));
    expect(check.current?.publicKeyHex).toBe("bb".repeat(32));
  });

  it("a genuinely different document (new createdAt) is 'new', not 'changed'", () => {
    pinSeal(manifest("aa".repeat(32), "2026-01-01T00:00:00Z"));
    expect(checkSealPin(manifest("cc".repeat(32), "2026-09-09T09:09:09Z")).status).toBe("new");
  });

  it("repin accepts the new key; forget clears the pin", () => {
    const original = manifest("aa".repeat(32));
    pinSeal(original);
    const changed = manifest("bb".repeat(32));
    repinSeal(changed);
    expect(checkSealPin(changed).status).toBe("pinned");
    forgetSealPin(changed);
    expect(checkSealPin(changed).status).toBe("new");
  });
});
