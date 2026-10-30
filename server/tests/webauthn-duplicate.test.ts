/**
 * Enregistrement d'une passkey : un credential_id déjà présent doit produire
 * une erreur 409 explicite, pas un faux succès (ON CONFLICT DO NOTHING).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const q = { rows: [] as unknown[], one: null as unknown };
vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(async () => q.rows),
  queryOne: vi.fn(async () => q.one),
}));
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(async () => ({
    verified: true,
    registrationInfo: { credential: { id: "cred-1", publicKey: new Uint8Array([1, 2]), counter: 0, transports: [] } },
  })),
}));

import { verifyRegistration } from "../src/lib/webauthn.js";

beforeEach(() => {
  q.rows = [];
  q.one = { challenge: "c" }; // consumeChallenge → défi présent
});

describe("verifyRegistration — doublon de credential_id", () => {
  it("lève un 409 quand l'INSERT ne retourne aucune ligne", async () => {
    q.rows = [];
    await expect(verifyRegistration("u1", {} as never, "k")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("renvoie true quand la ligne est insérée", async () => {
    q.rows = [{ id: "new" }];
    await expect(verifyRegistration("u1", {} as never, "k")).resolves.toBe(true);
  });
});
