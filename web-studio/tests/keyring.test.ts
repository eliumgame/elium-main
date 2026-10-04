import { describe, it, expect } from "vitest";
import {
  createMemoryStore,
  migrateLegacy,
  mirrorLegacy,
  createMaster,
  generateIdentityKey,
  generateRecipientKey,
  rotateIdentityKey,
  rotateRecipientKey,
  retireKey,
  revokeKey,
  reactivateKey,
  setKeyExpiry,
  deleteKey,
  markBackedUp,
  effectiveStatus,
  activeEntry,
  decryptCandidates,
  recoveryChecklist,
  getMasterRecord,
  importKey,
  toBundleMeta,
  fromBundleKey,
  KeyringError,
  type LegacyStorage,
  type KeyEntry,
} from "../src/crypto/keyring";
import { KeyringSession, loadIdleMinutes, saveIdleMinutes, DEFAULT_IDLE_MINUTES } from "../src/crypto/keyring-session";
import { changeKeyringPassword } from "../src/crypto/keyring-password";
import { generateIdentity } from "../src/sign/keys";
import { encryptPrivateKey } from "../src/sign/identity-store";
import { verifySuccession } from "../src/sign/succession";
import { generateRecipientKeypair, recipientFingerprint, encryptForRecipients, decryptWithAnyKey } from "../src/crypto/recipients";
import { buildKeyBundle, openKeyBundle } from "../src/crypto/keyfile-v2";

function fakeStorage(init: Record<string, string> = {}): LegacyStorage & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

async function legacyFixture(password = "legacy-pw") {
  const id = await generateIdentity();
  const enc = await encryptPrivateKey(id.privateKeyHex!, password);
  const rk = await generateRecipientKeypair();
  const rEnc = await encryptPrivateKey(rk.privateHex, password);
  const rFpr = await recipientFingerprint(rk.publicHex);
  const storage = fakeStorage({
    elium_identity: JSON.stringify({ publicKeyHex: id.publicKeyHex, fingerprint: id.fingerprint, enc }),
    elium_recipient_key: JSON.stringify({ publicHex: rk.publicHex, fingerprint: rFpr, enc: rEnc }),
  });
  return { id, rk, enc, rEnc, storage, rFpr };
}

describe("migration depuis le stockage historique", () => {
  it("migre identité + clé de réception sans rien supprimer, et reste idempotente", async () => {
    const f = await legacyFixture();
    const before = f.storage.dump();
    const store = createMemoryStore();
    expect(await migrateLegacy(store, f.storage)).toBe(2);
    expect(await migrateLegacy(store, f.storage)).toBe(0);
    expect(await migrateLegacy(store, f.storage)).toBe(0);
    expect(f.storage.dump()).toEqual(before); // l'ancien stockage est INTACT
    const all = await store.getAll();
    expect(all).toHaveLength(2);
    const ed = all.find((e) => e.type === "identity-ed25519")!;
    expect(ed.enc).toBe(f.enc);
    expect(ed.id).toBe(f.id.fingerprint.slice(0, 16));
    expect(ed.protection).toBe("password");
    expect(all.find((e) => e.type === "recipient-p256")!.enc).toBe(f.rEnc);
  }, 30000);

  it("ignore les entrées corrompues sans planter ni perdre le reste", async () => {
    const f = await legacyFixture();
    const s = fakeStorage({
      elium_identity: "{pas du json",
      elium_recipient_key: f.storage.getItem("elium_recipient_key")!,
    });
    const store = createMemoryStore();
    expect(await migrateLegacy(store, s)).toBe(1);
    expect((await store.getAll())[0].type).toBe("recipient-p256");
    expect(s.getItem("elium_identity")).toBe("{pas du json"); // jamais supprimé
  }, 30000);

  it("une clé déjà au trousseau n'est pas dupliquée", async () => {
    const f = await legacyFixture();
    const store = createMemoryStore();
    await migrateLegacy(store, f.storage);
    const ed = (await store.getAll()).find((e) => e.type === "identity-ed25519")!;
    await store.put({ ...ed, label: "Renommée" });
    await migrateLegacy(store, f.storage);
    expect((await store.getAll()).find((e) => e.id === ed.id)!.label).toBe("Renommée");
  }, 30000);

  it("mirrorLegacy réécrit la clé active et efface quand il n'y en a plus", async () => {
    const f = await legacyFixture();
    const store = createMemoryStore();
    await migrateLegacy(store, f.storage);
    const out = fakeStorage();
    await mirrorLegacy(store, out);
    expect(JSON.parse(out.getItem("elium_identity")!).publicKeyHex).toBe(f.id.publicKeyHex);
    for (const e of await store.getAll()) await store.remove(e.id);
    await mirrorLegacy(store, out);
    expect(out.getItem("elium_identity")).toBeNull();
    expect(out.getItem("elium_recipient_key")).toBeNull();
  }, 30000);
});

describe("statuts, expiration, suppression", () => {
  const mk = (over: Partial<KeyEntry> = {}): KeyEntry => ({
    id: "aaaaaaaaaaaaaaaa",
    type: "identity-ed25519",
    suite: "ed25519/1",
    label: "x",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    usage: "sign",
    publicHex: "a".repeat(64),
    fingerprint: "a".repeat(64),
    ...over,
  });

  it("effectiveStatus : expirée est calculée, retirée/révoquée priment", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    expect(effectiveStatus(mk({ expiresAt: "2026-05-01T00:00:00Z" }), now)).toBe("expired");
    expect(effectiveStatus(mk({ expiresAt: "2027-05-01T00:00:00Z" }), now)).toBe("active");
    expect(effectiveStatus(mk({ status: "revoked", expiresAt: "2026-05-01T00:00:00Z" }), now)).toBe("revoked");
  });

  it("activeEntry ignore les clés expirées/retirées et prend la plus récente", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    const list = [
      mk({ id: "1", createdAt: "2026-01-01T00:00:00Z" }),
      mk({ id: "2", createdAt: "2026-03-01T00:00:00Z" }),
      mk({ id: "3", createdAt: "2026-04-01T00:00:00Z", expiresAt: "2026-05-01T00:00:00Z" }),
      mk({ id: "4", createdAt: "2026-05-01T00:00:00Z", status: "retired" }),
    ];
    expect(activeEntry(list, "identity-ed25519", now)?.id).toBe("2");
  });

  it("deleteKey exige une sauvegarde (ou une perte reconnue explicitement)", async () => {
    const store = createMemoryStore();
    await store.put(mk());
    await expect(deleteKey(store, "aaaaaaaaaaaaaaaa")).rejects.toThrow(KeyringError);
    expect(await store.getAll()).toHaveLength(1);
    await markBackedUp(store, ["aaaaaaaaaaaaaaaa"]);
    await deleteKey(store, "aaaaaaaaaaaaaaaa");
    expect(await store.getAll()).toHaveLength(0);
    await store.put(mk());
    await deleteKey(store, "aaaaaaaaaaaaaaaa", { acknowledgeLoss: true });
    expect(await store.getAll()).toHaveLength(0);
  });

  it("retire / révoque / réactive / expiration", async () => {
    const store = createMemoryStore();
    await store.put(mk());
    expect((await retireKey(store, "aaaaaaaaaaaaaaaa")).status).toBe("retired");
    expect((await reactivateKey(store, "aaaaaaaaaaaaaaaa")).status).toBe("active");
    expect((await setKeyExpiry(store, "aaaaaaaaaaaaaaaa", "2030-01-01T00:00:00Z")).expiresAt).toBe("2030-01-01T00:00:00Z");
    expect((await setKeyExpiry(store, "aaaaaaaaaaaaaaaa", null)).expiresAt).toBeUndefined();
    expect((await revokeKey(store, "aaaaaaaaaaaaaaaa")).status).toBe("revoked");
    await expect(reactivateKey(store, "aaaaaaaaaaaaaaaa")).rejects.toThrow(KeyringError);
  });

  it("recoveryChecklist : sauvegarde, phrase vérifiée, passkey", () => {
    const e = mk();
    const rec = { v: 1 as const, createdAt: "x", passkeys: [], nextIndex: { ed: 0, p256: 0 } };
    expect(recoveryChecklist([e], rec).score).toBe(0);
    expect(recoveryChecklist([{ ...e, backedUpAt: "t" }], { ...rec, phraseVerifiedAt: "t" }).score).toBe(2);
    const full = recoveryChecklist(
      [{ ...e, backedUpAt: "t" }],
      { ...rec, phraseVerifiedAt: "t", passkeys: [{} as never] },
    );
    expect(full).toMatchObject({ backupDone: true, phraseVerified: true, passkeyEnrolled: true, score: 3 });
    // Une clé révoquée n'empêche pas « sauvegarde faite ».
    expect(recoveryChecklist([{ ...e, backedUpAt: "t" }, mk({ id: "2", status: "revoked" })], rec).backupDone).toBe(true);
  });
});

describe("secret maître, clés dérivées et rotation", () => {
  it("génère identité + réception dérivées, rotation d'identité avec succession vérifiable", async () => {
    const store = createMemoryStore();
    const { master } = await createMaster(store, "pw-maitre");
    const a = await generateIdentityKey(store, master, { label: "Moi" });
    expect(a.entry.derivationIndex).toBe(0);
    expect((await getMasterRecord(store))!.nextIndex.ed).toBe(1);
    const r = await generateRecipientKey(store, master);
    expect(r.entry.protection).toBe("derived");

    const rot = await rotateIdentityKey(store, master, a);
    expect(rot.entry.derivationIndex).toBe(1);
    expect(await verifySuccession(rot.succession)).toBe(true);
    expect(rot.succession.oldPublicKeyHex).toBe(a.entry.publicHex);
    const all = await store.getAll();
    expect(all.find((e) => e.id === a.entry.id)!.status).toBe("retired");
    expect(activeEntry(all, "identity-ed25519")!.id).toBe(rot.entry.id);
    expect(all.find((e) => e.id === rot.entry.id)!.succession).toEqual(rot.succession);
  }, 30000);

  it("rotation de la clé de réception : l'ancienne reste dans la liste de déchiffrement", async () => {
    const store = createMemoryStore();
    const { master } = await createMaster(store, "pw");
    const old = await generateRecipientKey(store, master);
    const blob = await encryptForRecipients(new TextEncoder().encode("ancien"), [old.entry.publicHex]);
    const rot = await rotateRecipientKey(store, master, old.entry);
    const cands = decryptCandidates(await store.getAll());
    expect(cands[0].id).toBe(rot.entry.id);
    expect(cands.map((c) => c.id)).toContain(old.entry.id);
    const out = await decryptWithAnyKey(blob, [
      { privateHex: rot.privateHex, publicHex: rot.entry.publicHex },
      { privateHex: old.privateHex, publicHex: old.entry.publicHex },
    ]);
    expect(new TextDecoder().decode(out)).toBe("ancien");
  }, 30000);

  it("une sauvegarde v2 exportée depuis le trousseau se ré-importe à l'identique", async () => {
    const store = createMemoryStore();
    const { master } = await createMaster(store, "pw");
    const a = await generateIdentityKey(store, master);
    const r = await generateRecipientKey(store, master);
    const bundle = await buildKeyBundle(
      [
        { meta: toBundleMeta(a.entry), privateHex: a.privateKeyHex },
        { meta: toBundleMeta(r.entry), privateHex: r.privateHex },
      ],
      "pw-export",
      master,
    );
    const opened = await openKeyBundle(bundle, "pw-export");
    const store2 = createMemoryStore();
    for (const k of opened.keys) expect(await importKey(store2, fromBundleKey(k, "derived"))).toBe("added");
    expect(await importKey(store2, fromBundleKey(opened.keys[0], "derived"))).toBe("exists");
    expect((await store2.getAll()).map((e) => e.id).sort()).toEqual([a.entry.id, r.entry.id].sort());
  }, 30000);
});

describe("session : un seul mot de passe, verrouillage", () => {
  it("un mot de passe déverrouille identité ET réception héritées ; lock() efface tout", async () => {
    const f = await legacyFixture("meme-mdp");
    const store = createMemoryStore();
    await migrateLegacy(store, f.storage);
    const s = new KeyringSession({ idleMinutes: 0 });
    let locks = 0;
    s.onChange(() => void locks++);
    const res = await s.unlockWithPassword(store, "meme-mdp");
    expect(res.unlocked).toHaveLength(2);
    expect(res.failed).toHaveLength(0);
    expect(s.getPrivate(f.id.fingerprint.slice(0, 16))).toBe(f.id.privateKeyHex);
    expect(s.getPrivate(f.rFpr.slice(0, 16))).toBe(f.rk.privateHex);
    s.lock();
    expect(s.unlocked).toBe(false);
    expect(s.getPrivate(f.id.fingerprint.slice(0, 16))).toBeUndefined();
    expect(locks).toBeGreaterThanOrEqual(2);
  }, 30000);

  it("signale les clés héritées protégées par un autre mot de passe, et refuse un mauvais mot de passe", async () => {
    const f = await legacyFixture("mdp-A");
    const other = await encryptPrivateKey(f.rk.privateHex, "mdp-B");
    f.storage.setItem(
      "elium_recipient_key",
      JSON.stringify({ publicHex: f.rk.publicHex, fingerprint: f.rFpr, enc: other }),
    );
    const store = createMemoryStore();
    await migrateLegacy(store, f.storage);
    const s = new KeyringSession({ idleMinutes: 0 });
    const res = await s.unlockWithPassword(store, "mdp-A");
    expect(res.unlocked).toEqual([f.id.fingerprint.slice(0, 16)]);
    expect(res.failed).toEqual([f.rFpr.slice(0, 16)]);
    const s2 = new KeyringSession({ idleMinutes: 0 });
    await expect(s2.unlockWithPassword(store, "faux")).rejects.toThrow(KeyringError);
    expect(s2.unlocked).toBe(false);
  }, 60000);

  it("verrouille automatiquement après inactivité (minuteur injecté) et touch() le repousse", async () => {
    const store = createMemoryStore();
    const { master } = await createMaster(store, "pw");
    const a = await generateIdentityKey(store, master);
    const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
    const s = new KeyringSession({
      idleMinutes: 15,
      setTimer: (fn, ms) => {
        const t = { fn, ms, id: timers.length, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => void ((h as { live: boolean }).live = false),
    });
    await s.unlockWithMaster(await store.getAll(), master);
    expect(s.getPrivate(a.entry.id)).toBe(a.privateKeyHex);
    const live = () => timers.filter((t) => t.live);
    expect(live()).toHaveLength(1);
    expect(live()[0].ms).toBe(15 * 60_000);
    s.touch(); // réarme : une seule minuterie vivante
    expect(live()).toHaveLength(1);
    live()[0].fn(); // le délai expire
    expect(s.unlocked).toBe(false);
    expect(s.getMaster()).toBeNull();
    // idle = 0 : jamais de minuterie
    const never = new KeyringSession({ idleMinutes: 0, setTimer: () => { throw new Error("pas de minuterie"); } });
    await never.unlockWithMaster(await store.getAll(), master);
    expect(never.unlocked).toBe(true);
  }, 30000);

  it("réglage d'inactivité : défaut 15 min, valeurs invalides ignorées", () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(loadIdleMinutes(st)).toBe(DEFAULT_IDLE_MINUTES);
    saveIdleMinutes(st, 5);
    expect(loadIdleMinutes(st)).toBe(5);
    saveIdleMinutes(st, 0);
    expect(loadIdleMinutes(st)).toBe(0);
    m.set("elium_keyring_idle_min", "abc");
    expect(loadIdleMinutes(st)).toBe(DEFAULT_IDLE_MINUTES);
  });

  it("changeKeyringPassword ré-enveloppe tout, refuse l'ancien mot de passe erroné sans rien écrire", async () => {
    const f = await legacyFixture("ancien");
    const store = createMemoryStore();
    await migrateLegacy(store, f.storage);
    const { master } = await createMaster(store, "ancien");
    const snapshot = JSON.stringify(await store.getAll());
    await expect(changeKeyringPassword(store, "mauvais", "nouveau")).rejects.toThrow(KeyringError);
    expect(JSON.stringify(await store.getAll())).toBe(snapshot);

    const res = await changeKeyringPassword(store, "ancien", "nouveau");
    expect(res.masterRewrapped).toBe(true);
    expect(res.rewrapped).toHaveLength(2);
    const s = new KeyringSession({ idleMinutes: 0 });
    const un = await s.unlockWithPassword(store, "nouveau");
    expect(un.unlocked).toHaveLength(2);
    expect(Array.from(s.getMaster()!)).toEqual(Array.from(master));
    await expect(new KeyringSession({ idleMinutes: 0 }).unlockWithPassword(store, "ancien")).rejects.toThrow();
  }, 120000);
});
