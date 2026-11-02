/**
 * Relais de collaboration (WebSocket) — audit 2026-11, lot A2 :
 *  - une mise à jour refusée (trop grosse, mal formée, pair en lecture seule,
 *    échec d'écriture en base) renvoie une erreur EXPLICITE à l'émetteur au lieu
 *    d'être perdue en silence ; une mise à jour persistée est acquittée.
 * Les gestionnaires WS sont extraits via un faux `app` (pas de vrai serveur).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const USER = "00000000-0000-4000-8000-0000000000aa";
const NODE = "00000000-0000-4000-8000-0000000000bb";
const ORG = "00000000-0000-4000-8000-0000000000cc";
const NONCE = "0123456789abcdef01234567";

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
}));
vi.mock("../src/lib/tokens.js", () => ({ verifyAccessToken: vi.fn() }));
vi.mock("../src/lib/ws-tickets.js", () => ({
  issueWsTicket: vi.fn(),
  consumeWsTicket: vi.fn(async () => ({
    sub: USER,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
}));
vi.mock("../src/middleware/auth.js", () => ({
  authenticate: vi.fn(),
  requireUser: vi.fn(),
  requireNodePerm: vi.fn(),
}));
vi.mock("../src/rbac/engine.js", () => ({ resolveNodeAccess: vi.fn() }));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("../src/lib/site-settings.js", () => ({ mfaEnrollmentRequired: vi.fn(async () => false) }));
vi.mock("../src/collab/backplane.js", () => ({ initBackplane: vi.fn(), publishRelay: vi.fn() }));
vi.mock("../src/lib/disk.js", () => ({ assertDiskSpace: vi.fn(async () => {}) }));

import { queryOne } from "../src/db/pool.js";
import { resolveNodeAccess } from "../src/rbac/engine.js";
import { config } from "../src/config.js";
import { registerCollab, resetCollabStorageGuardsForTests } from "../src/collab/relay.js";
import { assertDiskSpace } from "../src/lib/disk.js";

const mQueryOne = vi.mocked(queryOne);
const mResolve = vi.mocked(resolveNodeAccess);

type Handler = (socket: unknown, req: unknown) => Promise<void>;
const handlers: Record<string, Handler> = {};
const fakeApp = {
  get: (path: string, _opts: unknown, h: Handler) => {
    handlers[`GET ${path}`] = h;
  },
  post: (path: string, _opts: unknown, h: Handler) => {
    handlers[`POST ${path}`] = h;
  },
  log: { info: () => {}, warn: () => {}, error: () => {} },
};

class FakeSocket extends EventEmitter {
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.emit("close");
  }
}

const flush = () => new Promise((r) => setTimeout(r, 10));

async function openRoom(canWrite: boolean): Promise<FakeSocket> {
  mResolve.mockResolvedValue({
    nodeId: NODE,
    orgId: ORG,
    ownerUserId: USER,
    kind: "file",
    trashed: false,
    isOwner: false,
    permissions: new Set(canWrite ? ["node.view", "node.edit"] : ["node.view"]),
    accessible: true,
  } as never);
  const socket = new FakeSocket();
  await handlers["GET /api/collab/:nodeId"]!(socket, { params: { nodeId: NODE }, query: { ticket: "t" } });
  return socket;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mQueryOne.mockImplementation((async (sql: string) => {
    if (/FROM users/.test(sql)) return { status: "active", token_epoch: new Date(0).toISOString() };
    if (/INSERT INTO collab_updates/.test(sql)) return { id: 42 };
    return null;
  }) as never);
  resetCollabStorageGuardsForTests();
  if (!handlers["GET /api/collab/:nodeId"]) await registerCollab(fakeApp as never);
});

describe("relais collab : refus explicites et accusés de réception", () => {
  it("une mise à jour trop grosse renvoie update_too_large (avec le nonce et le plafond)", async () => {
    const s = await openRoom(true);
    const ct = "ab".repeat(config.maxCollabMessageBytes + 1);
    s.emit("message", JSON.stringify({ type: "update", ciphertext: ct, nonce: NONCE }));
    await flush();
    const err = s.sent.find((m) => m.type === "error");
    expect(err).toBeDefined();
    expect(err!.code).toBe("update_too_large");
    s.close();
  });

  it("une trame au-delà de la garde applicative renvoie aussi update_too_large", async () => {
    const s = await openRoom(true);
    s.emit("message", "x".repeat(config.maxCollabMessageBytes * 2 + 5000));
    await flush();
    expect(s.sent.find((m) => m.type === "error")).toMatchObject({
      code: "update_too_large",
      maxBytes: config.maxCollabMessageBytes,
    });
    s.close();
  });

  it("un pair en lecture seule reçoit read_only", async () => {
    const s = await openRoom(false);
    s.emit("message", JSON.stringify({ type: "update", ciphertext: "abcd", nonce: NONCE }));
    await flush();
    expect(s.sent.find((m) => m.type === "error")).toMatchObject({ code: "read_only", nonce: NONCE });
    s.close();
  });

  it("une mise à jour persistée est acquittée (ack + seq)", async () => {
    const s = await openRoom(true);
    s.emit("message", JSON.stringify({ type: "update", ciphertext: "abcd", nonce: NONCE }));
    await flush();
    expect(s.sent.find((m) => m.type === "ack")).toEqual({ type: "ack", nonce: NONCE, seq: 42 });
    s.close();
  });

  it("un échec d'écriture en base renvoie persist_failed au lieu d'être avalé", async () => {
    const s = await openRoom(true);
    mQueryOne.mockImplementation((async (sql: string) => {
      if (/INSERT INTO collab_updates/.test(sql)) throw new Error("db down");
      return null;
    }) as never);
    s.emit("message", JSON.stringify({ type: "update", ciphertext: "abcd", nonce: NONCE }));
    await flush();
    expect(s.sent.find((m) => m.type === "error")).toMatchObject({ code: "persist_failed", nonce: NONCE });
    s.close();
  });
});

describe("relais collab : fermeture pendant l'admission (pas de fuite du compteur)", () => {
  it("salle de document : un client parti pendant les await ne consomme pas de place", async () => {
    const n = config.maxCollabConnectionsPerUser + 2;
    for (let i = 0; i < n; i++) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      mResolve.mockImplementationOnce((async () => {
        await gate;
        return {
          nodeId: NODE,
          orgId: ORG,
          ownerUserId: USER,
          kind: "file",
          trashed: false,
          isOwner: false,
          permissions: new Set(["node.view", "node.edit"]),
          accessible: true,
        };
      }) as never);
      const s = new FakeSocket();
      const pending = handlers["GET /api/collab/:nodeId"]!(s, { params: { nodeId: NODE }, query: { ticket: "t" } });
      await flush();
      s.close(1001, "going away"); // le client part pendant resolveNodeAccess
      release();
      await pending;
      expect(s.sent).toEqual([]); // jamais admis
    }
    // Le compteur n'a pas fui : une connexion normale passe encore.
    const ok = await openRoom(true);
    expect(ok.closed).toBeNull();
    expect(ok.sent[0]).toMatchObject({ type: "ready" });
    ok.close();
  });

  it("canal d'événements : même garantie", async () => {
    const n = config.maxCollabConnectionsPerUser + 2;
    for (let i = 0; i < n; i++) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      mQueryOne.mockImplementation((async (sql: string) => {
        if (/FROM users/.test(sql)) return { status: "active", token_epoch: new Date(0).toISOString() };
        if (/FROM memberships/.test(sql)) {
          await gate;
          return { ok: 1 };
        }
        return null;
      }) as never);
      const s = new FakeSocket();
      const pending = handlers["GET /api/events/:orgId"]!(s, { params: { orgId: ORG }, query: { ticket: "t" } });
      await flush();
      s.close(1001, "going away");
      release();
      await pending;
      expect(s.sent).toEqual([]);
    }
    mQueryOne.mockImplementation((async (sql: string) => {
      if (/FROM users/.test(sql)) return { status: "active", token_epoch: new Date(0).toISOString() };
      if (/FROM memberships/.test(sql)) return { ok: 1 };
      return null;
    }) as never);
    const s = new FakeSocket();
    await handlers["GET /api/events/:orgId"]!(s, { params: { orgId: ORG }, query: { ticket: "t" } });
    expect(s.closed).toBeNull();
    expect(s.sent[0]).toMatchObject({ type: "ready" });
    s.close();
  });
});

describe("relais collab : garde-fous de stockage du journal", () => {
  const send = (s: FakeSocket, ct = "abcd") =>
    s.emit("message", JSON.stringify({ type: "update", ciphertext: ct, nonce: NONCE }));

  it("quota d'organisation (versions + journal collab) atteint : quota_exceeded, rien n'est inséré", async () => {
    const s = await openRoom(true);
    const sqls: string[] = [];
    mQueryOne.mockImplementation((async (sql: string) => {
      sqls.push(sql);
      if (/FROM organizations o/.test(sql)) return { quota: 100, used: 99 };
      return null;
    }) as never);
    send(s, "aabbcc"); // 3 octets > 1 restant
    await flush();
    expect(s.sent.find((m) => m.type === "error")).toMatchObject({ code: "quota_exceeded", nonce: NONCE });
    expect(sqls.find((q) => /FROM organizations o/.test(q))).toMatch(/collab_updates/);
    expect(sqls.some((q) => /INSERT INTO collab_updates/.test(q))).toBe(false);
    s.close();
  });

  it("disque sous la marge : disk_full", async () => {
    vi.mocked(assertDiskSpace).mockRejectedValueOnce(new Error("507"));
    const s = await openRoom(true);
    send(s);
    await flush();
    expect(s.sent.find((m) => m.type === "error")).toMatchObject({ code: "disk_full" });
    s.close();
  });

  it("budget d'octets par utilisateur et par minute : rate_limited_bytes", async () => {
    const s = await openRoom(true);
    const big = "ab".repeat(config.maxCollabMessageBytes);
    const max = Math.floor(config.maxCollabBytesPerUserPerMinute / config.maxCollabMessageBytes);
    for (let i = 0; i <= max; i++) {
      send(s, big);
      await flush();
    }
    const codes = s.sent.filter((m) => m.type === "error").map((m) => m.code);
    expect(codes).toContain("rate_limited_bytes");
    expect(s.sent.filter((m) => m.type === "ack").length).toBe(max);
    s.close();
  });
});
