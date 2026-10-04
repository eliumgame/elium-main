import { describe, it, expect } from "vitest";
import {
  createMemoryStore,
  createMaster,
  generateIdentityKey,
  generateRecipientKey,
  getMasterRecord,
  KeyringError,
} from "../src/crypto/keyring";
import { KeyringSession } from "../src/crypto/keyring-session";
import { buildBackup, importOpenedBundle, restoreFromMaster, RESTORE_SCAN_COUNT } from "../src/crypto/keyring-backup";
import { openKeyBundle } from "../src/crypto/keyfile-v2";
import { masterToPhrase, phraseToMaster } from "../src/crypto/recovery-phrase";
import { splitSecret, combineShares } from "../src/crypto/shamir";
import { encryptForRecipients, decryptWithAnyKey } from "../src/crypto/recipients";
import { signMessage, verifyMessage } from "../src/sign/keys";
import { toHex } from "../src/format/canonical";

async function fixture() {
  const store = createMemoryStore();
  const { master } = await createMaster(store, "pw");
  const ed = await generateIdentityKey(store, master, { label: "Moi" });
  const rc = await generateRecipientKey(store, master);
  const session = new KeyringSession({ idleMinutes: 0 });
  await session.unlockWithMaster(await store.getAll(), master);
  return { store, master, ed, rc, session };
}

describe("sauvegarde .eliumkey v2 du trousseau", () => {
  it("exporte Ed25519 + P-256, marque les clés sauvegardées, et se ré-importe sur un trousseau vierge", async () => {
    const f = await fixture();
    expect((await f.store.getAll()).every((e) => !e.backedUpAt)).toBe(true);
    const file = await buildBackup(f.store, f.session, "pw-sauvegarde");
    expect((await f.store.getAll()).every((e) => !!e.backedUpAt)).toBe(true);
    expect(JSON.stringify(file)).not.toContain(f.ed.privateKeyHex);

    const opened = await openKeyBundle(file, "pw-sauvegarde");
    const fresh = createMemoryStore();
    const res = await importOpenedBundle(fresh, opened, "nouveau-pw");
    expect(res.masterInstalled).toBe(true);
    expect(res.added).toHaveLength(2);
    const imported = await fresh.getAll();
    expect(imported.every((e) => e.protection === "derived" && !!e.backedUpAt)).toBe(true);
    // La clé de réception restaurée déchiffre ce qui lui était destiné.
    const blob = await encryptForRecipients(new TextEncoder().encode("coucou"), [f.rc.entry.publicHex]);
    const s2 = new KeyringSession({ idleMinutes: 0 });
    await s2.unlockWithPassword(fresh, "nouveau-pw");
    const priv = s2.getPrivate(f.rc.entry.id)!;
    expect(
      new TextDecoder().decode(await decryptWithAnyKey(blob, [{ privateHex: priv, publicHex: f.rc.entry.publicHex }])),
    ).toBe("coucou");
    const sig = await signMessage("m", s2.getPrivate(f.ed.entry.id)!);
    expect(await verifyMessage(sig, "m", f.ed.entry.publicHex)).toBe(true);
    // Ré-importer le même fichier ne duplique rien.
    expect((await importOpenedBundle(fresh, opened, "nouveau-pw")).existing).toHaveLength(2);
  }, 60000);

  it("refuse d'exporter une clé verrouillée (pas de sauvegarde partielle silencieuse)", async () => {
    const f = await fixture();
    f.session.lock();
    await expect(buildBackup(f.store, f.session, "x")).rejects.toThrow(KeyringError);
    expect((await f.store.getAll()).every((e) => !e.backedUpAt)).toBe(true);
  }, 30000);

  it("sur un trousseau possédant déjà un maître, les clés importées sont protégées par mot de passe (jamais en clair)", async () => {
    const a = await fixture();
    const file = await buildBackup(a.store, a.session, "bpw");
    const opened = await openKeyBundle(file, "bpw");
    const b = createMemoryStore();
    await createMaster(b, "autre");
    const res = await importOpenedBundle(b, opened, "autre");
    expect(res.masterInstalled).toBe(false);
    const all = await b.getAll();
    expect(all.every((e) => e.protection === "password" && !!e.enc)).toBe(true);
    expect(JSON.stringify(all)).not.toContain(a.ed.privateKeyHex);
    const s = new KeyringSession({ idleMinutes: 0 });
    await s.unlockWithPassword(b, "autre");
    expect(s.getPrivate(a.ed.entry.id)).toBe(a.ed.privateKeyHex);
  }, 60000);
});

describe("récupération depuis le secret maître", () => {
  it("phrase de 24 mots -> même identité et même clé de réception sur machine vierge", async () => {
    const f = await fixture();
    const phrase = masterToPhrase(f.master);
    const store = createMemoryStore();
    const { restored } = await restoreFromMaster(store, phraseToMaster(phrase), "pw-neuf");
    expect(restored.length).toBe(RESTORE_SCAN_COUNT * 2);
    const all = await store.getAll();
    const ed0 = all.find((e) => e.id === f.ed.entry.id)!;
    expect(ed0.status).toBe("active");
    expect(ed0.publicHex).toBe(f.ed.entry.publicHex);
    expect(all.find((e) => e.id === f.rc.entry.id)!.publicHex).toBe(f.rc.entry.publicHex);
    expect((await getMasterRecord(store))!.nextIndex).toEqual({ ed: RESTORE_SCAN_COUNT, p256: RESTORE_SCAN_COUNT });
    const s = new KeyringSession({ idleMinutes: 0 });
    await s.unlockWithPassword(store, "pw-neuf");
    expect(s.getPrivate(f.ed.entry.id)).toBe(f.ed.privateKeyHex);
    expect(s.getPrivate(f.rc.entry.id)).toBe(f.rc.privateHex);
  }, 60000);

  it("parts Shamir 3-sur-5 -> récupération complète, idempotente", async () => {
    const f = await fixture();
    const shares = await splitSecret(f.master, 3, 5);
    const master = await combineShares([shares[4], shares[0], shares[2]]);
    expect(toHex(master)).toBe(toHex(f.master));
    const store = createMemoryStore();
    await restoreFromMaster(store, master, "pw");
    const count = (await store.getAll()).length;
    const again = await restoreFromMaster(store, master, "pw");
    expect(again.restored).toHaveLength(0);
    expect((await store.getAll()).length).toBe(count);
  }, 60000);
});
