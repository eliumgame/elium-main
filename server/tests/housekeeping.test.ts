/**
 * Unit tests for src/lib/housekeeping.ts — the periodic sweep (ephemeral-table
 * purge, orphaned trash-blob purge, scheduled org-key-rotation flagging).
 * DB, storage, audit, and the orgs.ts rotation helpers are mocked, matching
 * the style of tests/orgs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const ORG = "00000000-0000-4000-8000-0000000000cc";
const NODE = "00000000-0000-4000-8000-0000000000bb";
const NODE2 = "00000000-0000-4000-8000-0000000000dd";

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));

vi.mock("../src/storage/adapter.js", () => ({
  storage: vi.fn(),
}));

vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));

vi.mock("../src/routes/orgs.js", () => ({
  orgRotationPreconditionMet: vi.fn(async () => false),
  flagOrgKeyRotationDue: vi.fn(async () => false),
}));

import { query } from "../src/db/pool.js";
import { storage } from "../src/storage/adapter.js";
import { audit } from "../src/lib/audit.js";
import { orgRotationPreconditionMet, flagOrgKeyRotationDue } from "../src/routes/orgs.js";
import {
  startHousekeeping,
  sweepEphemeralTables,
  purgeOrphanedTrashBlobs,
  sweepScheduledKeyRotation,
  TRASH_BLOB_RETENTION_DAYS,
} from "../src/lib/housekeeping.js";

const mQuery = vi.mocked(query);
const mStorage = vi.mocked(storage);
const mAudit = vi.mocked(audit);
const mPrecondition = vi.mocked(orgRotationPreconditionMet);
const mFlagDue = vi.mocked(flagOrgKeyRotationDue);

function fakeApp(): FastifyInstance {
  return { log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as FastifyInstance;
}

beforeEach(() => {
  vi.clearAllMocks();
  mQuery.mockResolvedValue([] as never);
  mPrecondition.mockResolvedValue(false);
  mFlagDue.mockResolvedValue(false);
});

// =============================================================================
// Ephemeral-table sweep (pre-existing behaviour — kept covered)
// =============================================================================

describe("sweepEphemeralTables", () => {
  it("runs every purge statement and tolerates one failing", async () => {
    let call = 0;
    mQuery.mockImplementation(async (sql: string) => {
      call++;
      if (sql.includes("webauthn_challenges")) throw new Error("table missing");
      return [];
    });
    const app = fakeApp();
    await expect(sweepEphemeralTables(app)).resolves.toBeUndefined();
    expect(call).toBe(5); // login/webauthn/webauthn_login/sessions/invites
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ table: "webauthn_challenges" }),
      expect.any(String),
    );
  });
});

describe("startHousekeeping", () => {
  it("schedules a recurring sweep and the stop function cancels it", async () => {
    vi.useFakeTimers();
    try {
      const app = fakeApp();
      const stop = startHousekeeping(app);
      expect(mQuery).not.toHaveBeenCalled(); // no immediate run at start
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(mQuery).toHaveBeenCalled();
      stop();
      mQuery.mockClear();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(mQuery).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// =============================================================================
// PART A — orphaned trash-blob purge
// =============================================================================

describe("purgeOrphanedTrashBlobs", () => {
  it("only queries nodes that are trashed past the retention window (narrow, not a broad storage scan)", async () => {
    mQuery.mockResolvedValueOnce([] as never); // candidates
    const app = fakeApp();
    await purgeOrphanedTrashBlobs(app);
    const sql = mQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("trashed_at IS NOT NULL");
    expect(sql).toContain(`interval '${TRASH_BLOB_RETENTION_DAYS} days'`);
    expect(sql).not.toMatch(/UNION|information_schema/i); // no attempt at a table/bucket-wide scan
  });

  it("deletes the DB row, then purges exactly the blobs owned by that node (current + versions) — never anything else", async () => {
    const del = vi.fn(async () => {});
    mStorage.mockReturnValue({ delete: del } as never);

    const order: string[] = [];
    mQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM nodes") && sql.includes("trashed_at")) {
        return [{ id: NODE, org_id: ORG, kind: "file", content_ref: "blobA" }];
      }
      if (sql.includes("FROM node_versions")) {
        expect(params).toEqual([NODE]);
        return [{ content_ref: "blobB" }];
      }
      if (sql.startsWith("DELETE FROM nodes")) {
        order.push("db-delete");
        expect(params).toEqual([NODE]);
        return [];
      }
      return [];
    });
    del.mockImplementation(async () => {
      order.push("blob-delete");
    });

    const app = fakeApp();
    await purgeOrphanedTrashBlobs(app);

    // Exactly the two refs belonging to THIS node were purged — nothing else
    // (e.g. an unrelated active node's blob) was ever touched.
    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith("blobA");
    expect(del).toHaveBeenCalledWith("blobB");

    // The DB row is gone BEFORE any blob is touched — never leaves a
    // content_ref dangling at a blob that's already been removed.
    expect(order).toEqual(["db-delete", "blob-delete", "blob-delete"]);

    expect(mAudit).toHaveBeenCalledWith(
      ORG,
      null,
      "node.purge.auto",
      "file",
      NODE,
      expect.objectContaining({ reason: "trash-retention" }),
      "",
    );
  });

  it("never touches a blob that still belongs to a node NOT returned as a purge candidate", async () => {
    const del = vi.fn(async () => {});
    mStorage.mockReturnValue({ delete: del } as never);
    // Only NODE is past retention; a second, unrelated node (NODE2/"blobC") is
    // simply never in the candidate set — simulating an active/in-flight node.
    mQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM nodes") && sql.includes("trashed_at")) {
        return [{ id: NODE, org_id: ORG, kind: "file", content_ref: "blobA" }];
      }
      if (sql.includes("FROM node_versions")) return [];
      return [];
    });
    const app = fakeApp();
    await purgeOrphanedTrashBlobs(app);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("blobA");
    expect(del).not.toHaveBeenCalledWith("blobC");
    expect(del).not.toHaveBeenCalledWith(NODE2);
  });

  it("keeps sweeping other candidates when one node's purge throws", async () => {
    const del = vi.fn(async () => {});
    mStorage.mockReturnValue({ delete: del } as never);
    mQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM nodes") && sql.includes("trashed_at")) {
        return [
          { id: NODE, org_id: ORG, kind: "file", content_ref: "blobA" },
          { id: NODE2, org_id: ORG, kind: "file", content_ref: "blobC" },
        ];
      }
      if (sql.includes("FROM node_versions")) return [];
      if (sql.startsWith("DELETE FROM nodes")) {
        throw new Error("db unavailable"); // simulate failure for BOTH, still no throw out
      }
      return [];
    });
    const app = fakeApp();
    await expect(purgeOrphanedTrashBlobs(app)).resolves.toBeUndefined();
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ node: NODE }),
      expect.any(String),
    );
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ node: NODE2 }),
      expect.any(String),
    );
    expect(del).not.toHaveBeenCalled(); // DB delete failed first, so blobs are never touched
  });

  it("does not crash the sweep when the candidate SELECT itself fails", async () => {
    mQuery.mockRejectedValueOnce(new Error("connection refused"));
    const app = fakeApp();
    await expect(purgeOrphanedTrashBlobs(app)).resolves.toBeUndefined();
    expect(app.log.warn).toHaveBeenCalled();
  });
});

// =============================================================================
// PART B — scheduled (opt-in) org key rotation gating
// =============================================================================

describe("sweepScheduledKeyRotation", () => {
  it("does nothing for orgs with rotation disabled (no keyRotationDays row returned — the default)", async () => {
    mQuery.mockResolvedValueOnce([] as never); // WHERE clause excludes disabled orgs
    const app = fakeApp();
    await sweepScheduledKeyRotation(app);
    expect(mPrecondition).not.toHaveBeenCalled();
    expect(mFlagDue).not.toHaveBeenCalled();
    expect(mAudit).not.toHaveBeenCalled();
  });

  it("defensively skips a row with keyRotationDays <= 0 even if returned", async () => {
    mQuery.mockResolvedValueOnce([
      { id: ORG, created_at: new Date(Date.now() - 100 * 86400000).toISOString(), settings: { keyRotationDays: 0 } },
    ] as never);
    const app = fakeApp();
    await sweepScheduledKeyRotation(app);
    expect(mPrecondition).not.toHaveBeenCalled();
  });

  it("does not trigger before the interval has elapsed", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: ORG,
        created_at: new Date(Date.now() - 100 * 86400000).toISOString(),
        settings: { keyRotationDays: 30, keyRotationLastRotatedAt: new Date(Date.now() - 5 * 86400000).toISOString() },
      },
    ] as never);
    const app = fakeApp();
    await sweepScheduledKeyRotation(app);
    expect(mPrecondition).not.toHaveBeenCalled();
    expect(mAudit).not.toHaveBeenCalled();
  });

  it("triggers (flags) an org once the interval elapsed AND the admins-covered precondition is met", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: ORG,
        created_at: new Date(Date.now() - 400 * 86400000).toISOString(),
        settings: { keyRotationDays: 30, keyRotationLastRotatedAt: new Date(Date.now() - 40 * 86400000).toISOString() },
      },
    ] as never);
    mPrecondition.mockResolvedValueOnce(true);
    mFlagDue.mockResolvedValueOnce(true); // first time it becomes due
    const app = fakeApp();
    await sweepScheduledKeyRotation(app);
    expect(mPrecondition).toHaveBeenCalledWith(ORG);
    expect(mFlagDue).toHaveBeenCalledWith(ORG);
    expect(mAudit).toHaveBeenCalledWith(
      ORG,
      null,
      "org.recovery.rotation.due",
      "org",
      ORG,
      { keyRotationDays: 30 },
      "",
    );
    expect(app.log.warn).toHaveBeenCalled();
  });

  it("falls back to the org's created_at when it has never been rotated", async () => {
    mQuery.mockResolvedValueOnce([
      { id: ORG, created_at: new Date(Date.now() - 40 * 86400000).toISOString(), settings: { keyRotationDays: 30 } },
    ] as never);
    mPrecondition.mockResolvedValueOnce(true);
    mFlagDue.mockResolvedValueOnce(true);
    const app = fakeApp();
    await sweepScheduledKeyRotation(app);
    expect(mPrecondition).toHaveBeenCalledWith(ORG);
    expect(mAudit).toHaveBeenCalled();
  });

  it("skips (does not flag or audit) when the admins-covered precondition is NOT met, and logs it", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: ORG,
        created_at: new Date(Date.now() - 400 * 86400000).toISOString(),
        settings: { keyRotationDays: 30, keyRotationLastRotatedAt: new Date(Date.now() - 40 * 86400000).toISOString() },
      },
    ] as never);
    mPrecondition.mockResolvedValueOnce(false); // an admin is missing a public key
    const app = fakeApp();
    await sweepScheduledKeyRotation(app);
    expect(mPrecondition).toHaveBeenCalledWith(ORG);
    expect(mFlagDue).not.toHaveBeenCalled();
    expect(mAudit).not.toHaveBeenCalled();
    expect(app.log.warn).toHaveBeenCalledWith(expect.objectContaining({ org: ORG }), expect.any(String));
  });

  it("does not re-audit an org that was already flagged as due on a previous sweep", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: ORG,
        created_at: new Date(Date.now() - 400 * 86400000).toISOString(),
        settings: {
          keyRotationDays: 30,
          keyRotationLastRotatedAt: new Date(Date.now() - 40 * 86400000).toISOString(),
          keyRotationDueSince: new Date(Date.now() - 1000).toISOString(),
        },
      },
    ] as never);
    mPrecondition.mockResolvedValueOnce(true);
    mFlagDue.mockResolvedValueOnce(false); // already flagged — UPDATE ... WHERE dueSince IS NULL matched nothing
    const app = fakeApp();
    await sweepScheduledKeyRotation(app);
    expect(mAudit).not.toHaveBeenCalled();
  });

  it("never runs the actual key-rotation mutation (org_recovery_keys / node_keys writes) — only flags", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: ORG,
        created_at: new Date(Date.now() - 400 * 86400000).toISOString(),
        settings: { keyRotationDays: 30, keyRotationLastRotatedAt: new Date(Date.now() - 40 * 86400000).toISOString() },
      },
    ] as never);
    mPrecondition.mockResolvedValueOnce(true);
    mFlagDue.mockResolvedValueOnce(true);
    const app = fakeApp();
    await sweepScheduledKeyRotation(app);
    expect(mAudit).toHaveBeenCalled(); // sanity: the sweep did run
    // The unattended sweep must never itself touch key material — that always
    // requires a client-supplied payload via applyOrgKeyRotation (see orgs.ts).
    const sqlCalls = mQuery.mock.calls.map((c) => String(c[0]));
    expect(sqlCalls.some((s) => /org_recovery_keys/i.test(s) && /(insert|delete|update)/i.test(s))).toBe(false);
    expect(sqlCalls.some((s) => /node_keys/i.test(s) && /update/i.test(s))).toBe(false);
    expect(sqlCalls.some((s) => /org_public_hex/i.test(s))).toBe(false);
  });

  it("keeps sweeping other orgs when one org's precondition check throws", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: ORG,
        created_at: new Date(Date.now() - 400 * 86400000).toISOString(),
        settings: { keyRotationDays: 30, keyRotationLastRotatedAt: new Date(Date.now() - 40 * 86400000).toISOString() },
      },
    ] as never);
    mPrecondition.mockRejectedValueOnce(new Error("db blip"));
    const app = fakeApp();
    await expect(sweepScheduledKeyRotation(app)).resolves.toBeUndefined();
    expect(app.log.warn).toHaveBeenCalled();
    expect(mAudit).not.toHaveBeenCalled();
  });

  it("does not crash the sweep when the candidate SELECT itself fails", async () => {
    mQuery.mockRejectedValueOnce(new Error("connection refused"));
    const app = fakeApp();
    await expect(sweepScheduledKeyRotation(app)).resolves.toBeUndefined();
    expect(app.log.warn).toHaveBeenCalled();
  });
});
