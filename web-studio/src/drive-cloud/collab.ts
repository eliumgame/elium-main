/**
 * Encrypted collaboration channel (client). Transport-only + crypto: it does not
 * depend on Yjs, so it can wrap any binary-update CRDT. The UI layer feeds it
 * Yjs update bytes and applies the decrypted remote updates to its Y.Doc.
 *
 * Every update is AES-256-GCM-encrypted under the node key BEFORE it reaches the
 * relay; the relay only ever sees ciphertext. Awareness (presence) payloads are
 * encrypted too.
 */
import type { DriveApi } from "./api";
import { encryptContent, decryptContent } from "./node-crypto";
import { toHex, fromHex } from "../format/canonical";

export interface CollabHandlers {
  onReady?: (canWrite: boolean) => void;
  onRemoteUpdate?: (update: Uint8Array, author: string | null, seq: number | null) => void;
  onAwareness?: (payload: unknown, from: string) => void;
  onStatus?: (status: "connecting" | "open" | "closed" | "revoked") => void;
  /** A new peer joined the room — re-broadcast local presence so they see us. */
  onPeerJoin?: (userId: string) => void;
  /**
   * The relay evicted the room after a key rotation (close code 4001): the
   * in-memory node key is stale. Must resolve to one of:
   *   - the freshly unwrapped key: the channel swaps it in and reconnects.
   *   - null: access was CONFIRMED revoked (e.g. a 403/404 fetching the node) —
   *     we stop for good and report status "revoked".
   *   - throws: a transient failure (network/timeout/5xx) unrelated to actual
   *     revocation — NOT treated as revoked; retried like an ordinary reconnect.
   */
  refetchKey?: () => Promise<Uint8Array | null>;
}

export class EncryptedCollabChannel {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private closedByUser = false;

  constructor(
    private readonly api: DriveApi,
    private readonly nodeId: string,
    private nodeKey: Uint8Array,
    private readonly handlers: CollabHandlers = {},
  ) {}

  /** Replay the encrypted backlog, then open the live socket. */
  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.catchUp();
    this.open();
  }

  private async catchUp(): Promise<void> {
    const { updates } = await this.api.getCollabUpdates(this.nodeId, this.lastSeq);
    for (const u of updates) {
      this.lastSeq = Math.max(this.lastSeq, u.seq);
      try {
        const plain = await decryptContent(this.nodeKey, u.nonce, fromHex(u.ciphertext));
        this.handlers.onRemoteUpdate?.(plain, u.author, u.seq);
      } catch {
        /* skip an update we cannot decrypt (should not happen with the right key) */
      }
    }
  }

  private open(): void {
    this.handlers.onStatus?.("connecting");
    const ws = new WebSocket(this.api.collabSocketUrl(this.nodeId));
    this.ws = ws;
    ws.onopen = () => this.handlers.onStatus?.("open");
    ws.onclose = (ev) => {
      this.handlers.onStatus?.("closed");
      if (this.closedByUser) return;
      // 4001 = the relay rekeyed/revoked the room (key rotation): our key is
      // stale, re-unwrap it before resyncing. Any other close is a network
      // hiccup — plain reconnect.
      if ((ev as CloseEvent).code === 4001) {
        void this.rekeyAndReconnect();
      } else {
        setTimeout(() => this.reconnect(), 1500);
      }
    };
    ws.onmessage = (ev) => void this.onMessage(String(ev.data));
  }

  private async rekeyAndReconnect(): Promise<void> {
    if (!this.handlers.refetchKey) return; // no rekey path — stay closed
    if (this.closedByUser) return;
    let fresh: Uint8Array | null;
    try {
      fresh = await this.handlers.refetchKey();
    } catch {
      // refetchKey threw: a transient failure (network/timeout/5xx), NOT a
      // confirmed revocation. Do not give up — retry like an ordinary
      // reconnect rather than mislabeling a hiccup as "access revoked".
      setTimeout(() => void this.rekeyAndReconnect(), 1500);
      return;
    }
    if (!fresh) {
      // refetchKey resolved to null: access was CONFIRMED revoked (e.g. a
      // 403/404 looking up the node) — do not loop on the relay.
      this.handlers.onStatus?.("revoked");
      return;
    }
    this.nodeKey = fresh;
    await this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.closedByUser) return;
    try {
      await this.catchUp();
    } catch {
      /* will retry on next cycle */
    }
    this.open();
  }

  private async onMessage(data: string): Promise<void> {
    let msg: { type?: string; ciphertext?: string; nonce?: string; seq?: number; author?: string | null; from?: string; payload?: unknown; canWrite?: boolean };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "ready") {
      this.handlers.onReady?.(!!msg.canWrite);
    } else if (msg.type === "update" && msg.ciphertext && msg.nonce) {
      if (typeof msg.seq === "number") this.lastSeq = Math.max(this.lastSeq, msg.seq);
      try {
        const plain = await decryptContent(this.nodeKey, msg.nonce, fromHex(msg.ciphertext));
        this.handlers.onRemoteUpdate?.(plain, msg.author ?? null, msg.seq ?? null);
      } catch {
        /* ignore undecryptable */
      }
    } else if (msg.type === "awareness") {
      try {
        const raw = msg.payload as { c?: string; n?: string } | undefined;
        if (raw?.c && raw?.n) {
          const plain = await decryptContent(this.nodeKey, raw.n, fromHex(raw.c));
          this.handlers.onAwareness?.(JSON.parse(new TextDecoder().decode(plain)), msg.from ?? "");
        }
      } catch {
        /* ignore */
      }
    } else if (msg.type === "peer-join") {
      this.handlers.onPeerJoin?.(msg.from ?? "");
    }
  }

  /** Encrypt and broadcast a local CRDT update. */
  async sendUpdate(update: Uint8Array): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const enc = await encryptContent(this.nodeKey, update);
    this.ws.send(JSON.stringify({ type: "update", ciphertext: toHex(enc.ciphertext), nonce: enc.nonceHex }));
  }

  /** Encrypt and broadcast a presence/awareness payload. */
  async sendAwareness(payload: unknown): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const enc = await encryptContent(this.nodeKey, new TextEncoder().encode(JSON.stringify(payload)));
    this.ws.send(JSON.stringify({ type: "awareness", payload: { c: toHex(enc.ciphertext), n: enc.nonceHex } }));
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }
}
