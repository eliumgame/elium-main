/**
 * Journal d'audit à intégrité chaînée : le hash d'entrée est déterministe et
 * dépend de TOUS les champs + du hash précédent, et verifyAuditChain détecte
 * altération, suppression et réordonnancement. `query` est mocké — pas de DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// `query` est mocké pour se comporter comme la vraie table paginée : filtre sur
// (org_id, id > curseur), trie par id ASC, applique LIMIT — exactement le
// contrat SQL dont verifyAuditChain dépend pour sa lecture par pages. Sans ce
// filtrage réel, un test avec plus d'une page boucleer indéfiniment (le mock
// renverrait toujours la même page complète, le curseur n'avançant jamais).
const rowsRef: { rows: Record<string, unknown>[] } = { rows: [] };
vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(async (_sql: string, params: unknown[] = []) => {
    const [orgId, afterId, limit] = params as [string | null, string | null | undefined, number | undefined];
    const idOf = (r: Record<string, unknown>) => BigInt(r.id as string | number);
    let rows = rowsRef.rows.filter((r) => (orgId === null ? r.org_id === null : r.org_id === orgId));
    rows = rows.slice().sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
    if (afterId != null) rows = rows.filter((r) => idOf(r) > BigInt(afterId));
    if (typeof limit === "number") rows = rows.slice(0, limit);
    return rows;
  }),
}));

import {
  auditEntryHash,
  verifyAuditChain,
  GENESIS,
  VERIFY_PAGE_SIZE,
  type AuditFields,
} from "../src/lib/audit-chain.js";
import { query } from "../src/db/pool.js";

const baseFields = (over: Partial<AuditFields> = {}): AuditFields => ({
  orgId: "org-1",
  actorUserId: "user-1",
  action: "node.create",
  resourceType: "node",
  resourceId: "node-9",
  metadata: { a: 1, b: "x" },
  ip: "10.0.0.1",
  createdAt: "2026-08-01T10:00:00.000Z",
  ...over,
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
      id: String(i + 1),
      org_id: f.orgId,
      actor_user_id: f.actorUserId,
      action: f.action,
      resource_type: f.resourceType,
      resource_id: f.resourceId,
      metadata: f.metadata,
      ip: f.ip,
      created_at: createdAt,
      prev_hash: prev,
      entry_hash: entry,
    });
    prev = entry;
  }
  return rows;
}

beforeEach(() => {
  rowsRef.rows = [];
});

describe("auditEntryHash (pur)", () => {
  it("est déterministe et sensible aux clés d'ordre dans les métadonnées", () => {
    const h1 = auditEntryHash(GENESIS, baseFields({ metadata: { a: 1, b: "x" } }));
    const h2 = auditEntryHash(GENESIS, baseFields({ metadata: { b: "x", a: 1 } }));
    expect(h1.equals(h2)).toBe(true); // ordre des clés indifférent (sérialisation stable)
    expect(h1).toHaveLength(32);
  });

  it("change si N'IMPORTE quel champ change", () => {
    const ref = auditEntryHash(GENESIS, baseFields());
    for (const over of [
      { action: "other" },
      { ip: "9.9.9.9" },
      { resourceId: "z" },
      { metadata: { a: 2 } },
      { createdAt: "2026-08-01T10:00:01.000Z" },
    ] as Partial<AuditFields>[]) {
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
    const legacy = {
      id: "1",
      org_id: "org-1",
      actor_user_id: null,
      action: "old",
      resource_type: "",
      resource_id: null,
      metadata: {},
      ip: "",
      created_at: new Date(),
      prev_hash: null,
      entry_hash: null,
    };
    rowsRef.rows = [legacy, ...buildChain(2)];
    const res = await verifyAuditChain("org-1");
    expect(res).toEqual({ ok: true, total: 3, hashed: 2 });
  });

  // --- Lecture paginée : la table audit_log est append-only et ne fait que
  // croître, verifyAuditChain lit désormais par pages de VERIFY_PAGE_SIZE
  // lignes plutôt qu'un unique SELECT sans LIMIT. Les tests ci-dessous prouvent
  // que rien ne casse à la frontière entre deux pages.
  describe("pagination (historique multi-pages)", () => {
    beforeEach(() => {
      vi.mocked(query).mockClear();
    });

    it("valide une chaîne intacte qui s'étend sur PLUSIEURS pages", async () => {
      const n = VERIFY_PAGE_SIZE * 2 + 137; // 3 pages, dont une incomplète
      rowsRef.rows = buildChain(n);
      const res = await verifyAuditChain("org-1");
      expect(res).toEqual({ ok: true, total: n, hashed: n });
      // Preuve que la lecture est bien paginée (>1 aller-retour), pas un retour
      // à une requête unique qui charge tout en une fois.
      expect(vi.mocked(query).mock.calls.length).toBeGreaterThan(1);
    });

    it("détecte un maillon rompu AU-DELÀ de la 1re page, et compte `total` sur TOUTES les pages malgré l'arrêt de la vérification", async () => {
      const n = VERIFY_PAGE_SIZE * 2 + 1000; // couvre 3 pages
      const rows = buildChain(n);
      const brokenIndex = VERIFY_PAGE_SIZE + 1999; // id 7000 : tombe dans la 2e page (5001..10000)
      (rows[brokenIndex] as { action: string }).action = "tampered"; // falsifie sans recalculer le hash
      rowsRef.rows = rows;
      const res = await verifyAuditChain("org-1");
      expect(res.ok).toBe(false);
      expect(res.brokenAtId).toBe(String(brokenIndex + 1));
      // `total` doit rester le compte de TOUTES les lignes de la chaîne (les 3
      // pages), pas seulement celles vues jusqu'à la page où la cassure est
      // détectée — exactement le comportement de l'ancienne requête unique
      // (`rows.length` sur l'intégralité de la table).
      expect(res.total).toBe(n);
      // `hashed` se fige au maillon rompu inclus (comme l'ancien retour anticipé
      // dans la boucle, qui incrémentait `hashed` avant de vérifier puis
      // retournait immédiatement).
      expect(res.hashed).toBe(brokenIndex + 1);
      expect(vi.mocked(query).mock.calls.length).toBeGreaterThan(2);
    });

    it("détecte une entrée SUPPRIMÉE juste après une frontière de page", async () => {
      // La lacune tombe exactement entre la 1re et la 2e page : id VERIFY_PAGE_SIZE+1
      // (1er id de la page 2) est retiré, donc le prev_hash du suivant (id
      // VERIFY_PAGE_SIZE+2, lui aussi en page 2) ne correspond plus à l'entrée
      // attendue portée depuis la fin de la page 1.
      const n = VERIFY_PAGE_SIZE + 50;
      const rows = buildChain(n);
      rows.splice(VERIFY_PAGE_SIZE, 1); // retire l'id VERIFY_PAGE_SIZE+1
      rowsRef.rows = rows;
      const res = await verifyAuditChain("org-1");
      expect(res.ok).toBe(false);
      expect(res.brokenAtId).toBe(String(VERIFY_PAGE_SIZE + 2));
      expect(res.total).toBe(n - 1);
    });
  });
});
