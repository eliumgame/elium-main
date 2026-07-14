/**
 * Encrypted Yjs provider. Bridges a Y.Doc + Awareness to the end-to-end-
 * encrypted collaboration channel: every Yjs update and every awareness
 * (presence) update is encrypted under the node key before it leaves the
 * browser, and decrypted on arrival. The relay only ever sees ciphertext.
 */
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { EncryptedCollabChannel } from "./collab";
import { toHex, fromHex } from "../format/canonical";
import type { DriveApi } from "./api";

export interface CollabUser {
  name: string;
  color: string;
}
export type CollabStatus = "connecting" | "open" | "closed" | "revoked";

export class EncryptedYjsProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private readonly channel: EncryptedCollabChannel;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwUpdate: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void;

  constructor(
    api: DriveApi,
    nodeId: string,
    nodeKey: Uint8Array,
    doc: Y.Doc,
    user: CollabUser,
    opts: {
      onStatus?: (s: CollabStatus) => void;
      onReady?: (canWrite: boolean) => void;
      /** Re-unwrap the node key after a rotation eviction (relay close 4001). */
      refetchKey?: () => Promise<Uint8Array | null>;
    } = {},
  ) {
    this.doc = doc;
    this.awareness = new Awareness(doc);
    this.awareness.setLocalStateField("user", user);

    this.channel = new EncryptedCollabChannel(api, nodeId, nodeKey, {
      onRemoteUpdate: (update) => {
        Y.applyUpdate(this.doc, update, "remote");
      },
      onAwareness: (payload) => {
        const p = payload as { u?: string };
        if (p?.u) {
          try {
            applyAwarenessUpdate(this.awareness, fromHex(p.u), "remote");
          } catch {
            /* ignore malformed awareness */
          }
        }
      },
      // On (re)connection, re-broadcast our presence: the initial
      // setLocalStateField fires before the socket is open, so its update is
      // dropped by sendAwareness — without this, peers may not see us for ~15s.
      onStatus: (s) => {
        if (s === "open") this.republishAwareness();
        opts.onStatus?.(s);
      },
      // A newcomer can't see presence broadcast before they joined, so when the
      // relay signals a join we re-send our full local awareness state to them.
      onPeerJoin: () => this.republishAwareness(),
      ...(opts.onReady ? { onReady: opts.onReady } : {}),
      ...(opts.refetchKey ? { refetchKey: opts.refetchKey } : {}),
    });

    // Local Yjs changes (origin !== "remote") → encrypt & broadcast.
    this.onDocUpdate = (update, origin) => {
      if (origin !== "remote") void this.channel.sendUpdate(update);
    };
    this.doc.on("update", this.onDocUpdate);

    // Local presence changes → encrypt & broadcast.
    this.onAwUpdate = ({ added, updated, removed }, origin) => {
      if (origin === "remote") return;
      const changed = added.concat(updated, removed);
      const upd = encodeAwarenessUpdate(this.awareness, changed);
      void this.channel.sendAwareness({ u: toHex(upd) });
    };
    this.awareness.on("update", this.onAwUpdate);
  }

  /** Re-broadcast our full local awareness state (encoded for all clients). */
  private republishAwareness(): void {
    const upd = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    void this.channel.sendAwareness({ u: toHex(upd) });
  }

  /** Replay the encrypted history, then go live. */
  async connect(): Promise<void> {
    await this.channel.connect();
  }

  destroy(): void {
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwUpdate);
    try {
      removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    } catch {
      /* ignore */
    }
    this.awareness.destroy();
    this.channel.close();
  }
}
