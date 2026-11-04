/**
 * Encrypted Yjs provider. Bridges a Y.Doc + Awareness to the end-to-end-
 * encrypted collaboration channel: every Yjs update and every awareness
 * (presence) update is encrypted under the node key before it leaves the
 * browser, and decrypted on arrival. The relay only ever sees ciphertext.
 */
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { BoundAwareness } from "./collab-awareness";
import { EncryptedCollabChannel } from "./collab";
import { toHex, fromHex } from "../format/canonical";
import type { DriveApi } from "./api";

export interface CollabUser {
  name: string;
  color: string;
}
export type CollabStatus = "connecting" | "open" | "closed" | "revoked";

/** Message utilisateur (français) pour une mise à jour refusée définitivement par le relais. */
export function updateRejectedMessage(info: { code: string; maxBytes?: number }): string {
  if (info.code === "quota_exceeded") {
    return "Le quota de stockage est atteint : cette modification n’a pas été envoyée.";
  }
  const limit =
    typeof info.maxBytes === "number" && info.maxBytes > 0 ? ` (limite : ${Math.max(1, Math.round(info.maxBytes / 1024))} Ko)` : "";
  return `Cette modification est trop volumineuse pour être synchronisée${limit} et n’a pas été envoyée.`;
}

export class EncryptedYjsProvider {
  readonly doc: Y.Doc;
  awareness: Awareness;
  private readonly channel: EncryptedCollabChannel;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private destroyed = false;
  private readonly user: CollabUser;
  private boundAwareness: BoundAwareness;
  private readonly names = new Map<string, Promise<string>>();
  private readonly onAwUpdate: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;

  constructor(
    api: DriveApi,
    nodeId: string,
    nodeKey: Uint8Array,
    doc: Y.Doc,
    user: CollabUser,
    opts: {
      onStatus?: (s: CollabStatus) => void;
      onReady?: (canWrite: boolean) => void;
      /** Message à afficher à l’utilisateur (mise à jour refusée : trop volumineuse / quota). */
      onNotice?: (message: string) => void;
      /** Re-unwrap the node key after a rotation eviction (relay close 4001). */
      refetchKey?: () => Promise<Uint8Array | null>;
    } = {},
  ) {
    this.doc = doc;
    this.user = user;
    this.awareness = new Awareness(doc);
    this.boundAwareness = new BoundAwareness(this.awareness);
    this.awareness.setLocalStateField("user", user);

    this.channel = new EncryptedCollabChannel(api, nodeId, nodeKey, {
      onRemoteUpdate: (update) => {
        Y.applyUpdate(this.doc, update, "remote");
      },
      // Rattrapage : tout le journal dans UNE transaction Yjs (un seul événement d'observation,
      // donc une seule transaction ProseMirror / un seul rendu au lieu d'un par mise à jour).
      onBacklog: (updates) => {
        this.doc.transact(() => {
          for (const u of updates) Y.applyUpdate(this.doc, u, "remote");
        }, "remote");
      },
      onAwareness: (payload, from, peerId) => {
        const p = payload as { u?: string };
        if (typeof p?.u === "string" && p.u.length <= 64 * 1024 && /^[0-9a-f]+$/i.test(p.u) && from && peerId) {
          let name = this.names.get(from);
          if (!name) {
            name = api.getUser(from).then(({ user }) => typeof user.displayName === "string" ? user.displayName : "Participant");
            this.names.set(from, name);
          }
          const bound = this.boundAwareness;
          void name.then((n) => { if (!this.destroyed && bound === this.boundAwareness) bound.apply(fromHex(p.u!), from, peerId, n); })
            .catch(() => { this.names.delete(from); });
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
      onUpdateRejected: (info) => opts.onNotice?.(updateRejectedMessage(info)),
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
      const changed = added.concat(updated, removed).filter((id) => id === this.doc.clientID);
      if (!changed.length) return;
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

  /**
   * Replay the encrypted history, then go live. Peut être rappelé après `destroy()` (React StrictMode en
   * développement monte, démonte puis remonte l'effet sur la MÊME instance) : les écouteurs du document et
   * de la présence sont alors remis en place, sinon plus aucune modification locale ne partirait.
   */
  async connect(): Promise<void> {
    if (this.destroyed) {
      this.destroyed = false;
      this.awareness = new Awareness(this.doc);
      this.boundAwareness = new BoundAwareness(this.awareness);
      this.awareness.setLocalStateField("user", this.user);
      this.doc.on("update", this.onDocUpdate);
      this.awareness.on("update", this.onAwUpdate);
    }
    await this.channel.connect();
  }

  destroy(): void {
    this.destroyed = true;
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
