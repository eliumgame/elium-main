/**
 * Secours propriétaire (lib/owner-access.ts) et vérification du second facteur
 * (lib/second-factor.ts) : forme tolérante des codes de secours.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const executed: string[] = [];
vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async (sql: string) => {
    if (sql.includes("FROM site_settings")) return { org_id: "org-1", settings: { mfaPolicy: "required" } };
    if (sql.includes("FROM users WHERE email")) return { id: "u1", email: "boss@acme.fr", mfa_enabled: true, status: "active" };
    return null;
  }),
  withTx: vi.fn(async (fn: (c: { query: (s: string) => Promise<{ rowCount: number }> }) => unknown) =>
    fn({ query: async (s: string) => (executed.push(s), { rowCount: s.includes("webauthn") ? 2 : 1 }) }),
  ),
  closePool: vi.fn(async () => {}),
}));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));

import { query } from "../src/db/pool.js";
import { audit } from "../src/lib/audit.js";
import { invalidateSiteSettings } from "../src/lib/site-settings.js";
import { resetOwnerAccess } from "../src/lib/owner-access.js";
import { normalizeBackupCode } from "../src/lib/second-factor.js";

beforeEach(() => {
  executed.length = 0;
  invalidateSiteSettings();
  vi.clearAllMocks();
});

describe("resetOwnerAccess (secours en ligne de commande)", () => {
  it("désactive la 2FA, retire codes et clés d'accès, révoque les sessions, remet la politique à facultative, journalise", async () => {
    const r = await resetOwnerAccess("boss@acme.fr");
    expect(r).toMatchObject({ email: "boss@acme.fr", hadTotp: true, passkeysRemoved: 2, policyReset: true });
    const all = executed.join("\n");
    expect(all).toContain("mfa_enabled = false");
    expect(all).toContain("DELETE FROM mfa_backup_codes");
    expect(all).toContain("DELETE FROM webauthn_credentials");
    expect(all).toContain("UPDATE sessions SET revoked_at");
    const settingsWrite = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes("INSERT INTO site_settings"));
    expect(JSON.parse((settingsWrite![1] as string[])[0]!).mfaPolicy).toBe("optional");
    expect(vi.mocked(audit)).toHaveBeenCalledWith("org-1", null, "owner.access.reset", "user", "u1", expect.objectContaining({ via: "cli" }), "");
  });
});

describe("normalizeBackupCode", () => {
  it("accepte majuscules, espaces et absence de tiret", () => {
    expect(normalizeBackupCode("ABCD-EFGH")).toBe("abcd-efgh");
    expect(normalizeBackupCode(" abcd efgh ")).toBe("abcd-efgh");
    expect(normalizeBackupCode("abcdefgh")).toBe("abcd-efgh");
    expect(normalizeBackupCode("123456")).toBe("123456");
  });
});
