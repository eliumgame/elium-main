import { describe, expect, it, vi } from "vitest";
vi.mock("../src/db/pool.js", () => ({ withTx: vi.fn() }));
import { withTx } from "../src/db/pool.js";
import { hardenBackupCodes } from "../src/db/backup-code-migration.js";
import { backupCodeHash, protectBackupDigest, sha256Hex } from "../src/lib/crypto-server.js";

describe("backup code verifiers", () => {
  it("binds a code to its account and matches migration of a legacy digest", () => {
    expect(backupCodeHash("alice", "abcd-efgh")).toBe(protectBackupDigest("alice", sha256Hex("abcd-efgh")));
    expect(backupCodeHash("alice", "abcd-efgh")).not.toBe(backupCodeHash("bob", "abcd-efgh"));
    expect(backupCodeHash("alice", "abcd-efgh")).toMatch(/^h1:[0-9a-f]{64}$/);
    expect(backupCodeHash("alice", "abcd-efgh")).not.toContain(sha256Hex("abcd-efgh"));
  });
  it("migrates legacy digests under row locks without needing plaintext", async () => {
    const digest = sha256Hex("abcd-efgh");
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [{ id: "code", user_id: "alice", code_hash: digest }] : [] }));
    vi.mocked(withTx).mockImplementation(async fn => fn({ query } as never));
    await hardenBackupCodes();
    expect(query.mock.calls[0]![0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE mfa_backup_codes"), ["code", backupCodeHash("alice", "abcd-efgh")]);
  });
});
