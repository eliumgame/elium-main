import { describe, it, expect } from "vitest";
import {
  authorizationEndpointFrom,
  buildAuthorizationUrl,
  consumeSsoReturn,
  discoveryUrl,
  parseSsoFragment,
  randomState,
  readPending,
  savePending,
  type StorageLike,
} from "../src/drive-cloud/sso-flow";

function mem(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("sso-flow", () => {
  it("construit l'URL de découverte et valide le document", () => {
    expect(discoveryUrl("https://idp.example/")).toBe("https://idp.example/.well-known/openid-configuration");
    const ep = authorizationEndpointFrom(
      { issuer: "https://idp.example", authorization_endpoint: "https://idp.example/auth" },
      "https://idp.example/",
    );
    expect(ep).toBe("https://idp.example/auth");
    expect(() =>
      authorizationEndpointFrom(
        { issuer: "https://evil", authorization_endpoint: "https://evil/a" },
        "https://idp.example",
      ),
    ).toThrow(/émetteur/);
    expect(() =>
      authorizationEndpointFrom({ issuer: "https://i", authorization_endpoint: "http://i/a" }, "https://i"),
    ).toThrow(/https/);
    expect(() => authorizationEndpointFrom(null, "https://i")).toThrow();
  });

  it("construit l'URL d'autorisation implicite", () => {
    const u = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: "https://idp.example/auth",
        clientId: "cid",
        redirectUri: "https://app.example",
        state: "st",
        nonce: "no",
      }),
    );
    expect(u.searchParams.get("response_type")).toBe("id_token");
    expect(u.searchParams.get("scope")).toBe("openid email");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("nonce")).toBe("no");
  });

  it("randomState est URL-safe et variable", () => {
    const a = randomState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(randomState()).not.toBe(a);
  });

  it("extrait le fragment SSO", () => {
    expect(parseSsoFragment("")).toBeNull();
    expect(parseSsoFragment("#section")).toBeNull();
    expect(parseSsoFragment("#id_token=a.b.c&state=s")).toEqual({ idToken: "a.b.c", state: "s", error: null });
    expect(parseSsoFragment("#error=access_denied&state=s")?.error).toBe("access_denied");
  });

  it("valide state, expiration et usage unique", () => {
    const st = mem();
    const pending = { state: "S1", nonce: "N1", orgId: "org", createdAt: 1000 };
    savePending(st, pending);
    expect(readPending(st)).toEqual(pending);
    expect(consumeSsoReturn({ idToken: "t", state: "S1", error: null }, st, 2000)).toEqual({
      idToken: "t",
      nonce: "N1",
      orgId: "org",
    });
    // usage unique
    expect(() => consumeSsoReturn({ idToken: "t", state: "S1", error: null }, st, 2000)).toThrow(/en cours/);
    savePending(st, pending);
    expect(() => consumeSsoReturn({ idToken: "t", state: "autre", error: null }, st, 2000)).toThrow(/état/);
    expect(readPending(st)).toBeNull();
    savePending(st, pending);
    expect(() => consumeSsoReturn({ idToken: "t", state: "S1", error: null }, st, 1000 + 11 * 60 * 1000)).toThrow(
      /expiré/,
    );
    savePending(st, pending);
    expect(() => consumeSsoReturn({ idToken: null, state: "S1", error: "denied" }, st, 2000)).toThrow(/refusé/);
    savePending(st, pending);
    expect(() => consumeSsoReturn({ idToken: null, state: null, error: null }, st, 2000)).toThrow(/état/);
  });
});
