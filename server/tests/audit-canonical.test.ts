/**
 * Canonicalisation des métadonnées d'audit (audit 2026-11) : le hash couvre
 * EXACTEMENT ce que la base stocke. Une clé `undefined` ou une `Date` ne doit
 * plus casser la chaîne, et les entrées historiques écrites avec l'ancienne
 * canonicalisation (deux appels connus) restent vérifiables.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], inserted: [] as unknown[][] }));

vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(async (_sql: string, params: unknown[] = []) => {
    const [orgId, afterId] = params as [string | null, string | null];
    return db.rows.filter((r) => r.org_id === orgId && (afterId == null || BigInt(r.id as string) > BigInt(afterId)));
  }),
  withTx: vi.fn(async (fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        if (/INSERT INTO audit_log/.test(sql)) db.inserted.push(params);
        if (/SELECT entry_hash FROM audit_log/.test(sql)) {
          const last = db.rows[db.rows.length - 1];
          return { rows: last ? [{ entry_hash: last.entry_hash }] : [] };
        }
        return { rows: [] };
      },
    }),
  ),
}));

import { audit } from "../src/lib/audit.js";
import { auditEntryHash, canonicalAuditMetadata, GENESIS, verifyAuditChain } from "../src/lib/audit-chain.js";

const ORG = "org-1";

/** Matérialise l'INSERT capturé comme une ligne relue (JSONB = JSON.parse). */
function persistLastInsert(id: number): void {
  const p = db.inserted[db.inserted.length - 1]!;
  db.rows.push({
    id: String(id),
    org_id: p[0],
    actor_user_id: p[1],
    action: p[2],
    resource_type: p[3],
    resource_id: p[4],
    metadata: JSON.parse(p[5] as string),
    ip: p[6],
    created_at: new Date(p[7] as string),
    prev_hash: p[8],
    entry_hash: p[9],
  });
}

beforeEach(() => {
  db.rows = [];
  db.inserted = [];
});

describe("canonicalAuditMetadata", () => {
  it("supprime undefined et sérialise les Date comme le fait le stockage", () => {
    const d = new Date("2026-11-01T10:00:00.000Z");
    expect(canonicalAuditMetadata({ a: undefined, d, n: 1 })).toEqual({ d: "2026-11-01T10:00:00.000Z", n: 1 });
  });
  it("est l'identité pour des métadonnées déjà JSON (les maillons existants restent valides)", () => {
    const m = { a: 1, b: "x", c: [1, { z: null }] };
    expect(canonicalAuditMetadata(m)).toEqual(m);
  });
});

describe("audit() puis verifyAuditChain : aller-retour JSONB", () => {
  it("une clé undefined et une Date n'invalident plus la chaîne", async () => {
    await audit(ORG, null, "node.sign.submit", "file", "n1", { signerFpr: undefined }, "1.2.3.4");
    persistLastInsert(1);
    await audit(ORG, "u1", "site.user.password_reset", "user", "u2", { expiresAt: new Date() }, "1.2.3.4");
    persistLastInsert(2);
    await audit(ORG, "u1", "node.create", "node", "n2", { a: 1 }, "1.2.3.4");
    persistLastInsert(3);
    const res = await verifyAuditChain(ORG);
    expect(res).toEqual({ ok: true, total: 3, hashed: 3 });
  });
});

describe("entrées historiques (ancienne canonicalisation)", () => {
  function legacyRow(id: number, prev: Buffer, action: string, hashedMeta: unknown, storedMeta: unknown) {
    const createdAt = `2026-10-0${id}T10:00:00.000Z`;
    const f = {
      orgId: ORG,
      actorUserId: null,
      action,
      resourceType: "x",
      resourceId: null,
      metadata: hashedMeta,
      ip: "",
      createdAt,
    };
    const entry = auditEntryHash(prev, f);
    db.rows.push({
      id: String(id),
      org_id: ORG,
      actor_user_id: null,
      action,
      resource_type: "x",
      resource_id: null,
      metadata: storedMeta,
      ip: "",
      created_at: new Date(createdAt),
      prev_hash: prev,
      entry_hash: entry,
    });
    return entry;
  }

  it("signature sans empreinte (hachée null, stockée absente) et Date (hachée {}, stockée ISO) restent vérifiables", async () => {
    const h1 = legacyRow(1, GENESIS, "node.sign.submit", { signerFpr: null }, {});
    const h2 = legacyRow(
      2,
      h1,
      "site.user.password_reset",
      { expiresAt: {} },
      { expiresAt: "2026-10-04T10:00:00.000Z" },
    );
    legacyRow(3, h2, "node.create", { a: 1 }, { a: 1 });
    const res = await verifyAuditChain(ORG);
    expect(res).toEqual({ ok: true, total: 3, hashed: 3, legacyAccepted: 2 });
  });

  it("la tolérance est ciblée : une autre action altérée reste détectée", async () => {
    const h1 = legacyRow(1, GENESIS, "node.create", { a: 1 }, { a: 1 });
    legacyRow(2, h1, "node.update", { signerFpr: null }, {});
    const res = await verifyAuditChain(ORG);
    expect(res.ok).toBe(false);
    expect(res.brokenAtId).toBe("2");
  });
});
