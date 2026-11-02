/**
 * Passeport E4 et réinitialisation du coffre local : un enregistrement chiffré sous un secret disparu ne doit ni
 * bloquer le coffre (rechiffrement) ni être remplacé en silence par un passeport vide (lecture).
 * Règles pures testées sur des enregistrements construits à la main, sans IndexedDB.
 */
import { describe, expect, it } from "vitest";
import { encryptAtRest, sealBytesAtRest } from "../src/crypto/local-vault";
import { reencryptStoredAnnexe } from "../src/passport/annexes";
import { emptyPassport } from "../src/passport/model";
import {
  PassportLockedError,
  PassportUnreadableError,
  rawPassportExportJson,
  reencryptStoredPassport,
  resolvePassportRecord,
  type StoredPassport,
} from "../src/passport/store";

const OLD = { password: "ancien-mot-de-passe" };
const NEW = { password: "nouveau-mot-de-passe" };
const yes = async () => true;
const no = async () => false;

async function encryptedRecord(): Promise<StoredPassport> {
  const d = emptyPassport();
  d.holder.nom = "Martin";
  return { id: "main", updatedAt: d.updatedAt, vaultProtected: true, enc: await encryptAtRest(d, OLD) };
}

describe("passeport chiffré après réinitialisation du coffre", () => {
  it("un passeport en clair existant reste lisible (compatibilité)", async () => {
    const d = emptyPassport();
    d.holder.nom = "Durand";
    const rec: StoredPassport = { id: "main", updatedAt: d.updatedAt, vaultProtected: false, data: d };
    expect((await resolvePassportRecord(rec, undefined, no))?.holder.nom).toBe("Durand");
  });

  it("coffre configuré mais verrouillé → verrouillé (attente du déverrouillage)", async () => {
    await expect(resolvePassportRecord(await encryptedRecord(), undefined, yes)).rejects.toBeInstanceOf(
      PassportLockedError,
    );
  });

  it("coffre disparu → illisible « no-vault », pas un passeport vide", async () => {
    const err = await resolvePassportRecord(await encryptedRecord(), undefined, no).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PassportUnreadableError);
    expect((err as PassportUnreadableError).reason).toBe("no-vault");
  });

  it("coffre recréé avec un autre mot de passe → illisible « wrong-secret »", async () => {
    const err = await resolvePassportRecord(await encryptedRecord(), NEW, yes).catch((e: unknown) => e);
    expect((err as PassportUnreadableError).reason).toBe("wrong-secret");
  });

  it("le bon secret déchiffre toujours", async () => {
    expect((await resolvePassportRecord(await encryptedRecord(), OLD, yes))?.holder.nom).toBe("Martin");
  });

  it("le rechiffrement laisse intact un enregistrement orphelin au lieu de bloquer le coffre", async () => {
    const rec = await encryptedRecord();
    await expect(reencryptStoredPassport(rec, undefined, NEW)).resolves.toBe("keep"); // activation après reset
    await expect(reencryptStoredPassport(rec, NEW, undefined)).resolves.toBe("keep"); // désactivation, autre secret
  });

  it("le rechiffrement normal fonctionne toujours (ancien → nouveau → clair)", async () => {
    const next = await reencryptStoredPassport(await encryptedRecord(), OLD, NEW);
    expect(next).not.toBe("keep");
    const rec = next as StoredPassport;
    expect(rec.vaultProtected).toBe(true);
    expect((await resolvePassportRecord(rec, NEW, yes))?.holder.nom).toBe("Martin");
    const clear = (await reencryptStoredPassport(rec, NEW, undefined)) as StoredPassport;
    expect(clear.vaultProtected).toBe(false);
    expect(clear.data?.holder.nom).toBe("Martin");
  });

  it("annexe orpheline laissée intacte, annexe lisible rechiffrée", async () => {
    const sealed = await sealBytesAtRest(new Uint8Array([1, 2, 3]), OLD);
    const orphan = { id: "an-1", vaultProtected: true, sealed };
    await expect(reencryptStoredAnnexe(orphan, undefined, NEW)).resolves.toBeNull();
    await expect(reencryptStoredAnnexe(orphan, NEW, undefined)).resolves.toBeNull();
    const ok = await reencryptStoredAnnexe(orphan, OLD, undefined);
    expect(Array.from(ok?.bytes ?? [])).toEqual([1, 2, 3]);
  });

  it("l'export brut garde le chiffré tel quel et sérialise les annexes", async () => {
    const rec = await encryptedRecord();
    const sealed = await sealBytesAtRest(new Uint8Array([9, 9]), OLD);
    const j = JSON.parse(rawPassportExportJson(rec, [{ id: "an-1", vaultProtected: true, sealed }]));
    expect(j.format).toBe("elium-passeport-chiffre");
    expect(j.passport.enc).toBe(rec.enc);
    expect(j.passport.data).toBeUndefined();
    expect(typeof j.annexes[0].sealed.ct).toBe("string");
  });
});
