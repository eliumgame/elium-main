import { describe, it, expect } from "vitest";
import { keyRowModel, checklistItems, checklistSummary } from "../src/crypto/keyring-view-model";
import { recipientCandidates, sanitizeSelection, toggleSelection } from "../src/sign/recipient-picker-model";
import type { KeyEntry } from "../src/crypto/keyring";
import type { TrustedContact, Revocation } from "../src/sign/trust-book";

const entry = (o: Partial<KeyEntry> = {}): KeyEntry => ({
  id: "a".repeat(16),
  type: "recipient-p256",
  suite: "p256-ecdh-es/1",
  label: "k",
  createdAt: "2026-01-01T00:00:00Z",
  status: "active",
  usage: "decrypt",
  publicHex: "04" + "a".repeat(128),
  fingerprint: "a".repeat(64),
  ...o,
});

describe("Mes clés — modèle de ligne", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  it("non sauvegardée = avertissement ; expiration proche signalée ; actions pertinentes", () => {
    const m = keyRowModel(entry({ expiresAt: "2026-06-11T00:00:00Z" }), now);
    expect(m.backupLabel).toBe("Non sauvegardée");
    expect(m.backupTone).toBe("warning");
    expect(m.expiryLabel).toMatch(/Expire dans 10 j/);
    expect(m.can).toMatchObject({ rotate: true, retire: true, reactivate: false, revoke: true });
    const r = keyRowModel(entry({ status: "retired", backedUpAt: "2026-02-01T00:00:00Z" }), now);
    expect(r.backupTone).toBe("success");
    expect(r.can).toMatchObject({ rotate: false, reactivate: true });
    expect(keyRowModel(entry({ status: "revoked" }), now).can.revoke).toBe(false);
    expect(keyRowModel(entry({ expiresAt: "2026-01-01T00:00:00Z" }), now).statusLabel).toBe("Expirée");
  });

  it("checklist de récupération et résumé", () => {
    const base = { backupDone: false, phraseVerified: false, passkeyEnrolled: false, sharesExported: false, score: 0 };
    expect(checklistSummary(base).tone).toBe("danger");
    expect(checklistSummary({ ...base, backupDone: true, score: 1 }).tone).toBe("warning");
    expect(checklistSummary({ ...base, backupDone: true, phraseVerified: true, passkeyEnrolled: true, score: 3 }).tone).toBe("success");
    expect(checklistItems(base).map((i) => i.id)).toEqual(["backup", "phrase", "passkey"]);
  });
});

describe("sélecteur de destinataires", () => {
  const pk = (c: string) => "04" + c.repeat(128 / c.length);
  const contacts: TrustedContact[] = [
    { name: "Zoé", publicKeyHex: pk("b"), fingerprint: "b".repeat(64), addedAt: "t", kind: "recipient", level: "verified" },
    { name: "Alice", publicKeyHex: pk("c"), fingerprint: "c".repeat(64), addedAt: "t", kind: "recipient" },
    { name: "Bob signataire", publicKeyHex: "d".repeat(64), fingerprint: "d".repeat(64), addedAt: "t" },
    { name: "Eve", publicKeyHex: pk("e"), fingerprint: "e".repeat(64), addedAt: "t", kind: "recipient", expiresAt: "2026-01-01T00:00:00Z" },
  ];
  const revs: Revocation[] = [{ publicKeyHex: pk("b"), revokedAt: "2026-02-01T00:00:00Z", reason: "compromised" }];
  const now = Date.parse("2026-06-01T00:00:00Z");

  it("ne propose que des destinataires, triés, avec blocage révoqué/expiré et alerte non vérifié", () => {
    const c = recipientCandidates(contacts, revs, now);
    expect(c.map((x) => x.name)).toEqual(["Alice", "Eve", "Zoé"]);
    expect(c[0].warning).toMatch(/jamais vérifiée/);
    expect(c[1].blockedReason).toBe("clé expirée");
    expect(c[2].blockedReason).toBe("clé révoquée");
    expect(c[0].words.split(" ")).toHaveLength(6);
  });

  it("sanitizeSelection retire bloquées/inconnues/doublons ; toggle", () => {
    const c = recipientCandidates(contacts, revs, now);
    expect(sanitizeSelection([pk("c"), pk("b"), pk("c"), pk("f")], c)).toEqual([pk("c")]);
    expect(toggleSelection([], pk("c"))).toEqual([pk("c")]);
    expect(toggleSelection([pk("c")], pk("c").toUpperCase())).toEqual([]);
  });
});
