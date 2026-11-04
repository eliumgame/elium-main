/**
 * Canal collab chiffré : un refus définitif du relais (`update_too_large`, `quota_exceeded`) ne doit
 * ni fermer la socket, ni rejouer la mise à jour en boucle ; l'interface en est informée.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { EncryptedCollabChannel, DEFAULT_MAX_COLLAB_MESSAGE_BYTES } from "../src/drive-cloud/collab";
import { generateNodeKey } from "../src/drive-cloud/node-crypto";

class FakeWs {
  static OPEN = 1;
  static all: FakeWs[] = [];
  readyState = 1;
  sent: string[] = [];
  closed: Array<[number | undefined, string | undefined]> = [];
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor() {
    FakeWs.all.push(this);
  }
  close(code?: number, reason?: string) {
    this.closed.push([code, reason]);
  }
  send(d: string) {
    this.sent.push(d);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWs.all.length = 0;
});

async function open(handlers: ConstructorParameters<typeof EncryptedCollabChannel>[3]) {
  vi.stubGlobal("WebSocket", FakeWs);
  const api = {
    getCollabUpdates: async () => ({ updates: [], hasMore: false }),
    collabSocketUrl: () => "ws://x",
  };
  const ch = new EncryptedCollabChannel(api as never, "n", generateNodeKey(), handlers);
  await ch.connect();
  const ws = FakeWs.all[0]!;
  ws.onmessage!({ data: JSON.stringify({ type: "ready", canWrite: true }) });
  await new Promise((r) => setTimeout(r, 20));
  return { ch, ws };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const internals = (ch: EncryptedCollabChannel) =>
  ch as unknown as { outbox: Uint8Array[]; unacknowledged: Map<string, Uint8Array> };

describe("EncryptedCollabChannel — refus définitif d'une mise à jour", () => {
  it("update_too_large : retire l'update, prévient l'UI, ne ferme pas la socket et ne la rejoue pas", async () => {
    const onUpdateRejected = vi.fn();
    const { ch, ws } = await open({ onUpdateRejected });
    await ch.sendUpdate(new Uint8Array([1, 2, 3]));
    expect(ws.sent).toHaveLength(1);
    const nonce = JSON.parse(ws.sent[0]!).nonce as string;
    ws.onmessage!({ data: JSON.stringify({ type: "error", code: "update_too_large", nonce, maxBytes: 1000 }) });
    await flush();
    expect(onUpdateRejected).toHaveBeenCalledTimes(1);
    expect(onUpdateRejected.mock.calls[0]![0]).toMatchObject({ code: "update_too_large", maxBytes: 1000 });
    expect(onUpdateRejected.mock.calls[0]![0].update).toEqual(new Uint8Array([1, 2, 3]));
    expect(ws.closed).toEqual([]);
    // Même si la socket se ferme ensuite, rien n'est rejoué : plus aucune update en attente.
    ws.onclose!({ code: 1006 });
    expect(internals(ch).outbox).toEqual([]);
    expect(internals(ch).unacknowledged.size).toBe(0);
    ch.close();
  });

  it("quota_exceeded : même traitement (aucune boucle de reconnexion)", async () => {
    const onUpdateRejected = vi.fn();
    const { ch, ws } = await open({ onUpdateRejected });
    await ch.sendUpdate(new Uint8Array([9]));
    const nonce = JSON.parse(ws.sent[0]!).nonce as string;
    ws.onmessage!({ data: JSON.stringify({ type: "error", code: "quota_exceeded", nonce }) });
    await flush();
    expect(onUpdateRejected).toHaveBeenCalledWith(expect.objectContaining({ code: "quota_exceeded" }));
    expect(ws.closed).toEqual([]);
    expect(internals(ch).unacknowledged.size).toBe(0);
    ch.close();
  });

  it("une erreur transitoire garde le comportement existant (fermeture 4000, update conservée)", async () => {
    const onUpdateRejected = vi.fn();
    const { ch, ws } = await open({ onUpdateRejected });
    await ch.sendUpdate(new Uint8Array([7]));
    const nonce = JSON.parse(ws.sent[0]!).nonce as string;
    ws.onmessage!({ data: JSON.stringify({ type: "error", code: "persist_failed", nonce }) });
    await flush();
    expect(onUpdateRejected).not.toHaveBeenCalled();
    expect(ws.closed[0]?.[0]).toBe(4000);
    expect(internals(ch).unacknowledged.size).toBe(1);
    ch.close();
  });

  it("contrôle de taille avant envoi : une update trop grosse n'est ni chiffrée ni envoyée", async () => {
    const onUpdateRejected = vi.fn();
    const { ch, ws } = await open({ onUpdateRejected });
    await ch.sendUpdate(new Uint8Array(DEFAULT_MAX_COLLAB_MESSAGE_BYTES));
    expect(ws.sent).toHaveLength(0);
    expect(onUpdateRejected).toHaveBeenCalledWith(
      expect.objectContaining({ code: "update_too_large", maxBytes: DEFAULT_MAX_COLLAB_MESSAGE_BYTES }),
    );
    expect(internals(ch).outbox).toEqual([]);
    // Une update de taille normale part toujours.
    await ch.sendUpdate(new Uint8Array(1024));
    expect(ws.sent).toHaveLength(1);
    ch.close();
  });
});

describe("updateRejectedMessage", () => {
  it("formate le message français avec la limite en Ko", async () => {
    const { updateRejectedMessage } = await import("../src/drive-cloud/collab-provider");
    expect(updateRejectedMessage({ code: "update_too_large", maxBytes: 1024 * 1024 })).toBe(
      "Cette modification est trop volumineuse pour être synchronisée (limite : 1024 Ko) et n\u2019a pas été envoyée.",
    );
    expect(updateRejectedMessage({ code: "update_too_large" })).toContain("trop volumineuse");
    expect(updateRejectedMessage({ code: "quota_exceeded" })).toContain("quota");
  });
});
