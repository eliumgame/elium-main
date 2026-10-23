/**
 * Code d'activation à usage unique (lib/activation.ts) et jauge/garde-fou disque
 * (lib/disk.ts). BD mockée ; statfs injecté.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));

import { query, queryOne } from "../src/db/pool.js";
import { invalidateSiteSettings, defaultSiteSettings } from "../src/lib/site-settings.js";
import {
  consumeActivation,
  ensureActivationCode,
  generateActivationCode,
  isActivationRequired,
  normalizeCode,
  resetActivationLimits,
  verifyActivation,
} from "../src/lib/activation.js";
import { assertDiskSpace, diskMarginBytes, getDiskStats, setStatfsForTests } from "../src/lib/disk.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const GB = 1024 ** 3;

/** Simule site_settings (sans organisation) et la ligne d'activation. */
function db(act: { code_hash: string; expires_at: string; consumed_at: string | null } | null, orgId: string | null = null) {
  mQueryOne.mockImplementation((async (sql: string) => {
    if (sql.includes("FROM site_settings")) return { org_id: orgId, settings: {} };
    if (sql.includes("FROM site_activation")) return act;
    return null;
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSiteSettings();
  resetActivationLimits();
  setStatfsForTests(null);
});

describe("code d'activation", () => {
  it("génère 12 caractères groupés, sans ambiguïté, tous différents d'un tirage à l'autre", () => {
    const a = generateActivationCode();
    expect(a).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){2}$/);
    expect(generateActivationCode()).not.toBe(a);
    expect(normalizeCode("abcd-ef 12")).toBe("ABCDEF12");
  });

  it("ensureActivationCode : ne stocke que l'empreinte (jamais le code), rien si le Drive existe", async () => {
    db(null, null);
    const code = await ensureActivationCode();
    expect(code).toBeTruthy();
    const call = mQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO site_activation"))!;
    const params = call[1] as string[];
    expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(call)).not.toContain(code!);
    invalidateSiteSettings();
    db(null, "00000000-0000-4000-8000-0000000000c1");
    expect(await ensureActivationCode()).toBeNull();
  });

  async function provision() {
    db(null, null);
    const code = (await ensureActivationCode())!;
    const hash = (mQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO site_activation"))![1] as string[])[0]!;
    return { code, hash };
  }

  it("verifyActivation : accepte le bon code (casse/séparateurs tolérés), refuse le reste", async () => {
    const { code, hash } = await provision();
    db({ code_hash: hash, expires_at: new Date(Date.now() + 3600_000).toISOString(), consumed_at: null });
    await expect(verifyActivation(code, "1.1.1.1")).resolves.toBeUndefined();
    await expect(verifyActivation(code.toLowerCase().replace(/-/g, " "), "1.1.1.1")).resolves.toBeUndefined();
    await expect(verifyActivation("AAAA-AAAA-AAAA", "1.1.1.1")).rejects.toMatchObject({ statusCode: 403 });
    await expect(verifyActivation(undefined, "1.1.1.1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuse un code expiré ou déjà consommé", async () => {
    const { code, hash } = await provision();
    db({ code_hash: hash, expires_at: new Date(Date.now() - 1000).toISOString(), consumed_at: null });
    await expect(verifyActivation(code, "1.1.1.1")).rejects.toThrow(/expiré/);
    db({ code_hash: hash, expires_at: new Date(Date.now() + 3600_000).toISOString(), consumed_at: new Date().toISOString() });
    await expect(verifyActivation(code, "1.1.1.1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("anti force brute : 5 échecs verrouillent l'adresse (429), même avec le bon code", async () => {
    const { code, hash } = await provision();
    db({ code_hash: hash, expires_at: new Date(Date.now() + 3600_000).toISOString(), consumed_at: null });
    for (let i = 0; i < 5; i++) await expect(verifyActivation("BBBB-BBBB-BBBB", "9.9.9.9")).rejects.toMatchObject({ statusCode: 403 });
    await expect(verifyActivation(code, "9.9.9.9")).rejects.toMatchObject({ statusCode: 429 });
    // une autre adresse n'est pas touchée
    await expect(verifyActivation(code, "8.8.8.8")).resolves.toBeUndefined();
  });

  it("isActivationRequired : vrai seulement sans Drive et code non consommé", async () => {
    db({ code_hash: "x", expires_at: new Date(Date.now() + 1000).toISOString(), consumed_at: null });
    expect(await isActivationRequired()).toBe(true);
    invalidateSiteSettings();
    db({ code_hash: "x", expires_at: new Date(Date.now() + 1000).toISOString(), consumed_at: new Date().toISOString() });
    expect(await isActivationRequired()).toBe(false);
    invalidateSiteSettings();
    db(null);
    expect(await isActivationRequired()).toBe(false); // pas de code provisionné (tests, dev)
    await consumeActivation();
    expect(mQuery.mock.calls.some((c) => String(c[0]).includes("SET consumed_at"))).toBe(true);
  });
});

describe("disque", () => {
  const fake = (totalGb: number, freeGb: number) =>
    setStatfsForTests(async () => ({ blocks: (totalGb * GB) / 4096, bsize: 4096, bavail: (freeGb * GB) / 4096 }));

  it("marge = le plus grand de X % du disque et du volume fixe", () => {
    const s = { diskMarginPercent: 5, diskMarginBytes: 2 * GB };
    expect(diskMarginBytes(100 * GB, s)).toBe(5 * GB);
    expect(diskMarginBytes(20 * GB, s)).toBe(2 * GB);
    expect(defaultSiteSettings().diskMarginPercent).toBe(5);
  });

  it("getDiskStats lit statfs ; null si la mesure échoue partout", async () => {
    fake(100, 40);
    expect(await getDiskStats()).toEqual({ totalBytes: 100 * GB, freeBytes: 40 * GB });
    setStatfsForTests(async () => {
      throw new Error("ENOENT");
    });
    expect(await getDiskStats()).toBeNull();
  });

  it("assertDiskSpace : 507 sous la marge, passe au-dessus, sans effet si non mesurable", async () => {
    db(null);
    fake(100, 60);
    await expect(assertDiskSpace(1000)).resolves.toBeUndefined();
    fake(100, 4);
    await expect(assertDiskSpace(0)).rejects.toMatchObject({ statusCode: 507 });
    fake(100, 6);
    await expect(assertDiskSpace(2 * GB)).rejects.toMatchObject({ statusCode: 507 });
    setStatfsForTests(async () => {
      throw new Error("x");
    });
    await expect(assertDiskSpace(5 * GB)).resolves.toBeUndefined();
  });
});
