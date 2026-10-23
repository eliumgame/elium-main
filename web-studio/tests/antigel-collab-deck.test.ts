import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { SlideReader, slideToY, syncYText, ensureYText } from "../src/drive-cloud/collab-slides-crdt";
import { EncryptedCollabChannel } from "../src/drive-cloud/collab";
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
