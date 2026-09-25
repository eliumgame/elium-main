/**
 * @vitest-environment jsdom
 *
 * XFDF as Acrobat reads and writes it: every field a comment carries survives
 * export then import, and what Acrobat writes (state replies, /DA colours,
 * crop-box origins) comes back as Elium models it.
 */
import { describe, it, expect } from "vitest";
import { fromXfdf, mergeImported, toXfdf } from "../src/pdf/ops/xfdf";
import * as D from "../src/pdf/model/doc";
import { emptyState, type Annot, type Page } from "../src/pdf/model/types";

const pages: Page[] = [{ id: "p1", from: 0 }];
const at = (h: number, ox = 0, oy = 0) => new Map([["p1", { h, ox, oy }]]);

const base = (over: Partial<Annot>): Annot => ({
  id: "a1",
  pageId: "p1",
  kind: "square",
  rect: { x: 40, y: 40, w: 120, h: 60 },
  color: "#e11d48",
  opacity: 1,
  strokeWidth: 2,
  author: "Alice",
  createdAt: "2026-03-01T08:00:00.000Z",
  modifiedAt: "2026-03-01T08:00:00.000Z",
  replies: [],
  ...over,
});

const roundTrip = (list: Annot[], boxes = at(842)) =>
  fromXfdf(toXfdf(list, pages, boxes, "x.pdf"), pages, boxes, "Moi");

describe("XFDF round trip", () => {
  it("keeps the review status as a state reply, and reads Acrobat's", () => {
    let s = { ...emptyState(), pages, annots: [base({})] };
    s = D.setStatus(s, ["a1"], "rejected", "Bob", "2026-03-02T08:00:00.000Z");
    const xml = toXfdf(s.annots, pages, at(842), "x.pdf");
    expect(xml).toContain('state="Rejected" statemodel="Review"');
    const [back] = fromXfdf(xml, pages, at(842), "Moi");
    expect(back.status).toBe("rejected");
    expect(back.replies?.at(-1)).toMatchObject({ author: "Bob", status: "rejected" });
  });

  it("puts the crop box's origin back in both directions", () => {
    const [back] = roundTrip([base({})], at(842, 30, 50));
    expect(back.rect).toEqual({ x: 40, y: 40, w: 120, h: 60 });
    const xml = toXfdf([base({})], pages, at(842, 30, 50), "x.pdf");
    // PDF space: x 40 + 30, top 842 + 50 - 40.
    expect(xml).toContain('rect="70,792,190,852"');
  });

  it("keeps every line ending, at both ends", () => {
    const [back] = roundTrip([
      base({
        kind: "arrow",
        paths: [
          [
            { x: 10, y: 10 },
            { x: 100, y: 50 },
          ],
        ],
        lineStart: "diamond",
        lineEnd: "openArrow",
      }),
    ]);
    expect(back).toMatchObject({ kind: "arrow", lineStart: "diamond", lineEnd: "openArrow" });
  });

  it("keeps an opacity or a width of 0", () => {
    const [back] = roundTrip([base({ opacity: 0, strokeWidth: 0 })]);
    expect(back.opacity).toBe(0);
    expect(back.strokeWidth).toBe(0);
  });

  it("keeps a text box's colours apart (text in /DA, box in color), a callout, a typewriter", () => {
    const list = roundTrip([
      base({
        id: "f",
        kind: "freetext",
        text: "Bonjour",
        color: "#cc0000",
        textBg: "#ffff00",
        fontSize: 15,
        align: "center",
      }),
      base({
        id: "c",
        kind: "callout",
        text: "Là",
        color: "#0000cc",
        textBg: null,
        callout: [
          { x: 5, y: 300 },
          { x: 30, y: 200 },
          { x: 40, y: 100 },
        ],
        lineEnd: "circle",
      }),
      base({ id: "t", kind: "typewriter", text: "Tapé", color: "#000000", textBg: null }),
    ]);
    expect(list.map((a) => [a.kind, a.color, a.textBg ?? null])).toEqual([
      ["freetext", "#cc0000", "#ffff00"],
      ["callout", "#0000cc", null],
      ["typewriter", "#000000", null],
    ]);
    expect(list[0]).toMatchObject({ fontSize: 15, align: "center", text: "Bonjour" });
    expect(list[1].callout).toEqual([
      { x: 5, y: 300 },
      { x: 30, y: 200 },
      { x: 40, y: 100 },
    ]);
    expect(list[1].lineEnd).toBe("circle");
  });

  it("keeps measures, clouds, dashes, redaction marks, note icons, stamps and flags", () => {
    const pts = [
      { x: 10, y: 10 },
      { x: 110, y: 10 },
      { x: 110, y: 90 },
    ];
    const list = roundTrip([
      base({ id: "d", kind: "distance", paths: [[pts[0], pts[1]]] }),
      base({ id: "ar", kind: "area", paths: [pts] }),
      base({ id: "pe", kind: "perimeter", paths: [pts] }),
      base({ id: "cl", kind: "cloud", paths: [pts], borderStyle: "cloudy" }),
      base({ id: "da", kind: "square", borderStyle: "dashed", dash: [6, 2] }),
      base({ id: "r", kind: "redact", redactText: "SECRET", redactFill: "#333333" }),
      base({ id: "n", kind: "note", icon: "Help", text: "?" }),
      base({ id: "s", kind: "stamp", stampLabel: "Reçu", stampName: "#DReceived", rotation: 15 }),
      base({ id: "l", kind: "square", locked: true, hidden: true }),
    ]);
    const by = Object.fromEntries(list.map((a) => [a.id, a]));
    expect(by.d.kind).toBe("distance");
    expect(by.ar.kind).toBe("area");
    expect(by.pe.kind).toBe("perimeter");
    expect(by.cl.kind).toBe("cloud");
    expect(by.da).toMatchObject({ borderStyle: "dashed", dash: [6, 2] });
    expect(by.r).toMatchObject({ kind: "redact", redactText: "SECRET", redactFill: "#333333" });
    expect(by.n).toMatchObject({ kind: "note", icon: "Help", text: "?" });
    expect(by.s).toMatchObject({
      kind: "stamp",
      stampLabel: "Reçu",
      stampName: "#DReceived",
      rotation: 15,
      stampTone: "blue",
    });
    expect(by.l).toMatchObject({ locked: true, hidden: true });
  });

  it("reads a date's time zone", () => {
    const xml = `<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>
      <square page="0" rect="0,0,10,10" name="z" creationdate="D:20260301100000+02'00'" date="D:20260301100000Z"/>
    </annots></xfdf>`;
    const [a] = fromXfdf(xml, pages, at(842), "Moi");
    expect(a.createdAt).toBe("2026-03-01T08:00:00.000Z");
    expect(a.modifiedAt).toBe("2026-03-01T10:00:00.000Z");
  });

  it("does not take a replace-text group member for a reply", () => {
    const xml = `<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>
      <strikeout page="0" rect="0,0,10,10" name="so" coords="0,10,10,10,0,0,10,0"/>
      <text page="0" rect="0,0,10,10" name="g" inreplyto="so" replyType="group"><contents>x</contents></text>
      <text page="0" rect="0,0,10,10" name="r1" inreplyto="so"><contents>premier</contents></text>
      <text page="0" rect="0,0,10,10" name="r2" inreplyto="r1"><contents>second</contents></text>
    </annots></xfdf>`;
    const [a] = fromXfdf(xml, pages, at(842), "Moi");
    expect(a.replies?.map((r) => r.text)).toEqual(["premier", "second"]);
  });
});

describe("importing the same comments again", () => {
  it("updates them instead of adding copies", () => {
    const first = roundTrip([base({ id: "a1", color: "#e11d48" }), base({ id: "a2" })]);
    const again = roundTrip([base({ id: "a1", color: "#00aa00" })]);
    const merged = mergeImported(first, again);
    expect(merged).toHaveLength(2);
    expect(merged.find((a) => a.id === "a1")?.color).toBe("#00aa00");
  });

  it("recognises a comment by the file's /NM it came from", () => {
    const local = base({ id: "12R", pdf: { nm: "uuid-9" } });
    const xml = toXfdf([local], pages, at(842), "x.pdf");
    expect(xml).toContain('name="uuid-9"');
    const merged = mergeImported([local], fromXfdf(xml.replace("#E11D48", "#112233"), pages, at(842), "Moi"));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "12R", color: "#112233" });
  });
});
