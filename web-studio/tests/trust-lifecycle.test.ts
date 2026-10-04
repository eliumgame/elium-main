import { describe, it, expect, beforeEach } from "vitest";
import {
  trustContact,
  loadTrustBook,
  markContactVerified,
  levelOf,
  kindOf,
  isRecipientKeyHex,
  keyTrustState,
  describeKeyState,
  applySuccession,
  applySuccessionToBook,
  revokeTrustedKey,
  unrevokeTrustedKey,
  loadRevocations,
  currentKeyTrustState,
  withRevocation,
  findRevocation,
  TRUST_LEVEL_LABELS,
  type TrustedContact,
} from "../src/sign/trust-book";
import { checkSealPin } from "../src/sign/seal-pinning";
import { generateIdentity } from "../src/sign/keys";
import { createSuccession } from "../src/sign/succession";
import { generateRecipientKeypair } from "../src/crypto/recipients";
import type { EliumManifest } from "../src/format/types";

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

describe("carnet : niveau, nature, notes", () => {
  it("les anciennes entrées lisent comme « non vérifié » / « signataire »", () => {
    const old: TrustedContact = { name: "Alice", publicKeyHex: KEY_A, fingerprint: "f", addedAt: "t" };
    expect(levelOf(old)).toBe("unverified");
    expect(kindOf(old)).toBe("signer");
    expect(TRUST_LEVEL_LABELS.verified).toBe("Vérifié par mots de sécurité");
  });

  it("ajoute un destinataire P-256 (130 hex) avec niveau/notes, puis le marque vérifié", async () => {
    const rk = await generateRecipientKeypair();
    expect(isRecipientKeyHex(rk.publicHex)).toBe(true);
    await trustContact("Bob", rk.publicHex, { notes: "  rencontré à Lyon ", level: "tofu" });
    let [c] = loadTrustBook();
    expect(c).toMatchObject({ name: "Bob", kind: "recipient", level: "tofu", notes: "rencontré à Lyon" });
    markContactVerified(rk.publicHex, new Date("2026-10-03T00:00:00Z"));
    [c] = loadTrustBook();
    expect(c.level).toBe("verified");
    expect(c.verifiedAt).toBe("2026-10-03T00:00:00.000Z");
    // Renommer ne perd ni le niveau ni la date de vérification.
    await trustContact("Robert", rk.publicHex);
    [c] = loadTrustBook();
    expect(c).toMatchObject({ name: "Robert", level: "verified", kind: "recipient" });
  });

  it("refuse une clé de la mauvaise longueur selon la nature", async () => {
    await expect(trustContact("x", "04" + "a".repeat(10), { kind: "recipient" })).rejects.toThrow(/130/);
    await expect(trustContact("x", "ab", { kind: "signer" })).rejects.toThrow(/64/);
  });
});

describe("révocation, expiration, succession", () => {
  it("keyTrustState : révoquée / expirée / saine", () => {
    const contacts: TrustedContact[] = [
      { name: "A", publicKeyHex: KEY_A, fingerprint: "f", addedAt: "t", expiresAt: "2026-01-01T00:00:00Z" },
    ];
    const now = Date.parse("2026-06-01T00:00:00Z");
    expect(keyTrustState(KEY_A, contacts, [], now).expired).toBe(true);
    expect(keyTrustState(KEY_A, contacts, [], Date.parse("2025-06-01T00:00:00Z")).expired).toBe(false);
    const revs = withRevocation([], { publicKeyHex: KEY_A, revokedAt: "2026-02-01T00:00:00Z", reason: "compromised" });
    expect(keyTrustState(KEY_A, contacts, revs, now).revoked?.reason).toBe("compromised");
    expect(findRevocation(revs, KEY_A.toUpperCase())?.reason).toBe("compromised");
  });

  it("describeKeyState : gravité selon la raison", () => {
    expect(describeKeyState(undefined)).toBeNull();
    expect(describeKeyState({ expired: false })).toBeNull();
    const comp = describeKeyState({
      expired: false,
      revoked: { publicKeyHex: KEY_A, revokedAt: "2026-02-01T00:00:00Z", reason: "compromised" },
    });
    expect(comp?.severity).toBe("danger");
    expect(comp?.text).toContain("RÉVOQUÉE");
    const sup = describeKeyState({
      expired: false,
      revoked: { publicKeyHex: KEY_A, revokedAt: "2026-02-01T00:00:00Z", reason: "superseded", successorKeyHex: "b" },
    });
    expect(sup?.severity).toBe("warning");
    expect(describeKeyState({ expired: true, expiresAt: "2026-01-01T00:00:00Z" })?.text).toContain("expirée");
  });

  it("une succession VÉRIFIÉE transfère le contact (niveau TOFU) et révoque l'ancienne clé comme « remplacée »", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    await trustContact("Alice", a.publicKeyHex, { level: "verified" });
    const cert = await createSuccession({
      oldPrivateKeyHex: a.privateKeyHex!,
      oldPublicKeyHex: a.publicKeyHex,
      newPrivateKeyHex: b.privateKeyHex!,
      newPublicKeyHex: b.publicKeyHex,
    });
    expect(await applySuccessionToBook(cert)).toBe(true);
    const book = loadTrustBook();
    const heir = book.find((c) => c.publicKeyHex === b.publicKeyHex)!;
    expect(heir.name).toBe("Alice");
    expect(heir.level).toBe("tofu"); // la confiance humaine ne se transmet pas
    expect(heir.verifiedAt).toBeUndefined();
    expect(heir.notes).toContain("Succède");
    expect(currentKeyTrustState(a.publicKeyHex).revoked?.reason).toBe("superseded");
    expect(currentKeyTrustState(a.publicKeyHex).revoked?.successorKeyHex).toBe(b.publicKeyHex);
  });

  it("une succession falsifiée ou d'une clé inconnue est refusée sans rien modifier", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const c = await generateIdentity();
    await trustContact("Alice", a.publicKeyHex);
    const cert = await createSuccession({
      oldPrivateKeyHex: a.privateKeyHex!,
      oldPublicKeyHex: a.publicKeyHex,
      newPrivateKeyHex: b.privateKeyHex!,
      newPublicKeyHex: b.publicKeyHex,
    });
    const before = JSON.stringify(loadTrustBook());
    expect(await applySuccession(loadTrustBook(), [], { ...cert, newPublicKeyHex: c.publicKeyHex })).toBeNull();
    const stranger = await createSuccession({
      oldPrivateKeyHex: c.privateKeyHex!,
      oldPublicKeyHex: c.publicKeyHex,
      newPrivateKeyHex: b.privateKeyHex!,
      newPublicKeyHex: b.publicKeyHex,
    });
    expect(await applySuccessionToBook(stranger)).toBe(false);
    expect(JSON.stringify(loadTrustBook())).toBe(before);
    expect(loadRevocations()).toHaveLength(0);
  });

  it("révocation persistante, réversible, et affichée à côté du TOFU (checkSealPin)", async () => {
    revokeTrustedKey(KEY_A, "compromised", " vol du portable ", new Date("2026-03-01T00:00:00Z"));
    expect(loadRevocations()[0]).toMatchObject({ reason: "compromised", note: "vol du portable" });
    const manifest = {
      createdAt: "2026-01-01T00:00:00Z",
      title: "t",
      seal: { fingerprint: "f".repeat(64), publicKeyHex: KEY_A },
    } as unknown as EliumManifest;
    const check = checkSealPin(manifest);
    expect(check.status).toBe("new");
    expect(check.keyState?.revoked?.reason).toBe("compromised");
    unrevokeTrustedKey(KEY_A);
    expect(checkSealPin(manifest).keyState?.revoked).toBeUndefined();
  });
});
