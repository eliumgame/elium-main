import { describe, it, expect } from "vitest";
import {
  parseContentStream,
  walkPlacements,
  walkText,
  writeContentStream,
  type Op,
} from "../src/pdf/core/contentstream";
import { parseToUnicode, winAnsiToUnicode } from "../src/pdf/core/fontmetrics";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("content stream — tokenising", () => {
  it("reads numbers, names, strings and operators", () => {
    const ops = parseContentStream(enc("1 0 0 1 72 720 cm /F1 12 Tf (Bonjour) Tj"));
    expect(ops.map((o) => o.op)).toEqual(["cm", "Tf", "Tj"]);
    expect(ops[0].args.map((a) => (a.t === "num" ? a.v : null))).toEqual([1, 0, 0, 1, 72, 720]);
    expect(ops[1].args[0]).toEqual({ t: "name", v: "F1" });
    const shown = ops[2].args[0];
    expect(shown.t).toBe("str");
    if (shown.t === "str") expect(dec(shown.v)).toBe("Bonjour");
  });

  it("handles escapes, nesting and octal inside literal strings", () => {
    const ops = parseContentStream(enc(String.raw`(a\(b\)c\\d\101\n) Tj`));
    const s = ops[0].args[0];
    expect(s.t).toBe("str");
    if (s.t === "str") expect(dec(s.v)).toBe("a(b)c\\dA\n");
  });

  it("reads hex strings, padding an odd digit count", () => {
    const ops = parseContentStream(enc("<48656C6C6F> Tj <4> Tj"));
    const a = ops[0].args[0];
    const b = ops[1].args[0];
    if (a.t === "hex") expect(dec(a.v)).toBe("Hello");
    if (b.t === "hex") expect(Array.from(b.v)).toEqual([0x40]);
  });

  it("reads TJ arrays with their kerning numbers", () => {
    const ops = parseContentStream(enc("[(Wa) -120 (ter)] TJ"));
    expect(ops[0].op).toBe("TJ");
    const arr = ops[0].args[0];
    expect(arr.t).toBe("arr");
    if (arr.t === "arr") {
      expect(arr.v).toHaveLength(3);
      expect(arr.v[1]).toEqual({ t: "num", v: -120 });
    }
  });

  it("skips comments", () => {
    const ops = parseContentStream(enc("% a comment\n1 w\n% another\nS"));
    expect(ops.map((o) => o.op)).toEqual(["w", "S"]);
  });

  it("survives an inline image without treating its payload as syntax", () => {
    const ops = parseContentStream(enc("q BI /W 2 /H 2 /BPC 8 /CS /G ID \x00(\\)q\x01 EI Q 1 w S"));
    expect(ops.map((o) => o.op)).toEqual(["q", "BI", "Q", "w", "S"]);
    expect(ops[1].inline?.dict.get("W")).toEqual({ t: "num", v: 2 });
  });

  it("does not hang on stray delimiters", () => {
    const ops = parseContentStream(enc("] ) > 1 w S"));
    expect(ops.map((o) => o.op)).toEqual(["w", "S"]);
  });
});

describe("content stream — serialising", () => {
  it("round-trips a stream through parse → write → parse", () => {
    const source = "q 1 0 0 1 10 20 cm /F1 12 Tf [(A) -50 (B)] TJ 0.5 0.25 0.75 rg 1 1 1 RG Q";
    const first = parseContentStream(enc(source));
    const second = parseContentStream(writeContentStream(first));
    expect(second.map((o) => o.op)).toEqual(first.map((o) => o.op));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("re-escapes parentheses and backslashes so the output re-parses", () => {
    const ops: Op[] = [{ op: "Tj", args: [{ t: "str", v: enc("a(b)\\c") }] }];
    const back = parseContentStream(writeContentStream(ops));
    const s = back[0].args[0];
    if (s.t === "str") expect(dec(s.v)).toBe("a(b)\\c");
  });

  it("writes short numbers without exponent notation", () => {
    const ops: Op[] = [{ op: "w", args: [{ t: "num", v: 0.30000000000000004 }] }];
    expect(dec(writeContentStream(ops)).trim()).toBe("0.3 w");
  });
});

describe("content stream — text state machine", () => {
  it("tracks the text matrix through Td, TD, Tm and T*", () => {
    const ops = parseContentStream(enc("BT /F1 10 Tf 100 700 Td (a) Tj 0 -12 Td (b) Tj 14 TL T* (c) Tj ET"));
    const shows = walkText(ops);
    expect(shows).toHaveLength(3);
    expect(shows[0].origin).toEqual({ x: 100, y: 700 });
    expect(shows[1].origin).toEqual({ x: 100, y: 688 });
    expect(shows[2].origin).toEqual({ x: 100, y: 674 });
  });

  it("applies the CTM set by cm, and restores it on Q", () => {
    const ops = parseContentStream(
      enc("q 1 0 0 1 50 50 cm BT /F1 10 Tf 10 10 Td (a) Tj ET Q BT /F1 10 Tf 10 10 Td (b) Tj ET"),
    );
    const shows = walkText(ops);
    expect(shows[0].origin).toEqual({ x: 60, y: 60 });
    expect(shows[1].origin).toEqual({ x: 10, y: 10 });
  });

  it("captures the non-stroking colour in force", () => {
    const ops = parseContentStream(enc("BT 1 0 0 rg /F1 10 Tf 0 0 Td (a) Tj 0.5 g (b) Tj ET"));
    const shows = walkText(ops);
    expect(shows[0].state.fill).toEqual({ r: 1, g: 0, b: 0 });
    expect(shows[1].state.fill).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
  });

  it("records the font, size and horizontal scale of each show", () => {
    const ops = parseContentStream(enc("BT /F2 18 Tf 50 Tz 0 0 Td (x) Tj ET"));
    const [show] = walkText(ops);
    expect(show.state.font).toBe("F2");
    expect(show.state.size).toBe(18);
    expect(show.state.hScale).toBe(0.5);
  });

  it("uses the supplied width function to advance the caret", () => {
    const ops = parseContentStream(enc("BT /F1 10 Tf 0 0 Td (abc) Tj (d) Tj ET"));
    // Every glyph is 500/1000 em wide ⇒ 5 pt at size 10 ⇒ "abc" advances 15 pt.
    const shows = walkText(ops, (_f, bytes) => ({
      widths: Array.from(bytes, () => 500),
      codes: Array.from(bytes),
    }));
    expect(shows[1].origin.x).toBeCloseTo(15, 6);
  });
});

describe("content stream — placements", () => {
  it("reports each Do with the matrix that positions it", () => {
    const ops = parseContentStream(enc("q 200 0 0 100 30 40 cm /Im0 Do Q q 10 0 0 10 0 0 cm /Im1 Do Q"));
    const places = walkPlacements(ops);
    expect(places).toHaveLength(2);
    expect(places[0].name).toBe("Im0");
    // The unit square maps to a 200×100 box at (30, 40).
    expect(places[0].corners[0]).toEqual({ x: 30, y: 40 });
    expect(places[0].corners[2]).toEqual({ x: 230, y: 140 });
    expect(places[1].name).toBe("Im1");
  });
});

describe("font metrics — encodings", () => {
  it("maps the WinAnsi high range that differs from Latin-1", () => {
    expect(winAnsiToUnicode(0x80)).toBe("€");
    expect(winAnsiToUnicode(0x92)).toBe("’");
    expect(winAnsiToUnicode(0x41)).toBe("A");
    expect(winAnsiToUnicode(0xe9)).toBe("é");
  });

  it("parses a ToUnicode CMap's bfchar and bfrange sections", () => {
    const cmap = parseToUnicode(
      enc(
        [
          "/CIDInit /ProcSet findresource begin",
          "1 begincodespacerange <0000> <FFFF> endcodespacerange",
          "2 beginbfchar",
          "<0003> <0020>",
          "<0024> <0041>",
          "endbfchar",
          "1 beginbfrange",
          "<0025> <0027> <0042>",
          "endbfrange",
          "endcmap",
        ].join("\n"),
      ),
    );
    expect(cmap.map.get(0x0003)).toBe(" ");
    expect(cmap.map.get(0x0024)).toBe("A");
    expect(cmap.map.get(0x0025)).toBe("B");
    expect(cmap.map.get(0x0027)).toBe("D");
    expect(cmap.reverse.get("A")).toBe(0x0024);
    expect(cmap.reverse.get("D")).toBe(0x0027);
  });

  it("parses an array-form bfrange", () => {
    const cmap = parseToUnicode(enc("1 beginbfrange\n<0010> <0012> [<0058> <0059> <005A>]\nendbfrange"));
    expect(cmap.map.get(0x0010)).toBe("X");
    expect(cmap.map.get(0x0012)).toBe("Z");
  });
});
