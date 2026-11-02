/**
 * Canal collab chiffré (drive-cloud/collab.ts) :
 *  - après une rotation dont la compaction a échoué, les entrées encore sous l'ANCIENNE clé sont lues
 *    via la fente « clé précédente » du nœud (le document ne s'ouvre plus vide) ;
 *  - un éditeur qui lève sur un état forgé n'empêche pas l'ouverture du socket.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import * as Y from "yjs";
import { EncryptedCollabChannel } from "../src/drive-cloud/collab";
import { encryptContent, generateNodeKey } from "../src/drive-cloud/node-crypto";
import { toHex } from "../src/format/canonical";

const sockets: unknown[] = [];
class FakeWs {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  close() {}
  send() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  sockets.length = 0;
});

async function row(key: Uint8Array, bytes: Uint8Array, seq: number) {
  const e = await encryptContent(key, bytes);
  return { seq, ciphertext: toHex(e.ciphertext), nonce: e.nonceHex, author: null };
}

describe("EncryptedCollabChannel — résilience", () => {
  it("lit les entrées sous la clé précédente via prevKeyWrapped", async () => {
    vi.stubGlobal("WebSocket", FakeWs);
    const oldKey = generateNodeKey();
    const newKey = generateNodeKey();
    const slot = await encryptContent(newKey, oldKey);
    const src = new Y.Doc();
    const updates: Uint8Array[] = [];
    src.on("update", (u: Uint8Array) => updates.push(u));
    src.getText("t").insert(0, "avant rotation");
    src.getText("t").insert(14, " / après");
    const log = [await row(oldKey, updates[0]!, 1), await row(newKey, updates[1]!, 2)];
    const api = {
      getCollabUpdates: async () => ({ updates: log, hasMore: false }),
      getNode: vi.fn(async () => ({ node: { prevKeyWrapped: toHex(slot.ciphertext), prevKeyNonce: slot.nonceHex } })),
      collabSocketUrl: () => "ws://x",
    };
    const doc = new Y.Doc();
    const ch = new EncryptedCollabChannel(api as never, "n", newKey, {
      onBacklog: (us) => us.forEach((u) => Y.applyUpdate(doc, u)),
    });
    await ch.connect();
    expect(doc.getText("t").toString()).toBe("avant rotation / après");
    expect(api.getNode).toHaveBeenCalledTimes(1);
    ch.close();
  });

  it("une exception de l'éditeur pendant le rattrapage n'empêche pas l'ouverture du socket", async () => {
    vi.stubGlobal("WebSocket", FakeWs);
    const key = generateNodeKey();
    const api = {
      getCollabUpdates: async () => ({ updates: [await row(key, new Uint8Array([1, 2, 3]), 1)], hasMore: false }),
      collabSocketUrl: () => "ws://x",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ch = new EncryptedCollabChannel(api as never, "n", key, {
      onBacklog: () => {
        throw new TypeError("ys.get is not a function");
      },
    });
    await expect(ch.connect()).resolves.toBeUndefined();
    expect(sockets).toHaveLength(1);
    warn.mockRestore();
    ch.close();
  });
});
