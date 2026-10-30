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
  /**
   * Journal de rattrapage complet, déchiffré, d'un seul bloc. S'il est fourni, il remplace les appels
   * `onRemoteUpdate` du rattrapage : l'appelant l'applique en UNE transaction (un seul rendu éditeur).
   */
  onBacklog?: (updates: Uint8Array[]) => void;
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

/** Taille de page du serveur, utilisée si une réponse ancienne n'indique pas `hasMore`. */
const COLLAB_PAGE_FALLBACK = 5000;

/**
 * Lit TOUT le journal chiffré d'un nœud, page après page. Renvoie les mises à jour et le dernier
 * numéro de séquence lu (pour une compaction qui ne supprime que ce qui a été lu).
 */
export async function readAllCollabUpdates(
  api: Pick<DriveApi, "getCollabUpdates">,
  nodeId: string,
): Promise<{ updates: { seq: number; ciphertext: string; nonce: string; author: string | null }[]; lastSeq: number }> {
  const all: { seq: number; ciphertext: string; nonce: string; author: string | null }[] = [];
  let since = 0;
  for (;;) {
    const page = await api.getCollabUpdates(nodeId, since);
    all.push(...page.updates);
    const last = page.updates.length ? Math.max(...page.updates.map((u) => u.seq)) : since;
    const more = page.hasMore ?? page.updates.length >= COLLAB_PAGE_FALLBACK;
    if (!more || last <= since) return { updates: all, lastSeq: Math.max(since, last) };
    since = last;
  }
}

export class EncryptedCollabChannel {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private closedByUser = false;
  private generation = 0;

  constructor(
    private readonly api: DriveApi,
    private readonly nodeId: string,
    private nodeKey: Uint8Array,
    private readonly handlers: CollabHandlers = {},
  ) {}

  /** Replay the encrypted backlog, then open the live socket. */
  async connect(): Promise<void> {
    this.closedByUser = false;
    // Génération : si `close()` ou un nouveau `connect()` survient pendant le rattrapage, ce connect-ci n'ouvre
    // PAS de socket (sinon deux sockets vivants, dont un jamais fermé — double montage d'effet en développement).
    const gen = ++this.generation;
    await this.catchUp();
    if (gen !== this.generation || this.closedByUser) return;
    await this.open();
  }

  private async catchUp(): Promise<void> {
    const batch: Uint8Array[] = [];
    let sliceStart = performance.now();
    // Le serveur renvoie le journal PAR PAGES : on boucle jusqu'à la fin, sinon un document de
    // plus d'une page diverge silencieusement.
    for (;;) {
      const page = await this.api.getCollabUpdates(this.nodeId, this.lastSeq);
      const before = this.lastSeq;
      sliceStart = await this.replayPage(page.updates, batch, sliceStart);
      const more = page.hasMore ?? page.updates.length >= COLLAB_PAGE_FALLBACK;
      if (!more || this.lastSeq === before) break; // finie, ou aucun progrès (garde anti-boucle)
    }
    if (batch.length) this.handlers.onBacklog?.(batch);
  }

  private async replayPage(
    updates: { seq: number; ciphertext: string; nonce: string; author: string | null }[],
    batch: Uint8Array[],
    sliceStartIn: number,
  ): Promise<number> {
    let sliceStart = sliceStartIn;
    for (const u of updates) {
      this.lastSeq = Math.max(this.lastSeq, u.seq);
      try {
        const plain = await decryptContent(this.nodeKey, u.nonce, fromHex(u.ciphertext));
        if (this.handlers.onBacklog) batch.push(plain);
        else this.handlers.onRemoteUpdate?.(plain, u.author, u.seq);
      } catch {
        /* skip an update we cannot decrypt (should not happen with the right key) */
      }
      // Journal de milliers d'entrées : rendre la main au navigateur entre deux tranches de ~40 ms.
      if (performance.now() - sliceStart > 40) {
        await new Promise<void>((r) => setTimeout(r, 0));
        sliceStart = performance.now();
      }
    }
    return sliceStart;
  }

  private async open(): Promise<void> {
    this.handlers.onStatus?.("connecting");
    const gen = this.generation;
    let url: string;
    try {
      // Ticket à usage unique (CLIENT-10) quand l'API le propose ; sinon (doublures de test) URL héritée.
      url =
        typeof this.api.collabSocketUrlTicket === "function"
          ? await this.api.collabSocketUrlTicket(this.nodeId)
          : this.api.collabSocketUrl(this.nodeId);
    } catch {
      // Ticket indisponible (réseau, session expirée…) : même traitement qu'une coupure — on retente.
      this.handlers.onStatus?.("closed");
      if (!this.closedByUser && gen === this.generation) setTimeout(() => void this.reconnect(), 1500);
      return;
    }
    // close()/nouveau connect() pendant l'obtention du ticket : ne pas ouvrir de socket orphelin.
    if (this.closedByUser || gen !== this.generation) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.handlers.onStatus?.("open");
      this.flushOutbox();
    };
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
    await this.open();
  }

  private async onMessage(data: string): Promise<void> {
    let msg: {
      type?: string;
      ciphertext?: string;
      nonce?: string;
      seq?: number;
      author?: string | null;
      from?: string;
      payload?: unknown;
      canWrite?: boolean;
    };
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

  /**
   * Mises à jour locales non encore parties (socket fermé ou en reconnexion) : elles sont conservées et
   * renvoyées à la réouverture — sans cela, une modification faite pendant une coupure serait perdue
   * (le relais ne renvoie que le journal, jamais l'état local d'un client).
   */
  private outbox: Uint8Array[] = [];
  /** Envois en cours de chiffrement : `close()` les attend avant de fermer le socket. */
  private readonly inflight = new Set<Promise<void>>();

  private flushOutbox(): void {
    const pending = this.outbox;
    this.outbox = [];
    for (const u of pending) void this.sendUpdate(u);
  }

  /** Encrypt and broadcast a local CRDT update. */
  sendUpdate(update: Uint8Array): Promise<void> {
    if (this.closedByUser) return Promise.resolve();
    const task = this.sendNow(update).finally(() => this.inflight.delete(task));
    this.inflight.add(task);
    return task;
  }

  private async sendNow(update: Uint8Array): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.outbox.push(update);
      return;
    }
    const enc = await encryptContent(this.nodeKey, update);
    // Le socket a pu se fermer pendant le chiffrement : on garde la mise à jour pour la reconnexion.
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      this.outbox.push(update);
      return;
    }
    ws.send(JSON.stringify({ type: "update", ciphertext: toHex(enc.ciphertext), nonce: enc.nonceHex }));
  }

  /** Encrypt and broadcast a presence/awareness payload. */
  async sendAwareness(payload: unknown): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const enc = await encryptContent(this.nodeKey, new TextEncoder().encode(JSON.stringify(payload)));
    // Le socket peut avoir été fermé pendant le chiffrement (fermeture du document) : relire avant d'écrire.
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "awareness", payload: { c: toHex(enc.ciphertext), n: enc.nonceHex } }));
  }

  close(): void {
    this.closedByUser = true;
    this.generation++;
    const ws = this.ws;
    // Laisser partir les modifications en cours de chiffrement avant de couper : fermer le document juste
    // après une frappe ne doit pas perdre la dernière modification (le socket reste donc référencé).
    void Promise.allSettled([...this.inflight]).then(() => {
      ws?.close();
      if (this.ws === ws) this.ws = null;
    });
  }
}
