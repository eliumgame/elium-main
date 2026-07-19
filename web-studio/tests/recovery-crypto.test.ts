/**
 * Org-recovery client cryptography — the dedicated design for wielding the
 * organization recovery key, tested in isolation (no server). Validates that:
 *  - promoting an admin re-wraps the org private key so the NEW admin can unwrap
 *    the exact same key,
 *  - restoring access recovers a node's CEK from its org key-share and re-wraps
 *    it to a target member who can then decrypt it,
 *  - `withOrgKey` drops the private material after the operation.
 */
import { describe, it, expect } from "vitest";
import { generateRecipientKeypair, encryptForRecipients } from "../src/crypto/recipients";
import { generateNodeKey, unwrapNodeKey, type WrappedKey } from "../src/drive-cloud/node-crypto";
import { fromHex } from "../src/format/canonical";
import { promoteRecoveryAdmin, restoreNodeAccess, withOrgKey, type RecoveryContext } from "../src/drive-cloud/recovery";
import type { DriveApi } from "../src/drive-cloud/api";

const dec = new TextDecoder();
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

interface Store {
  recoveryKeys: Record<string, WrappedKey>; // userId -> wrapped org private key
  grants: { nodeId: string; userId: string; roleId: string; wrappedKey: WrappedKey }[];
}

/** A DriveApi stub bound to one admin — getRecoveryKey returns THAT admin's key. */
function apiFor(store: Store, currentAdminId: string): DriveApi {
  return {
    getRecoveryKey: async () => {
      const w = store.recoveryKeys[currentAdminId];
      if (!w) {
        const e = new Error("Aucune clé de recouvrement.") as Error & { status: number };
        e.status = 404;
        throw e;
      }
      return { wrappedOrgPrivate: w };
    },
    addRecoveryAdmin: async (_orgId: string, body: { adminUserId: string; wrappedOrgPrivate: WrappedKey }) => {
      store.recoveryKeys[body.adminUserId] = body.wrappedOrgPrivate;
      return { ok: true };
    },
    recoveryGrant: async (_orgId: string, body: { nodeId: string; targetUserId: string; roleId: string; wrappedKey: WrappedKey }) => {
      store.grants.push({ nodeId: body.nodeId, userId: body.targetUserId, roleId: body.roleId, wrappedKey: body.wrappedKey });
      return { ok: true };
    },
  } as unknown as DriveApi;
}

async function wrapOrgPrivateTo(orgPrivateHex: string, recipientPublicHex: string): Promise<WrappedKey> {
  const env = await encryptForRecipients(fromHex(orgPrivateHex), [recipientPublicHex]);
  return JSON.parse(dec.decode(env)) as WrappedKey;
}

describe("org-recovery client crypto", () => {
  it("promotes a second admin who can then unwrap the same org key", async () => {
    const org = await generateRecipientKeypair();
    const alice = await generateRecipientKeypair();
    const bob = await generateRecipientKeypair();
    const store: Store = { recoveryKeys: { alice: await wrapOrgPrivateTo(org.privateHex, alice.publicHex) }, grants: [] };

    const ctxAlice: RecoveryContext = { api: apiFor(store, "alice"), orgId: "o", orgPublicHex: org.publicHex, adminKeys: alice };
    await promoteRecoveryAdmin(ctxAlice, { userId: "bob", publicHex: bob.publicHex });

    expect(store.recoveryKeys.bob).toBeDefined();
    // Bob unwraps HIS copy → must be byte-identical to the real org private key.
    const ctxBob: RecoveryContext = { api: apiFor(store, "bob"), orgId: "o", orgPublicHex: org.publicHex, adminKeys: bob };
    const bobsView = await withOrgKey(ctxBob, async (kp) => kp.privateHex);
    expect(bobsView).toBe(org.privateHex);
  });

  it("restores a member's access by re-wrapping the node CEK via the org key", async () => {
    const org = await generateRecipientKeypair();
    const admin = await generateRecipientKeypair();
    const target = await generateRecipientKeypair();
    const store: Store = { recoveryKeys: { admin: await wrapOrgPrivateTo(org.privateHex, admin.publicHex) }, grants: [] };

    // A node CEK, with its org key-share (CEK wrapped to the org public key).
    const cek = generateNodeKey();
    const orgWrappedKey = JSON.parse(dec.decode(await encryptForRecipients(cek, [org.publicHex]))) as WrappedKey;

    const ctx: RecoveryContext = { api: apiFor(store, "admin"), orgId: "o", orgPublicHex: org.publicHex, adminKeys: admin };
    await restoreNodeAccess(ctx, { nodeId: "n1", orgWrappedKey, targetUserId: "carol", targetPublicHex: target.publicHex, roleId: "r" });

    expect(store.grants).toHaveLength(1);
    const grant = store.grants[0]!;
    expect(grant.nodeId).toBe("n1");
    // The target unwraps the granted key → recovers the exact CEK.
    const recovered = await unwrapNodeKey(grant.wrappedKey, target);
    expect(eq(recovered, cek)).toBe(true);
  });

  it("withOrgKey drops the private material after the operation", async () => {
    const org = await generateRecipientKeypair();
    const admin = await generateRecipientKeypair();
    const store: Store = { recoveryKeys: { admin: await wrapOrgPrivateTo(org.privateHex, admin.publicHex) }, grants: [] };
    const ctx: RecoveryContext = { api: apiFor(store, "admin"), orgId: "o", orgPublicHex: org.publicHex, adminKeys: admin };

    let leaked: { privateHex: string } | null = null;
    await withOrgKey(ctx, async (kp) => {
      expect(kp.privateHex).toBe(org.privateHex); // valid inside the scope
      leaked = kp;
    });
    expect(leaked!.privateHex).toBe(""); // reference cleared afterwards
  });

  it("refuses to unwrap for an admin who holds no recovery key", async () => {
    const org = await generateRecipientKeypair();
    const stranger = await generateRecipientKeypair();
    const store: Store = { recoveryKeys: {}, grants: [] };
    const ctx: RecoveryContext = { api: apiFor(store, "stranger"), orgId: "o", orgPublicHex: org.publicHex, adminKeys: stranger };
    await expect(withOrgKey(ctx, async () => "x")).rejects.toBeTruthy();
  });
});
