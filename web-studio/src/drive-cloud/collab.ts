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
  onAwareness?: (payload: unknown, from: string, peerId: string) => void;
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
  /**
   * Une mise à jour locale a été REFUSÉE de façon définitive (trop grosse, quota d'organisation
   * dépassé…). Elle est retirée de la file de renvoi (aucune boucle de reconnexion) : l'interface doit
   * en informer l'utilisateur (découper / réduire le contenu, contacter l'administrateur).
   */
  onUpdateRejected?: (info: {
    code: "update_too_large" | "quota_exceeded";
    maxBytes?: number;
    update: Uint8Array | null;
  }) => void;
}

/** Plafond par défaut d'un message chiffré (miroir de `MAX_COLLAB_MESSAGE_BYTES` côté serveur). */
export const DEFAULT_MAX_COLLAB_MESSAGE_BYTES = 512 * 1024;
/** Surcoût AES-GCM (tag d'authentification) ajouté au texte clair. */
const GCM_TAG_BYTES = 16;

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
  private ready = false;
  private maxMessageBytes = DEFAULT_MAX_COLLAB_MESSAGE_BYTES;

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
    if (batch.length) this.deliver(() => this.handlers.onBacklog?.(batch));
  }

  /**
   * Remet des mises à jour à l'éditeur SANS laisser une exception remonter : un état forgé par un co-auteur
   * (codec CRDT qui lève dans un observateur) ne doit jamais empêcher l'ouverture du socket ni bloquer
   * le rattrapage — le document reste ouvrable et réparable.
   */
  private deliver(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.warn("[collab] mise à jour distante ignorée par l'éditeur :", e);
    }
  }

  /**
   * Clés de repli (fente « clé précédente » du nœud) : après une rotation dont la compaction a échoué, le
   * journal contient encore des entrées sous l'ancienne clé — on les lit au lieu de les sauter (sinon le
   * document s'ouvre vide). Chargées paresseusement, une fois par clé courante.
   */
  private fallbackFor: Uint8Array | null = null;
  private fallbackKeys: Promise<Uint8Array[]> | null = null;
  private loadFallbackKeys(): Promise<Uint8Array[]> {
    if (this.fallbackKeys && this.fallbackFor === this.nodeKey) return this.fallbackKeys;
    const current = this.nodeKey;
    this.fallbackFor = current;
    this.fallbackKeys = (async () => {
      if (typeof this.api.getNode !== "function") return [];
      try {
        const { node } = await this.api.getNode(this.nodeId);
        if (!node?.prevKeyWrapped || !node.prevKeyNonce) return [];
        return [await decryptContent(current, node.prevKeyNonce, fromHex(node.prevKeyWrapped))];
      } catch {
        return [];
      }
    })();
    return this.fallbackKeys;
  }

  /** Déchiffre avec la clé courante, puis avec la clé précédente du nœud. */
  private async decryptAny(nonce: string, ct: Uint8Array): Promise<Uint8Array> {
    try {
      return await decryptContent(this.nodeKey, nonce, ct);
    } catch (e) {
      for (const k of await this.loadFallbackKeys()) {
        try {
          return await decryptContent(k, nonce, ct);
        } catch {
          /* clé suivante */
        }
      }
      throw e;
    }
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
        const plain = await this.decryptAny(u.nonce, fromHex(u.ciphertext));
        if (this.handlers.onBacklog) batch.push(plain);
        else this.deliver(() => this.handlers.onRemoteUpdate?.(plain, u.author, u.seq));
      } catch {
        /* illisible avec la clé courante ET la précédente : ignorée (jamais bloquante) */
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
    this.ready = false;
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
      // Wait for admission and a key refresh before sending buffered plaintext.
      this.handlers.onStatus?.("connecting");
    };
    ws.onclose = (ev) => {
      this.ready = false;
      if (!this.closedByUser) {
        this.outbox.push(...this.unacknowledged.values());
        this.unacknowledged.clear();
      }
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
      peerId?: string;
      payload?: unknown;
      canWrite?: boolean;
      code?: string;
      maxBytes?: number;
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "ready") {
      const ws = this.ws;
      try {
        if (this.handlers.refetchKey) {
          const fresh = await this.handlers.refetchKey();
          if (!fresh) { this.handlers.onStatus?.("revoked"); this.close(); return; }
          this.nodeKey = fresh;
          this.lastSeq = 0;
          await this.catchUp();
        }
        if (this.closedByUser || ws !== this.ws || ws?.readyState !== WebSocket.OPEN) return;
      } catch {
        ws?.close(4001, "key-refresh-failed");
        return;
      }
      this.ready = !!msg.canWrite;
      this.handlers.onReady?.(!!msg.canWrite);
      this.handlers.onStatus?.("open");
      if (this.ready) this.flushOutbox();
    } else if (msg.type === "ack" && msg.nonce) {
      this.unacknowledged.delete(msg.nonce);
    } else if (msg.type === "error" && (msg.code === "update_too_large" || msg.code === "quota_exceeded")) {
      // Refus DÉFINITIF : rejouer la même mise à jour échouerait à l'identique, en boucle. On la retire
      // de la file, on prévient l'interface et on garde la connexion (les autres mises à jour continuent).
      if (typeof msg.maxBytes === "number" && msg.maxBytes > 0) this.maxMessageBytes = msg.maxBytes;
      let rejected: Uint8Array | null = null;
      if (msg.nonce && this.unacknowledged.has(msg.nonce)) {
        rejected = this.unacknowledged.get(msg.nonce)!;
        this.unacknowledged.delete(msg.nonce);
      } else if (!msg.nonce) {
        // Trame hors limite : le serveur n'a pas pu lire le nonce, la dernière envoyée est la fautive.
        const lastKey = [...this.unacknowledged.keys()].pop();
        if (lastKey !== undefined) {
          rejected = this.unacknowledged.get(lastKey)!;
          this.unacknowledged.delete(lastKey);
        }
      }
      this.handlers.onUpdateRejected?.({ code: msg.code, maxBytes: msg.maxBytes, update: rejected });
    } else if (msg.type === "error") {
      // Plaintext remains in the outbox until the server acknowledges durable storage.
      this.ready = false;
      this.ws?.close(msg.code === "key_rotation_required" ? 4001 : 4000, "update-rejected");
    } else if (msg.type === "update" && msg.ciphertext && msg.nonce) {
      if (typeof msg.seq === "number") this.lastSeq = Math.max(this.lastSeq, msg.seq);
      try {
        const plain = await this.decryptAny(msg.nonce, fromHex(msg.ciphertext));
        this.deliver(() => this.handlers.onRemoteUpdate?.(plain, msg.author ?? null, msg.seq ?? null));
      } catch {
        /* ignore undecryptable */
      }
    } else if (msg.type === "awareness") {
      try {
        const raw = msg.payload as { c?: string; n?: string } | undefined;
        if (raw?.c && raw?.n) {
          const plain = await decryptContent(this.nodeKey, raw.n, fromHex(raw.c));
          const parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown;
          this.deliver(() => this.handlers.onAwareness?.(parsed, msg.from ?? "", msg.peerId ?? ""));
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
  private unacknowledged = new Map<string, Uint8Array>();
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
    // Contrôle de taille AVANT envoi : inutile de chiffrer/transmettre ce que le relais refusera.
    if (update.byteLength + GCM_TAG_BYTES > this.maxMessageBytes) {
      this.handlers.onUpdateRejected?.({ code: "update_too_large", maxBytes: this.maxMessageBytes, update });
      return;
    }
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) {
      this.outbox.push(update);
      return;
    }
    const sendingKey = this.nodeKey;
    const sendingSocket = this.ws;
    const enc = await encryptContent(sendingKey, update);
    // Le socket a pu se fermer pendant le chiffrement : on garde la mise à jour pour la reconnexion.
    const ws = this.ws;
    if (!this.ready || ws !== sendingSocket || this.nodeKey !== sendingKey || ws?.readyState !== WebSocket.OPEN) {
      this.outbox.push(update);
      return;
    }
    this.unacknowledged.set(enc.nonceHex, update);
    try {
      ws.send(JSON.stringify({ type: "update", ciphertext: toHex(enc.ciphertext), nonce: enc.nonceHex }));
    } catch {
      this.unacknowledged.delete(enc.nonceHex);
      this.outbox.push(update);
    }
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
