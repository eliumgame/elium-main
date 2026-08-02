/**
 * WebAuthn (2e facteur) — plomberie du module : génération d'options (défi
 * présent, rpID correct), présence de clés (hasWebauthn), et refus d'une
 * vérification sans défi stocké. Les cérémonies cryptographiques complètes
 * (attestation/assertion réelles) sont couvertes par @simplewebauthn ; ici on
 * mocke la base pour tester notre intégration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const q = { rows: [] as unknown[], one: null as unknown };
vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(async () => q.rows),
  queryOne: vi.fn(async () => q.one),
}));

import {
  registrationOptions, authenticationOptions, verifyRegistration, hasWebauthn,
} from "../src/lib/webauthn.js";

beforeEach(() => { q.rows = []; q.one = null; });

describe("WebAuthn — options d'enrôlement", () => {
  it("produit un défi et le bon rpID/utilisateur", async () => {
    q.rows = []; // aucune clé existante → excludeCredentials vide
    const opts = await registrationOptions("user-1", "alice@acme.fr", "Alice");
    expect(typeof opts.challenge).toBe("string");
    expect(opts.challenge.length).toBeGreaterThan(10);
    expect(opts.rp.id).toBe("localhost"); // défaut de test (WEBAUTHN_RP_ID)
    expect(opts.user.name).toBe("alice@acme.fr");
  });
});

describe("WebAuthn — options d'authentification", () => {
  it("liste les clés autorisées de l'utilisateur", async () => {
    q.rows = [{ id: "c1", credential_id: "AAA", public_key: Buffer.alloc(1), counter: "0", transports: ["internal"], name: "k", created_at: "", last_used_at: null }];
    const opts = await authenticationOptions("user-1");
    expect(typeof opts.challenge).toBe("string");
    expect(opts.allowCredentials?.[0]?.id).toBe("AAA");
  });
});

describe("WebAuthn — garde-fous", () => {
  it("refuse une vérification d'enrôlement sans défi en cours", async () => {
    q.one = null; // consumeChallenge → aucun défi
    const ok = await verifyRegistration("user-1", {} as never, "k");
    expect(ok).toBe(false);
  });

  it("hasWebauthn reflète le nombre de clés", async () => {
    q.one = { n: 0 };
    expect(await hasWebauthn("user-1")).toBe(false);
    q.one = { n: 2 };
    expect(await hasWebauthn("user-1")).toBe(true);
  });
});
