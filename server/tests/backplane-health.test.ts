/**
 * Backplane Redis : santé pub/sub INDÉPENDANTE (server/src/collab/backplane.ts).
 *
 * Régression pour un bug de revue : `pub` (publication de nos events vers les
 * autres instances) et `sub` (réception des LEURS) sont deux connexions
 * ioredis distinctes. Avant ce correctif, elles partageaient un seul booléen
 * `healthy` — si `sub` tombait (plus aucun événement collab distant reçu) puis
 * qu'un `publishRelay()` réussissait sur `pub` (toujours up), `markSuccess()`
 * remettait l'état global à "ok", masquant la vraie dégradation. `/api/health`
 * annonçait alors "ok" pendant une panne réelle du relais entrant — exactement
 * ce que le suivi de santé devait empêcher.
 *
 * `ioredis` est mocké par un faux client événementiel (EventEmitter) pour
 * piloter indépendamment les événements "error"/"ready" de chaque connexion,
 * sans dépendre d'un vrai serveur Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../src/config.js", () => ({
  config: { redisUrl: "redis://localhost:6379/0" },
}));

class FakeRedis extends EventEmitter {
  static instances: FakeRedis[] = [];
  subscribe = vi.fn().mockResolvedValue(undefined);
  publish = vi.fn().mockResolvedValue(1);
  quit = vi.fn().mockResolvedValue("OK");
  constructor() {
    super();
    FakeRedis.instances.push(this);
  }
}

vi.mock("ioredis", () => ({ default: FakeRedis }));

/** Laisse les microtasks (`.then()` de `publishRelay`) s'exécuter. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("backplane: santé pub/sub indépendante", () => {
  beforeEach(() => {
    FakeRedis.instances.length = 0;
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("un sub cassé reste 'degraded' même si pub reste sain et publie avec succès ensuite", async () => {
    const { initBackplane, getBackplaneHealth, publishRelay, closeBackplane } = await import(
      "../src/collab/backplane.js"
    );
    initBackplane(() => {});
    const [pub, sub] = FakeRedis.instances;
    expect(pub).toBeDefined();
    expect(sub).toBeDefined();

    // Les deux connexions démarrent saines.
    pub!.emit("ready");
    sub!.emit("ready");
    expect(getBackplaneHealth().status).toBe("ok");

    // Le sub tombe : cette instance ne reçoit plus AUCUN événement distant.
    sub!.emit("error", new Error("ECONNRESET (sub)"));
    expect(getBackplaneHealth().status).toBe("degraded");
    expect(getBackplaneHealth().sub.healthy).toBe(false);
    expect(getBackplaneHealth().pub.healthy).toBe(true);

    // pub reste up et publie un événement avec succès (markSuccess() côté pub).
    publishRelay({ k: "org", orgId: "00000000-0000-4000-8000-000000000001" });
    await flush();
    expect(pub!.publish).toHaveBeenCalledTimes(1);

    // Le succès de pub NE DOIT PAS masquer l'échec de sub : toujours dégradé.
    const health = getBackplaneHealth();
    expect(health.status).toBe("degraded");
    expect(health.pub.healthy).toBe(true);
    expect(health.sub.healthy).toBe(false);

    await closeBackplane();
  });

  it("symétriquement, un pub cassé reste 'degraded' même si sub reste sain", async () => {
    const { initBackplane, getBackplaneHealth, closeBackplane } = await import("../src/collab/backplane.js");
    initBackplane(() => {});
    const [pub, sub] = FakeRedis.instances;

    pub!.emit("ready");
    sub!.emit("ready");
    expect(getBackplaneHealth().status).toBe("ok");

    pub!.emit("error", new Error("ECONNRESET (pub)"));
    expect(getBackplaneHealth().status).toBe("degraded");
    expect(getBackplaneHealth().pub.healthy).toBe(false);
    expect(getBackplaneHealth().sub.healthy).toBe(true);

    await closeBackplane();
  });

  it("redevient 'ok' seulement quand pub ET sub sont rétablis", async () => {
    const { initBackplane, getBackplaneHealth, closeBackplane } = await import("../src/collab/backplane.js");
    initBackplane(() => {});
    const [pub, sub] = FakeRedis.instances;

    sub!.emit("error", new Error("down"));
    pub!.emit("error", new Error("down"));
    expect(getBackplaneHealth().status).toBe("degraded");

    // Rétablir seulement pub : encore dégradé (sub toujours cassé).
    pub!.emit("ready");
    expect(getBackplaneHealth().status).toBe("degraded");

    // Rétablir sub aussi : de nouveau ok.
    sub!.emit("ready");
    expect(getBackplaneHealth().status).toBe("ok");

    await closeBackplane();
  });
});
