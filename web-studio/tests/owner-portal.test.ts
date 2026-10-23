/**
 * Portail du propriétaire — logique pure côté client : garde d'authentification
 * (pages publiques exemptées), formatage des volumes, libellé d'appareil,
 * longueur minimale du mot de passe pilotée par la politique du site.
 */
import { describe, expect, it } from "vitest";
import { isPublicEntry } from "../src/drive-cloud/ui/SiteGate";
import { formatBytes } from "../src/drive-cloud/ui/OwnerPortal";
import { describeDevice } from "../src/drive-cloud/ui/DevicesSection";
import { validatePasswordChange } from "../src/drive-cloud/ui/ChangePasswordSection";
import { DriveApi } from "../src/drive-cloud/api";

describe("garde d'authentification : pages publiques", () => {
  it("laisse passer lien de partage, demande de signature et présentateur", () => {
    expect(isPublicEntry("?link=abc")).toBe(true);
    expect(isPublicEntry("?sign=abc&party=p1")).toBe(true);
    expect(isPublicEntry("?presenter=1")).toBe(true);
  });
  it("bloque tout le reste (accueil, invitation, paramètres inconnus)", () => {
    expect(isPublicEntry("")).toBe(false);
    expect(isPublicEntry("?invite=xyz")).toBe(false);
    expect(isPublicEntry("?presenter=0")).toBe(false);
    expect(isPublicEntry("?link=")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("choisit l'unité lisible", () => {
    expect(formatBytes(512)).toBe("512 o");
    expect(formatBytes(1024 * 1024)).toBe("1.0 Mo");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 Go");
    expect(formatBytes(120 * 1024 ** 2)).toBe("120 Mo");
  });
});

describe("describeDevice", () => {
  it("reconnaît navigateur et système", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120 Safari/537")).toBe("Chrome sur Windows");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120")).toBe("Edge sur Windows");
    expect(describeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:1) Firefox/120")).toBe("Firefox sur Linux");
    expect(describeDevice("")).toBe("Navigateur");
  });
});

describe("longueur minimale du mot de passe (politique du site)", () => {
  it("applique le minimum du site, 8 par défaut", () => {
    expect(validatePasswordChange("old-password", "short123", "short123")).toBeNull();
    expect(validatePasswordChange("old-password", "short123", "short123", 12)).toMatch(/au moins 12/);
    expect(validatePasswordChange("old-password", "a-much-longer-pass", "a-much-longer-pass", 12)).toBeNull();
  });
});

describe("DriveApi.sitePolicy", () => {
  const base = "http://x/api";
  it("renvoie null hors site déployé (404, HTML, réseau) → mode local", async () => {
    const real = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("<html></html>", { status: 404 })) as typeof fetch;
      expect(await new DriveApi({ baseUrl: base }).sitePolicy()).toBeNull();
      globalThis.fetch = (async () => new Response("<html>spa</html>", { status: 200 })) as typeof fetch;
      expect(await new DriveApi({ baseUrl: base }).sitePolicy()).toBeNull();
      globalThis.fetch = (async () => {
        throw new TypeError("network");
      }) as typeof fetch;
      expect(await new DriveApi({ baseUrl: base }).sitePolicy()).toBeNull();
    } finally {
      globalThis.fetch = real;
    }
  });
  it("renvoie la politique quand le serveur répond", async () => {
    const real = globalThis.fetch;
    try {
      const policy = { deployed: true, bootstrapped: true, signupMode: "invite", mfaPolicy: "required", passwordMinLength: 12, backupRequired: true, siteName: "Acme" };
      globalThis.fetch = (async () => new Response(JSON.stringify(policy), { status: 200 })) as typeof fetch;
      expect(await new DriveApi({ baseUrl: base }).sitePolicy()).toMatchObject({ signupMode: "invite", passwordMinLength: 12 });
    } finally {
      globalThis.fetch = real;
    }
  });
});
