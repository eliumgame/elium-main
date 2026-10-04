import { describe, it, expect } from "vitest";
import { buildRegistration, buildPasswordChange, unlockAccount, prepareLogin } from "../src/drive-cloud/account";
import { verifyMessage } from "../src/sign/keys";
import { validatePasswordChange } from "../src/drive-cloud/ui/ChangePasswordSection";
import type { KdfParams } from "../src/drive-cloud/kdf";

// Paramètres minimaux : on teste le câblage cryptographique, pas le coût Argon2.
const FAST: KdfParams = { alg: "argon2id", t: 1, m: 8192, p: 1 };

describe("changement de mot de passe du Drive (client)", () => {
  it("ré-enveloppe les MÊMES clés sous le nouveau mot de passe, avec sel et clé d'authentification neufs", async () => {
    const reg = await buildRegistration("alice@example.org", "ancien-mdp", "Alice", FAST);
    const change = await buildPasswordChange({
      email: "alice@example.org",
      currentPassword: "ancien-mdp",
      currentKdfSalt: reg.payload.kdfSalt,
      currentKdfParams: FAST,
      challenge: "ab".repeat(32),
      keys: reg.keys,
      newPassword: "nouveau-mdp-solide",
      newParams: FAST,
    });
    const r = change.request;

    // La signature du défi prouve l'ANCIEN mot de passe (clé d'auth actuelle).
    expect(await verifyMessage(r.signature, "ab".repeat(32), reg.payload.authSignPublicHex)).toBe(true);
    // Sel et clé d'authentification ont changé ; la preuve de possession porte sur la NOUVELLE.
    expect(r.newKdfSalt).not.toBe(reg.payload.kdfSalt);
    expect(r.newAuthSignPublicHex).not.toBe(reg.payload.authSignPublicHex);
    expect(await verifyMessage(r.newAuthSignProof, "alice@example.org", r.newAuthSignPublicHex)).toBe(true);

    // Le nouveau paquet s'ouvre avec le NOUVEAU mot de passe et redonne les mêmes clés privées.
    const nm = await prepareLogin("nouveau-mdp-solide", r.newKdfSalt, r.newKdfParams);
    const reopened = await unlockAccount(r.newKeyBundle, nm.masterKey, {
      ed25519PublicHex: reg.payload.ed25519PublicHex,
      p256PublicHex: reg.payload.p256PublicHex,
      fingerprint: reg.payload.fingerprint,
    });
    expect(reopened.identity.privateKeyHex).toBe(reg.keys.identity.privateKeyHex);
    expect(reopened.recipient.privateHex).toBe(reg.keys.recipient.privateHex);
    expect(Array.from(nm.masterKey)).toEqual(Array.from(change.newMasterKey));

    // L'ancien mot de passe n'ouvre plus le nouveau paquet.
    const old = await prepareLogin("ancien-mdp", r.newKdfSalt, r.newKdfParams);
    await expect(
      unlockAccount(r.newKeyBundle, old.masterKey, {
        ed25519PublicHex: reg.payload.ed25519PublicHex,
        p256PublicHex: reg.payload.p256PublicHex,
        fingerprint: reg.payload.fingerprint,
      }),
    ).rejects.toThrow();
    // Aucun secret en clair dans la requête.
    expect(JSON.stringify(r)).not.toContain(reg.keys.identity.privateKeyHex);
    expect(JSON.stringify(r)).not.toContain("nouveau-mdp-solide");
  }, 60000);

  it("un mauvais mot de passe actuel produit une signature que la clé enregistrée rejette", async () => {
    const reg = await buildRegistration("bob@example.org", "bon-mdp", "Bob", FAST);
    const change = await buildPasswordChange({
      email: "bob@example.org",
      currentPassword: "mauvais",
      currentKdfSalt: reg.payload.kdfSalt,
      currentKdfParams: FAST,
      challenge: "cd".repeat(32),
      keys: reg.keys,
      newPassword: "autre-mdp-12345",
      newParams: FAST,
    });
    expect(await verifyMessage(change.request.signature, "cd".repeat(32), reg.payload.authSignPublicHex)).toBe(false);
  }, 60000);

  it("validatePasswordChange", () => {
    expect(validatePasswordChange("", "abcdefgh", "abcdefgh")).toMatch(/actuel/);
    expect(validatePasswordChange("x", "court", "court")).toMatch(/8 caractères/);
    expect(validatePasswordChange("abcdefgh", "abcdefgh", "abcdefgh")).toMatch(/différer/);
    expect(validatePasswordChange("x", "abcdefgh", "abcdefgX")).toMatch(/confirmation/);
    expect(validatePasswordChange("x", "abcdefgh", "abcdefgh")).toBeNull();
  });
});
