/**
 * Unit tests for OIDC ID-token verification (server/src/lib/oidc.ts).
 * Tokens are minted in-test with Node's crypto (RS256 / ES256 / EdDSA) so the
 * full signature path is exercised — no network, no external IdP.
 */
import { describe, expect, it } from "vitest";
import {
  createSign,
  generateKeyPairSync,
  sign as edSign,
  type KeyObject,
  type JsonWebKey,
} from "node:crypto";
import {
  verifyIdToken,
  verifyIdTokenAsync,
  __clearJwksCache,
  OidcError,
  type OidcConfig,
} from "../src/lib/oidc.js";

const ISS = "https://idp.example.com";
const CLIENT = "elium-client-id";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

type Alg = "RS256" | "ES256" | "EdDSA";

function signInput(alg: Alg, priv: KeyObject, input: Buffer): Buffer {
  if (alg === "EdDSA") return edSign(null, input, priv);
  if (alg === "ES256") return createSign("sha256").update(input).sign({ key: priv, dsaEncoding: "ieee-p1363" });
  return createSign("sha256").update(input).sign(priv);
}

function makeKeys(alg: Alg): { pub: JsonWebKey; priv: KeyObject } {
  const kp =
    alg === "EdDSA"
      ? generateKeyPairSync("ed25519")
      : alg === "ES256"
        ? generateKeyPairSync("ec", { namedCurve: "P-256" })
        : generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { pub: kp.publicKey.export({ format: "jwk" }) as JsonWebKey, priv: kp.privateKey };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function defaultPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const n = nowSec();
  return {
    iss: ISS,
    aud: CLIENT,
    sub: "sub-123",
    email: "Alice@Example.com",
    email_verified: true,
    name: "Alice",
    iat: n,
    nbf: n - 10,
    exp: n + 3600,
    ...over,
  };
}

function makeToken(
  alg: Alg,
  priv: KeyObject,
  payload: Record<string, unknown> = defaultPayload(),
  headerOver: Record<string, unknown> = {},
): string {
  const header = b64url({ alg, typ: "JWT", ...headerOver });
  const body = b64url(payload);
  const input = Buffer.from(`${header}.${body}`);
  const sig = signInput(alg, priv, input).toString("base64url");
  return `${header}.${body}.${sig}`;
}

function cfg(jwks: JsonWebKey[], extra: Partial<OidcConfig> = {}): OidcConfig {
  return { issuer: ISS, clientId: CLIENT, jwks, ...extra };
}

describe.each<Alg>(["RS256", "ES256", "EdDSA"])("valid tokens (%s)", (alg) => {
  it("verifies and returns normalized claims", () => {
    const { pub, priv } = makeKeys(alg);
    const claims = verifyIdToken(makeToken(alg, priv), cfg([pub]));
    expect(claims.sub).toBe("sub-123");
    expect(claims.email).toBe("alice@example.com"); // lower-cased
    expect(claims.emailVerified).toBe(true);
    expect(claims.name).toBe("Alice");
    expect(claims.iss).toBe(ISS);
    expect(claims.aud).toBe(CLIENT);
  });

  it("rejects a tampered signature", () => {
    const { pub, priv } = makeKeys(alg);
    const token = makeToken(alg, priv);
    const [h, p, s] = token.split(".");
    const flipped = s.slice(0, -2) + (s.endsWith("AA") ? "BB" : "AA");
    expect(() => verifyIdToken(`${h}.${p}.${flipped}`, cfg([pub]))).toThrow(OidcError);
  });
});

describe("claim validation", () => {
  const { pub, priv } = makeKeys("ES256");

  it("rejects an unexpected issuer", () => {
    expect(() => verifyIdToken(makeToken("ES256", priv), cfg([pub], { issuer: "https://evil" }))).toThrow(
      /Émetteur/,
    );
  });

  it("rejects an unexpected audience", () => {
    expect(() => verifyIdToken(makeToken("ES256", priv), cfg([pub], { clientId: "other-client" }))).toThrow(
      /Audience/,
    );
  });

  it("accepts an audience array that contains the client id", () => {
    const token = makeToken("ES256", priv, defaultPayload({ aud: ["x", CLIENT] }));
    expect(verifyIdToken(token, cfg([pub])).aud).toBe(CLIENT);
  });

  it("rejects an expired token", () => {
    const token = makeToken("ES256", priv, defaultPayload({ exp: nowSec() - 3600 }));
    expect(() => verifyIdToken(token, cfg([pub]))).toThrow(/expiré/);
  });

  it("rejects a not-yet-valid token (nbf in the future)", () => {
    const token = makeToken("ES256", priv, defaultPayload({ nbf: nowSec() + 3600 }));
    expect(() => verifyIdToken(token, cfg([pub]))).toThrow(/pas encore valide/);
  });

  it("rejects a token without an email", () => {
    const p = defaultPayload();
    delete p.email;
    expect(() => verifyIdToken(makeToken("ES256", priv, p), cfg([pub]))).toThrow(/e-mail/);
  });

  it("enforces the allowed-domains allow-list", () => {
    const allowed = cfg([pub], { allowedDomains: ["example.com"] });
    expect(verifyIdToken(makeToken("ES256", priv), allowed).email).toBe("alice@example.com");
    const other = makeToken("ES256", priv, defaultPayload({ email: "bob@other.org" }));
    expect(() => verifyIdToken(other, allowed)).toThrow(/Domaine/);
  });
});

describe("algorithm confusion resistance", () => {
  const { pub, priv } = makeKeys("ES256");

  it("rejects an unsupported / stripped algorithm (alg:none, HS256)", () => {
    for (const badAlg of ["none", "HS256", "RS1"]) {
      const header = b64url({ alg: badAlg, typ: "JWT" });
      const body = b64url(defaultPayload());
      const token = `${header}.${body}.`; // no/garbage signature
      expect(() => verifyIdToken(token, cfg([pub]))).toThrow(/non supporté/);
    }
  });

  it("rejects a malformed token", () => {
    expect(() => verifyIdToken("a.b", cfg([pub]))).toThrow(/malformé/);
    expect(() => verifyIdToken("!!.??.$$", cfg([pub]))).toThrow(OidcError);
  });

  // Keep priv referenced so the shared key pair is used consistently.
  it("still verifies a normal token from the same key", () => {
    expect(verifyIdToken(makeToken("ES256", priv), cfg([pub])).sub).toBe("sub-123");
  });
});

describe("JWKS key selection by kid", () => {
  it("picks the matching key when several are configured", () => {
    const k1 = makeKeys("RS256");
    const k2 = makeKeys("RS256");
    const jwks: JsonWebKey[] = [
      { ...k1.pub, kid: "k1" } as JsonWebKey,
      { ...k2.pub, kid: "k2" } as JsonWebKey,
    ];
    const token = makeToken("RS256", k2.priv, defaultPayload(), { kid: "k2" });
    expect(verifyIdToken(token, cfg(jwks)).sub).toBe("sub-123");
  });

  it("throws when no JWK matches the token's kid", () => {
    const k1 = makeKeys("RS256");
    const k2 = makeKeys("RS256");
    const jwks: JsonWebKey[] = [
      { ...k1.pub, kid: "k1" } as JsonWebKey,
      { ...k2.pub, kid: "k2" } as JsonWebKey,
    ];
    const token = makeToken("RS256", k2.priv, defaultPayload(), { kid: "unknown" });
    expect(() => verifyIdToken(token, cfg(jwks))).toThrow(/JWKS/);
  });
});

describe("dynamic JWKS (jwksUri)", () => {
  const URI = "https://idp.example.com/.well-known/jwks.json";

  function jwksResponse(keys: JsonWebKey[], cacheControl = "max-age=600"): Response {
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": cacheControl },
    });
  }
  const dynCfg = (): OidcConfig => ({ issuer: ISS, clientId: CLIENT, jwksUri: URI });

  it("fetches keys from the jwksUri, verifies, and caches (one fetch for two tokens)", async () => {
    __clearJwksCache();
    const { pub, priv } = makeKeys("RS256");
    const jwk = { ...pub, kid: "kid-1" } as JsonWebKey;
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jwksResponse([jwk]);
    }) as unknown as typeof fetch;

    const t1 = makeToken("RS256", priv, defaultPayload(), { kid: "kid-1" });
    expect((await verifyIdTokenAsync(t1, dynCfg(), { fetchImpl })).sub).toBe("sub-123");
    const t2 = makeToken("RS256", priv, defaultPayload({ sub: "sub-x" }), { kid: "kid-1" });
    expect((await verifyIdTokenAsync(t2, dynCfg(), { fetchImpl })).sub).toBe("sub-x");
    expect(calls).toBe(1); // second verify served from cache
  });

  it("refetches once on an unknown kid (IdP key rotation) and then verifies", async () => {
    __clearJwksCache();
    const oldK = makeKeys("RS256");
    const newK = makeKeys("RS256");
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? jwksResponse([{ ...oldK.pub, kid: "old" } as JsonWebKey])
        : jwksResponse([{ ...newK.pub, kid: "new" } as JsonWebKey]);
    }) as unknown as typeof fetch;

    // Token signed by the NEW key (kid "new"); the cache initially has only "old".
    const token = makeToken("RS256", newK.priv, defaultPayload(), { kid: "new" });
    expect((await verifyIdTokenAsync(token, dynCfg(), { fetchImpl })).sub).toBe("sub-123");
    expect(calls).toBe(2); // initial fetch + forced refetch after the kid miss
  });

  it("does NOT loop refetching for a genuinely bad signature", async () => {
    __clearJwksCache();
    const good = makeKeys("RS256");
    const evil = makeKeys("RS256");
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jwksResponse([{ ...good.pub, kid: "kid-1" } as JsonWebKey]);
    }) as unknown as typeof fetch;
    // Same kid the JWKS advertises, but signed by a DIFFERENT key → bad signature,
    // not a kid miss, so no refetch storm.
    const token = makeToken("RS256", evil.priv, defaultPayload(), { kid: "kid-1" });
    await expect(verifyIdTokenAsync(token, dynCfg(), { fetchImpl })).rejects.toThrow(/Signature/);
    expect(calls).toBe(1);
  });

  it("falls back to cached keys when the IdP becomes unreachable", async () => {
    __clearJwksCache();
    const { pub, priv } = makeKeys("RS256");
    const jwk = { ...pub, kid: "kid-1" } as JsonWebKey;
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return jwksResponse([jwk]);
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const token = makeToken("RS256", priv, defaultPayload(), { kid: "kid-1" });
    const now1 = 1_000_000;
    expect((await verifyIdTokenAsync(token, dynCfg(), { fetchImpl, now: () => now1 })).sub).toBe("sub-123");
    // Advance past the cache TTL so the next call refetches (and fails), then
    // falls back to the still-present (stale) cache entry.
    const now2 = now1 + 10 * 3600 * 1000;
    expect((await verifyIdTokenAsync(token, dynCfg(), { fetchImpl, now: () => now2 })).sub).toBe("sub-123");
    expect(calls).toBe(2);
  });

  it("throws when neither static keys nor a jwksUri are configured", async () => {
    __clearJwksCache();
    const { priv } = makeKeys("RS256");
    const token = makeToken("RS256", priv);
    await expect(
      verifyIdTokenAsync(token, { issuer: ISS, clientId: CLIENT }),
    ).rejects.toThrow(/Aucune clé/);
  });
});
