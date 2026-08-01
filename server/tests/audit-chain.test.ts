/**
 * Journal d'audit à intégrité chaînée : le hash d'entrée est déterministe et
 * dépend de TOUS les champs + du hash précédent, et verifyAuditChain détecte
 * altération, suppression et réordonnancement. `query` est mocké — pas de DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rowsRef: { rows: unknown[] } = { rows: [] };
vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(async () => rowsRef.rows),
}));

import { auditEntryHash, verifyAuditChain, GENESIS, type AuditFields } from "../src/lib/audit-chain.js";

const baseFields = (over: Partial<AuditFields> = {}): AuditFields => ({
  orgId: "org-1", actorUserId: "user-1", action: "node.create",
  resourceType: "node", resourceId: "node-9", metadata: { a: 1, b: "x" },
  ip: "10.0.0.1", createdAt: "2026-08-01T10:00:00.000Z", ...over,
});

/** Construit une chaîne valide de N entrées (hashs corrects). */
function buildChain(n: number) {
  const rows: Record<string, unknown>[] = [];
  let prev = GENESIS;
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(Date.UTC(2026, 7, 1, 10, i, 0));
    const f = baseFields({ action: `action.${i}`, resourceId: `r-${i}`, createdAt: createdAt.toISOString() });
    const entry = auditEntryHash(prev, f);
    rows.push({
      id: String(i + 1), org_id: f.orgId, actor_user_id: f.actorUserId, action: f.action,
      resource_type: f.resourceType, resource_id: f.resourceId, metadata: f.metadata, ip: f.ip,
      created_at: createdAt, prev_hash: prev, entry_hash: entry,
    });
    prev = entry;
  }
  return rows;
}

beforeEach(() => { rowsRef.rows = []; });

describe("auditEntryHash (pur)", () => {
  it("est déterministe et sensible aux clés d'ordre dans les métadonnées", () => {
    const h1 = auditEntryHash(GENESIS, baseFields({ metadata: { a: 1, b: "x" } }));
    const h2 = auditEntryHash(GENESIS, baseFields({ metadata: { b: "x", a: 1 } }));
    expect(h1.equals(h2)).toBe(true); // ordre des clés indifférent (sérialisation stable)
    expect(h1).toHaveLength(32);
  });

  it("change si N'IMPORTE quel champ change", () => {
    const ref = auditEntryHash(GENESIS, baseFields());
    for (const over of [{ action: "other" }, { ip: "9.9.9.9" }, { resourceId: "z" }, { metadata: { a: 2 } }, { createdAt: "2026-08-01T10:00:01.000Z" }] as Partial<AuditFields>[]) {
      expect(auditEntryHash(GENESIS, baseFields(over)).equals(ref)).toBe(false);
    }
  });

  it("change si le hash précédent change (chaînage)", () => {
    const a = auditEntryHash(GENESIS, baseFields());
    const b = auditEntryHash(Buffer.alloc(32, 1), baseFields());
    expect(a.equals(b)).toBe(false);
  });
});

describe("verifyAuditChain", () => {
  it("valide une chaîne intacte", async () => {
    rowsRef.rows = buildChain(4);
    const res = await verifyAuditChain("org-1");
    expect(res).toEqual({ ok: true, total: 4, hashed: 4 });
  });

  it("détecte une entrée ALTÉRÉE", async () => {
    const rows = buildChain(4);
    (rows[2] as { action: string }).action = "node.delete"; // falsifie sans recalculer le hash
    rowsRef.rows = rows;
    const res = await verifyAuditChain("org-1");
    expect(res.ok).toBe(false);
    expect(res.brokenAtId).toBe("3");
  });

  it("détecte une entrée SUPPRIMÉE (maillon rompu)", async () => {
    const rows = buildChain(4);
    rows.splice(1, 1); // retire la 2e entrée → prev_hash de la 3e ne suit plus
    rowsRef.rows = rows;
    const res = await verifyAuditChain("org-1");
    expect(res.ok).toBe(false);
    expect(res.brokenAtId).toBe("3");
  });

  it("ignore les entrées héritées sans hash, vérifie la queue chaînée", async () => {
    const legacy = { id: "1", org_id: "org-1", actor_user_id: null, action: "old", resource_type: "", resource_id: null, metadata: {}, ip: "", created_at: new Date(), prev_hash: null, entry_hash: null };
    rowsRef.rows = [legacy, ...buildChain(2)];
    const res = await verifyAuditChain("org-1");
    expect(res).toEqual({ ok: true, total: 3, hashed: 2 });
  });
});
