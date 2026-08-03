/**
 * Protection par mot de passe des liens de partage : le secret chiffré se
 * redéchiffre avec le bon mot de passe, échoue avec un mauvais, et deux
 * chiffrements du même secret diffèrent (sel + IV aléatoires).
 */
import { describe, it, expect } from "vitest";
import { protectLinkSecret, unprotectLinkSecret } from "../src/drive-cloud/link-password";

const SECRET = "a".repeat(64); // scalaire privé hex (32 octets)

describe("Lien protégé par mot de passe (E2EE)", () => {
  it("chiffre puis redéchiffre avec le bon mot de passe", async () => {
    const blob = await protectLinkSecret("bon-mot-de-passe", SECRET);
    expect(blob.split(".")).toHaveLength(3); // salt.iv.ct
    expect(blob).not.toContain(SECRET); // le secret n'apparaît jamais en clair
    const back = await unprotectLinkSecret("bon-mot-de-passe", blob);
    expect(back).toBe(SECRET);
  });

  it("échoue avec un mauvais mot de passe (AES-GCM rejette)", async () => {
    const blob = await protectLinkSecret("le-vrai", SECRET);
    await expect(unprotectLinkSecret("le-faux", blob)).rejects.toBeDefined();
  });

  it("deux chiffrements du même secret produisent des blobs différents", async () => {
    const a = await protectLinkSecret("pw", SECRET);
    const b = await protectLinkSecret("pw", SECRET);
    expect(a).not.toBe(b); // sel + IV aléatoires
    expect(await unprotectLinkSecret("pw", a)).toBe(SECRET);
    expect(await unprotectLinkSecret("pw", b)).toBe(SECRET);
  });

  it("rejette un blob malformé", async () => {
    await expect(unprotectLinkSecret("pw", "pasunblob")).rejects.toThrow();
  });
});
