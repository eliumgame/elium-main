/**
 * Unit tests for the stateless token layer (server/src/lib/tokens.ts).
 * Pure crypto + config; no database required.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueAccessToken,
  verifyAccessToken,
  issueScopedToken,
  verifyScopedToken,
  newRefreshToken,
  hashToken,
} from "../src/lib/tokens.js";
import { sha256Hex } from "../src/lib/crypto-server.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("access tokens", () => {
  it("round-trips and returns the claims", () => {
    const { token, expiresAt } = issueAccessToken("user-1", "fpr-abc");
    expect(token.split(".")).toHaveLength(3);
    const claims = verifyAccessToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("user-1");
    expect(claims!.fpr).toBe("fpr-abc");
    expect(claims!.exp).toBe(expiresAt);
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
  });

  it("rejects a token whose MAC has been tampered with", () => {
    const { token } = issueAccessToken("user-1", "fpr");
    const [h, p] = token.split(".");
    const forged = `${h}.${p}.${"A".repeat(43)}`;
    expect(verifyAccessToken(forged)).toBeNull();
  });

  it("rejects a token whose payload has been swapped (MAC no longer matches)", () => {
    const { token } = issueAccessToken("user-1", "fpr");
    const evil = issueAccessToken("attacker", "fpr");
    const [, , mac] = token.split(".");
    const [eh, ep] = evil.token.split(".");
    // Glue the attacker's header/payload onto the victim's MAC.
    expect(verifyAccessToken(`${eh}.${ep}.${mac}`)).toBeNull();
  });

  it("rejects a malformed token (wrong number of parts)", () => {
    expect(verifyAccessToken("only.two")).toBeNull();
    expect(verifyAccessToken("a.b.c.d")).toBeNull();
    expect(verifyAccessToken("")).toBeNull();
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { token } = issueAccessToken("user-1", "fpr");
    expect(verifyAccessToken(token)).not.toBeNull();
    // Jump past the 15-minute default TTL.
    vi.setSystemTime(new Date("2026-01-01T00:20:00Z"));
    expect(verifyAccessToken(token)).toBeNull();
  });
});

describe("scoped tokens", () => {
  it("verifies only for the matching purpose", () => {
    const token = issueScopedToken("user-1", "mfa");
    expect(verifyScopedToken(token, "mfa")).toBe("user-1");
    expect(verifyScopedToken(token, "password-reset")).toBeNull();
  });

  it("rejects an already-expired scoped token", () => {
    const token = issueScopedToken("user-1", "mfa", -10);
    expect(verifyScopedToken(token, "mfa")).toBeNull();
  });

  it("rejects a tampered scoped token", () => {
    const token = issueScopedToken("user-1", "mfa");
    const [h, p] = token.split(".");
    expect(verifyScopedToken(`${h}.${p}.${"B".repeat(43)}`, "mfa")).toBeNull();
    expect(verifyScopedToken("nope", "mfa")).toBeNull();
  });
});

describe("refresh tokens", () => {
  it("stores only the hash, never the raw value", () => {
    const { raw, hash, expiresAt } = newRefreshToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(hash).toBe(sha256Hex(raw));
    expect(hash).not.toBe(raw);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("produces distinct tokens each call", () => {
    const a = newRefreshToken();
    const b = newRefreshToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it("hashToken is sha256Hex", () => {
    expect(hashToken("value")).toBe(sha256Hex("value"));
  });
});
