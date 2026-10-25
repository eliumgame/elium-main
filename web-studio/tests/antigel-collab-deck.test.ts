import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { SlideReader, slideToY, syncYText, ensureYText } from "../src/drive-cloud/collab-slides-crdt";
import { EncryptedCollabChannel } from "../src/drive-cloud/collab";
import { EncryptedYjsProvider } from "../src/drive-cloud/collab-provider";
import { encryptContent } from "../src/drive-cloud/node-crypto";
import { toHex, fromHex } from "../src/format/canonical";
import type { Slide } from "../src/slides/model";

type YMap = Y.Map<unknown>;

const mk = (id: string): Slide => ({
  id,
  title: id,
  body: "",
  bodyHtml: "",
  layout: "blank",
  elements: [{ id: `${id}-e`, type: "text", x: 1, y: 1, w: 10, h: 10, html: "<p>x</p>" }],
});

function setup(n: number) {
  const doc = new Y.Doc();
  const deck = doc.getMap("deck");
  const arr = new Y.Array<YMap>();
  arr.push(Array.from({ length: n }, (_, i) => slideToY(mk(`s${i}`))));
  deck.set("slides", arr);
  const reader = new SlideReader();
  deck.observeDeep((events) => reader.invalidate(events, deck.get("slides") as Y.Array<YMap>));
  return { doc, deck, arr, reader };
}

describe("SlideReader (lecture incrémentale du deck)", () => {
  it("renvoie les mêmes références pour les diapositives inchangées", () => {
    const { doc, arr, reader } = setup(5);
    const a = reader.read(arr);
    const b = reader.read(arr);
    expect(b).toBe(a); // aucun changement : même tableau
    doc.transact(() => {
      const els = arr.get(2).get("elements") as Y.Array<YMap>;
      els.get(0).set("x", 55);
    });
    const c = reader.read(arr);
    expect(c).not.toBe(a);
    c.forEach((s, i) => {
      if (i === 2) expect(s).not.toBe(a[i]);
      else expect(s).toBe(a[i]);
    });
    expect(c[2].elements?.[0].x).toBe(55);
  });

  it("suit une frappe dans un Y.Text imbriqué et un déplacement de diapositive", () => {
    const { doc, arr, reader } = setup(4);
    const a = reader.read(arr);
    doc.transact(() => {
      const el = (arr.get(1).get("elements") as Y.Array<YMap>).get(0);
      syncYText(ensureYText(el, "html"), "<p>nouveau</p>");
    });
    const b = reader.read(arr);
    expect(b[1].elements?.[0].html).toBe("<p>nouveau</p>");
    expect(b[0]).toBe(a[0]);
    expect(b[3]).toBe(a[3]);
    // insertion en tête : les anciennes diapositives gardent leur référence
    doc.transact(() => arr.insert(0, [slideToY(mk("neuf"))]));
    const c = reader.read(arr);
    expect(c.map((s) => s.id)).toEqual(["neuf", "s0", "s1", "s2", "s3"]);
    expect(c[1]).toBe(b[0]);
    expect(c[4]).toBe(b[3]);
  });

  it("deck sans tableau de diapositives : liste vide stable", () => {
    const reader = new SlideReader();
    expect(reader.read(undefined)).toEqual([]);
  });
});

describe("toHex / fromHex", () => {
  it("fait l'aller-retour sur de petits et gros tampons", () => {
    for (const n of [0, 1, 255, 4096, 4097, 100_000]) {
      const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      const h = toHex(b);
      expect(h.length).toBe(n * 2);
      expect(fromHex(h)).toEqual(b);
    }
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
    expect(fromHex("00FF0a")).toEqual(new Uint8Array([0, 255, 10]));
    expect(() => fromHex("abc")).toThrow();
  });
});

describe("rattrapage du journal Drive", () => {
  it("remet tout le journal en un seul bloc (onBacklog) au lieu d'un appel par mise à jour", async () => {
    const key = new Uint8Array(32).fill(7);
    const src = new Y.Doc();
    const updates: Uint8Array[] = [];
    src.on("update", (u: Uint8Array) => updates.push(u));
    const t = src.getText("t");
    for (let i = 0; i < 60; i++) t.insert(t.length, `m${i} `);
    const rows = [] as { seq: number; nonce: string; ciphertext: string; author: string | null }[];
    for (const [i, u] of updates.entries()) {
      const enc = await encryptContent(key, u);
      rows.push({ seq: i + 1, nonce: enc.nonceHex, ciphertext: toHex(enc.ciphertext), author: null });
    }
    const api = { getCollabUpdates: async () => ({ updates: rows }) };
    let blocks = 0;
    let singles = 0;
    let got: Uint8Array[] = [];
    const ch = new EncryptedCollabChannel(api as never, "n", key, {
      onBacklog: (u) => {
        blocks++;
        got = u;
      },
      onRemoteUpdate: () => singles++,
    });
    await (ch as unknown as { catchUp(): Promise<void> }).catchUp();
    expect(blocks).toBe(1);
    expect(singles).toBe(0);
    expect(got).toHaveLength(60);
    // appliqué en UNE transaction : un seul événement d'observation
    const dst = new Y.Doc();
    let obs = 0;
    dst.getText("t").observe(() => obs++);
    dst.transact(() => got.forEach((u) => Y.applyUpdate(dst, u, "remote")), "remote");
    expect(obs).toBe(1);
    expect(dst.getText("t").toString()).toBe(t.toString());
  });
});

describe("canal chiffré : aucune modification perdue", () => {
  /** WebSocket factice : on contrôle ouverture, fermeture et ce qui est réellement envoyé. */
  class FakeWS {
    static OPEN = 1;
    static instances: FakeWS[] = [];
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor() {
      FakeWS.instances.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    send(d: string) {
      this.sent.push(d);
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  }
  const mkChannel = () => {
    const api = { getCollabUpdates: async () => ({ updates: [] }), collabSocketUrl: () => "ws://x" };
    return new EncryptedCollabChannel(api as never, "n", new Uint8Array(32).fill(3), {});
  };

  it("une mise à jour faite pendant une coupure est renvoyée à la réouverture", async () => {
    const g = globalThis as unknown as { WebSocket: unknown };
    const prev = g.WebSocket;
    g.WebSocket = FakeWS;
    FakeWS.instances = [];
    try {
      const ch = mkChannel();
      await ch.connect();
      const ws = FakeWS.instances[0]!;
      await ch.sendUpdate(new Uint8Array([1, 2, 3])); // socket pas encore ouvert
      expect(ws.sent).toHaveLength(0);
      ws.open(); // réouverture : l'outbox part
      await new Promise((r) => setTimeout(r, 50));
      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]!).type).toBe("update");
    } finally {
      g.WebSocket = prev;
    }
  });

  it("fermer juste après une modification n'en perd pas la fin", async () => {
    const g = globalThis as unknown as { WebSocket: unknown };
    const prev = g.WebSocket;
    g.WebSocket = FakeWS;
    FakeWS.instances = [];
    try {
      const ch = mkChannel();
      await ch.connect();
      const ws = FakeWS.instances[0]!;
      ws.open();
      void ch.sendUpdate(new Uint8Array([9, 9]));
      ch.close(); // avant la fin du chiffrement
      await new Promise((r) => setTimeout(r, 100));
      expect(ws.sent).toHaveLength(1);
      expect(ws.readyState).toBe(3); // puis le socket est bien fermé
    } finally {
      g.WebSocket = prev;
    }
  });
});

describe("fournisseur Yjs : réutilisable après destroy (StrictMode)", () => {
  class WS {
    static OPEN = 1;
    static all: WS[] = [];
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    onmessage: unknown = null;
    constructor() {
      WS.all.push(this);
    }
    send(d: string) {
      this.sent.push(d);
    }
    close() {
      this.readyState = 3;
    }
  }
  it("après destroy() puis connect(), les modifications locales partent toujours", async () => {
    const g = globalThis as unknown as { WebSocket: unknown };
    const prev = g.WebSocket;
    g.WebSocket = WS;
    WS.all = [];
    try {
      const api = { getCollabUpdates: async () => ({ updates: [] }), collabSocketUrl: () => "ws://x" };
      const doc = new Y.Doc();
      const provider = new EncryptedYjsProvider(api as never, "n", new Uint8Array(32).fill(5), doc, {
        name: "t",
        color: "#000",
      });
      await provider.connect();
      provider.destroy(); // démontage StrictMode
      await provider.connect(); // remontage sur la même instance
      const ws = WS.all[WS.all.length - 1]!;
      ws.readyState = 1;
      ws.onopen?.();
      doc.getText("t").insert(0, "bonjour");
      await new Promise((r) => setTimeout(r, 100));
      expect(ws.sent.some((m) => JSON.parse(m).type === "update")).toBe(true);
      provider.destroy();
    } finally {
      g.WebSocket = prev;
    }
  });
});
