import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EncryptedYjsProvider } from "../src/drive-cloud/collab-provider";

/**
 * Non-régression : le double montage d'effet de React.StrictMode (développement) fait `connect()` →
 * `destroy()` → `connect()` dans le même tour. Le provider doit rester pleinement utilisable : les
 * éditions locales continuent d'être envoyées (sinon le document rouvert paraît vide) et un seul
 * socket est ouvert.
 */
describe("EncryptedYjsProvider : cycle connect → destroy → connect (StrictMode)", () => {
  it("continue d'envoyer les éditions locales et n'ouvre qu'un socket", async () => {
    const sockets: unknown[] = [];
    class FakeWs {
      static OPEN = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      close() {}
      send() {}
    }
    vi.stubGlobal("WebSocket", FakeWs);
    const api = {
      getCollabUpdates: async () => ({ updates: [], hasMore: false }),
      collabSocketUrl: () => "ws://test/api/collab/n",
    };
    const doc = new Y.Doc();
    const p = new EncryptedYjsProvider(api as never, "n", new Uint8Array(32), doc, { name: "Marie", color: "#000" });
    const sendUpdate = vi.fn(async () => {});
    (p as unknown as { channel: { sendUpdate: typeof sendUpdate } }).channel.sendUpdate = sendUpdate;

    void p.connect();
    p.destroy(); // cleanup du 1er montage
    void p.connect(); // 2e montage
    await new Promise((r) => setTimeout(r, 30)); // laisse passer le démontage différé et les rattrapages

    doc.getText("t").insert(0, "Bonjour");
    expect(sendUpdate).toHaveBeenCalledTimes(1);
    expect(sockets.length).toBe(1);
    expect(p.awareness.getLocalState()).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("un vrai destroy() (sans reconnexion) retire les écouteurs après un tour de boucle", async () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        static OPEN = 1;
        close() {}
        send() {}
      },
    );
    const doc = new Y.Doc();
    const p = new EncryptedYjsProvider(
      { getCollabUpdates: async () => ({ updates: [] }), collabSocketUrl: () => "ws://x" } as never,
      "n",
      new Uint8Array(32),
      doc,
      { name: "A", color: "#000" },
    );
    const sendUpdate = vi.fn(async () => {});
    (p as unknown as { channel: { sendUpdate: typeof sendUpdate } }).channel.sendUpdate = sendUpdate;
    p.destroy();
    await new Promise((r) => setTimeout(r, 10));
    doc.getText("t").insert(0, "x");
    expect(sendUpdate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
