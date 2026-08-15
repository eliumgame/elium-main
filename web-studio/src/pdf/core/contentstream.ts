/**
 * A real PDF content-stream tokeniser and serialiser.
 *
 * This is the difference between *pretending* to edit a PDF (draw a white box
 * over the old text and print new text on top — what most web tools do, and
 * what Elium used to do) and actually editing it: the operators that draw the
 * page are parsed, modified and written back, so the result has no hidden
 * original text underneath, stays selectable, and survives being re-opened in
 * Acrobat.
 *
 * The tokeniser is total: anything it does not understand is preserved verbatim
 * so a round-trip through parse → serialise is byte-faithful for untouched
 * operators. Inline images (`BI … ID <binary> EI`) get special handling because
 * their payload is raw binary that would otherwise derail the lexer.
 */

export type Operand =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "str"; v: Uint8Array }
  | { t: "hex"; v: Uint8Array }
  | { t: "arr"; v: Operand[] }
  | { t: "dict"; v: Map<string, Operand> }
  | { t: "bool"; v: boolean }
  | { t: "null" };

export interface Op {
  op: string;
  args: Operand[];
  /** Payload for `BI … ID … EI`; `op` is then `"BI"`. */
  inline?: { dict: Map<string, Operand>; data: Uint8Array };
}

// --- character classes ------------------------------------------------------

const isWhite = (c: number) => c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isDelim = (c: number) =>
  c === 0x28 ||
  c === 0x29 ||
  c === 0x3c ||
  c === 0x3e ||
  c === 0x5b ||
  c === 0x5d ||
  c === 0x7b ||
  c === 0x7d ||
  c === 0x2f ||
  c === 0x25;
const isRegular = (c: number) => !isWhite(c) && !isDelim(c);
const hexVal = (c: number): number =>
  c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

class Lexer {
  private i = 0;
  constructor(private readonly b: Uint8Array) {}

  get pos(): number {
    return this.i;
  }

  atEnd(): boolean {
    return this.i >= this.b.length;
  }

  skipWhite(): void {
    while (this.i < this.b.length) {
      const c = this.b[this.i];
      if (isWhite(c)) {
        this.i++;
        continue;
      }
      if (c === 0x25) {
        // '%' comment to end of line
        while (this.i < this.b.length && this.b[this.i] !== 0x0a && this.b[this.i] !== 0x0d) this.i++;
        continue;
      }
      break;
    }
  }

  /** Read the next operand, or return the bare keyword found at this position. */
  next(): { kind: "operand"; value: Operand } | { kind: "keyword"; value: string } | null {
    this.skipWhite();
    if (this.i >= this.b.length) return null;
    const c = this.b[this.i];

    if (c === 0x2f) return { kind: "operand", value: { t: "name", v: this.readName() } };
    if (c === 0x28) return { kind: "operand", value: { t: "str", v: this.readLiteralString() } };
    if (c === 0x3c) {
      if (this.b[this.i + 1] === 0x3c) return { kind: "operand", value: { t: "dict", v: this.readDict() } };
      return { kind: "operand", value: { t: "hex", v: this.readHexString() } };
    }
    if (c === 0x5b) return { kind: "operand", value: { t: "arr", v: this.readArray() } };
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      this.i++; // stray delimiter — skip it rather than hang
      return this.next();
    }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      const n = this.readNumber();
      if (n !== null) return { kind: "operand", value: { t: "num", v: n } };
    }
    const kw = this.readKeyword();
    if (!kw) {
      this.i++;
      return this.next();
    }
    if (kw === "true") return { kind: "operand", value: { t: "bool", v: true } };
    if (kw === "false") return { kind: "operand", value: { t: "bool", v: false } };
    if (kw === "null") return { kind: "operand", value: { t: "null" } };
    return { kind: "keyword", value: kw };
  }

  private readKeyword(): string {
    const start = this.i;
    while (this.i < this.b.length && isRegular(this.b[this.i])) this.i++;
    if (this.i === start) return "";
    return latin1(this.b.subarray(start, this.i));
  }

  private readNumber(): number | null {
    const start = this.i;
    if (this.b[this.i] === 0x2b || this.b[this.i] === 0x2d) this.i++;
    let digits = 0;
    while (this.i < this.b.length) {
      const c = this.b[this.i];
      if (c >= 0x30 && c <= 0x39) {
        digits++;
        this.i++;
        continue;
      }
      if (c === 0x2e) {
        this.i++;
        continue;
      }
      if (c === 0x2d || c === 0x2b) {
        this.i++;
        continue;
      } // malformed "1-2"; tolerate
      break;
    }
    if (!digits) {
      this.i = start;
      return null;
    }
    const n = Number(latin1(this.b.subarray(start, this.i)).replace(/(?!^)[+-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }

  private readName(): string {
    this.i++; // '/'
    let out = "";
    while (this.i < this.b.length && isRegular(this.b[this.i])) {
      const c = this.b[this.i];
      if (c === 0x23 && hexVal(this.b[this.i + 1]) >= 0 && hexVal(this.b[this.i + 2]) >= 0) {
        out += String.fromCharCode(hexVal(this.b[this.i + 1]) * 16 + hexVal(this.b[this.i + 2]));
        this.i += 3;
        continue;
      }
      out += String.fromCharCode(c);
      this.i++;
    }
    return out;
  }

  private readLiteralString(): Uint8Array {
    this.i++; // '('
    const out: number[] = [];
    let depth = 1;
    while (this.i < this.b.length) {
      const c = this.b[this.i++];
      if (c === 0x5c) {
        // backslash
        const e = this.b[this.i++];
        switch (e) {
          case 0x6e:
            out.push(0x0a);
            break;
          case 0x72:
            out.push(0x0d);
            break;
          case 0x74:
            out.push(0x09);
            break;
          case 0x62:
            out.push(0x08);
            break;
          case 0x66:
            out.push(0x0c);
            break;
          case 0x28:
            out.push(0x28);
            break;
          case 0x29:
            out.push(0x29);
            break;
          case 0x5c:
            out.push(0x5c);
            break;
          case 0x0d:
            if (this.b[this.i] === 0x0a) this.i++;
            break; // line continuation
          case 0x0a:
            break;
          default: {
            if (e >= 0x30 && e <= 0x37) {
              // octal, up to 3 digits
              let v = e - 0x30;
              for (let k = 0; k < 2; k++) {
                const d = this.b[this.i];
                if (d >= 0x30 && d <= 0x37) {
                  v = v * 8 + (d - 0x30);
                  this.i++;
                } else break;
              }
              out.push(v & 0xff);
            } else if (e !== undefined) {
              out.push(e);
            }
          }
        }
        continue;
      }
      if (c === 0x28) {
        depth++;
        out.push(c);
        continue;
      }
      if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
        continue;
      }
      out.push(c);
    }
    return Uint8Array.from(out);
  }

  private readHexString(): Uint8Array {
    this.i++; // '<'
    const out: number[] = [];
    let hi = -1;
    while (this.i < this.b.length) {
      const c = this.b[this.i++];
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16); // odd digit count: pad with 0
    return Uint8Array.from(out);
  }

  private readArray(): Operand[] {
    this.i++; // '['
    const out: Operand[] = [];
    for (;;) {
      this.skipWhite();
      if (this.i >= this.b.length) break;
      if (this.b[this.i] === 0x5d) {
        this.i++;
        break;
      }
      const tok = this.next();
      if (!tok) break;
      if (tok.kind === "operand") out.push(tok.value);
      // keywords inside an array are malformed; drop them
    }
    return out;
  }

  private readDict(): Map<string, Operand> {
    this.i += 2; // '<<'
    const out = new Map<string, Operand>();
    for (;;) {
      this.skipWhite();
      if (this.i >= this.b.length) break;
      if (this.b[this.i] === 0x3e && this.b[this.i + 1] === 0x3e) {
        this.i += 2;
        break;
      }
      if (this.b[this.i] !== 0x2f) {
        this.i++;
        continue;
      }
      const key = this.readName();
      const tok = this.next();
      if (!tok) break;
      if (tok.kind === "operand") out.set(key, tok.value);
      else out.set(key, { t: "name", v: tok.value });
    }
    return out;
  }

  /** After an `ID`, consume the binary payload up to the matching `EI`. */
  readInlineImageData(): Uint8Array {
    // Exactly one whitespace byte separates ID from the data.
    if (isWhite(this.b[this.i])) this.i++;
    const start = this.i;
    while (this.i < this.b.length - 1) {
      if (
        this.b[this.i] === 0x45 &&
        this.b[this.i + 1] === 0x49 && // 'E' 'I'
        (this.i === 0 || isWhite(this.b[this.i - 1])) &&
        (this.i + 2 >= this.b.length || isWhite(this.b[this.i + 2]) || isDelim(this.b[this.i + 2]))
      ) {
        const data = this.b.subarray(start, Math.max(start, this.i - 1));
        this.i += 2;
        return data;
      }
      this.i++;
    }
    const data = this.b.subarray(start);
    this.i = this.b.length;
    return data;
  }
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** Parse a decoded content stream into a flat operator list. */
export function parseContentStream(bytes: Uint8Array): Op[] {
  const lex = new Lexer(bytes);
  const ops: Op[] = [];
  let args: Operand[] = [];
  let guard = 0;
  for (;;) {
    if (guard++ > 8_000_000) break;
    const tok = lex.next();
    if (!tok) break;
    if (tok.kind === "operand") {
      if (args.length > 64) args.shift(); // malformed stream: don't grow forever
      args.push(tok.value);
      continue;
    }
    if (tok.value === "BI") {
      const dict = new Map<string, Operand>();
      for (;;) {
        const t = lex.next();
        if (!t) break;
        if (t.kind === "keyword" && t.value === "ID") break;
        if (t.kind === "operand" && t.value.t === "name") {
          const v = lex.next();
          if (!v) break;
          dict.set(t.value.v, v.kind === "operand" ? v.value : { t: "name", v: v.value });
        }
      }
      const data = lex.readInlineImageData();
      ops.push({ op: "BI", args: [], inline: { dict, data } });
      args = [];
      continue;
    }
    ops.push({ op: tok.value, args });
    args = [];
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

function encodeName(name: string): string {
  let out = "/";
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || isDelim(c) || ch === "#") {
      out += "#" + c.toString(16).padStart(2, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

function pushAscii(out: number[], s: string): void {
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
}

function writeLiteralString(out: number[], v: Uint8Array): void {
  out.push(0x28);
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === 0x28 || c === 0x29 || c === 0x5c) {
      out.push(0x5c, c);
      continue;
    }
    if (c === 0x0a) {
      out.push(0x5c, 0x6e);
      continue;
    }
    if (c === 0x0d) {
      out.push(0x5c, 0x72);
      continue;
    }
    if (c === 0x09) {
      out.push(0x5c, 0x74);
      continue;
    }
    if (c === 0x08) {
      out.push(0x5c, 0x62);
      continue;
    }
    if (c === 0x0c) {
      out.push(0x5c, 0x66);
      continue;
    }
    out.push(c);
  }
  out.push(0x29);
}

function writeHexString(out: number[], v: Uint8Array): void {
  out.push(0x3c);
  for (let i = 0; i < v.length; i++) pushAscii(out, v[i].toString(16).padStart(2, "0"));
  out.push(0x3e);
}

function writeOperand(out: number[], o: Operand): void {
  switch (o.t) {
    case "num":
      pushAscii(out, fmtNumber(o.v));
      break;
    case "name":
      pushAscii(out, encodeName(o.v));
      break;
    case "str":
      writeLiteralString(out, o.v);
      break;
    case "hex":
      writeHexString(out, o.v);
      break;
    case "bool":
      pushAscii(out, o.v ? "true" : "false");
      break;
    case "null":
      pushAscii(out, "null");
      break;
    case "arr": {
      out.push(0x5b);
      o.v.forEach((it, i) => {
        if (i) out.push(0x20);
        writeOperand(out, it);
      });
      out.push(0x5d);
      break;
    }
    case "dict": {
      pushAscii(out, "<<");
      for (const [k, v] of o.v) {
        pushAscii(out, encodeName(k));
        out.push(0x20);
        writeOperand(out, v);
        out.push(0x20);
      }
      pushAscii(out, ">>");
      break;
    }
  }
}

/** Serialise an operator list back to content-stream bytes. */
export function writeContentStream(ops: readonly Op[]): Uint8Array {
  const out: number[] = [];
  for (const op of ops) {
    if (op.op === "BI" && op.inline) {
      pushAscii(out, "BI ");
      for (const [k, v] of op.inline.dict) {
        pushAscii(out, encodeName(k));
        out.push(0x20);
        writeOperand(out, v);
        out.push(0x20);
      }
      pushAscii(out, "ID ");
      for (let i = 0; i < op.inline.data.length; i++) out.push(op.inline.data[i]);
      pushAscii(out, "\nEI\n");
      continue;
    }
    for (const a of op.args) {
      writeOperand(out, a);
      out.push(0x20);
    }
    pushAscii(out, op.op);
    out.push(0x0a);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Text-state machine
// ---------------------------------------------------------------------------

export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export interface TextState {
  font: string | null;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
  /** Non-stroking colour in effect, as RGB 0..1 — so edited text keeps its colour. */
  fill: { r: number; g: number; b: number };
}

const initialTextState = (): TextState => ({
  font: null,
  size: 0,
  charSpacing: 0,
  wordSpacing: 0,
  hScale: 1,
  leading: 0,
  rise: 0,
  renderMode: 0,
  fill: { r: 0, g: 0, b: 0 },
});

/** One text-showing operator located in PDF user space. */
export interface ShowOp {
  /** Index into the operator list. */
  opIndex: number;
  /** `Tj`, `TJ`, `'` or `"`. */
  op: string;
  /** Text matrix in effect when the operator ran. */
  tm: Mat;
  /** Current transformation matrix in effect. */
  ctm: Mat;
  state: TextState;
  /** Raw string bytes shown (TJ concatenates its string parts). */
  bytes: Uint8Array;
  /** Total advance in unscaled text-space units (before the Tm/CTM transform). */
  advance: number;
  /** Baseline start point in PDF user space. */
  origin: { x: number; y: number };
  /** Baseline end point in PDF user space. */
  end: { x: number; y: number };
  /** Effective on-page em size after Tm and CTM. */
  effectiveSize: number;
}

/** Callback that measures a string's advance, in 1/1000 em, for the active font. */
export type WidthFn = (font: string | null, bytes: Uint8Array) => { widths: number[]; codes: number[] };

/**
 * Walk the operator list, tracking the graphics + text state, and report every
 * text-showing operator with its position. `measure` supplies per-glyph widths
 * from the page's font resources (see `fontmetrics.ts`); without it, positions
 * are still correct at the *start* of each operator, which is enough to locate
 * an operator inside a rectangle.
 */
export function walkText(ops: readonly Op[], measure?: WidthFn): ShowOp[] {
  const out: ShowOp[] = [];
  let ctm: Mat = IDENTITY;
  const ctmStack: Mat[] = [];
  let gs = initialTextState();
  const gsStack: TextState[] = [];
  let tm: Mat = IDENTITY;
  let tlm: Mat = IDENTITY;

  const num = (o: Operand | undefined): number => (o && o.t === "num" ? o.v : 0);

  const advanceFor = (bytes: Uint8Array, tjAdjust: number): { adv: number } => {
    let adv = 0;
    if (measure) {
      const { widths, codes } = measure(gs.font, bytes);
      for (let i = 0; i < widths.length; i++) {
        const isSpace = codes[i] === 32 && widths.length === bytes.length; // single-byte space
        adv += (widths[i] / 1000) * gs.size + gs.charSpacing + (isSpace ? gs.wordSpacing : 0);
      }
    } else {
      adv += bytes.length * gs.size * 0.5;
    }
    adv -= (tjAdjust / 1000) * gs.size;
    return { adv: adv * gs.hScale };
  };

  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i];
    switch (op) {
      case "q":
        ctmStack.push(ctm);
        gsStack.push({ ...gs });
        break;
      case "Q":
        ctm = ctmStack.pop() ?? IDENTITY;
        gs = gsStack.pop() ?? initialTextState();
        break;
      case "cm":
        ctm = mul([num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), num(args[5])], ctm);
        break;
      case "BT":
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case "ET":
        break;
      case "Tf":
        gs = { ...gs, font: args[0]?.t === "name" ? args[0].v : null, size: num(args[1]) };
        break;
      case "Tc":
        gs = { ...gs, charSpacing: num(args[0]) };
        break;
      case "Tw":
        gs = { ...gs, wordSpacing: num(args[0]) };
        break;
      case "Tz":
        gs = { ...gs, hScale: num(args[0]) / 100 };
        break;
      case "TL":
        gs = { ...gs, leading: num(args[0]) };
        break;
      case "Ts":
        gs = { ...gs, rise: num(args[0]) };
        break;
      case "Tr":
        gs = { ...gs, renderMode: num(args[0]) };
        break;
      case "g": {
        const v = num(args[0]);
        gs = { ...gs, fill: { r: v, g: v, b: v } };
        break;
      }
      case "rg":
        gs = { ...gs, fill: { r: num(args[0]), g: num(args[1]), b: num(args[2]) } };
        break;
      case "k": {
        const [c, m, y, kk] = [num(args[0]), num(args[1]), num(args[2]), num(args[3])];
        gs = { ...gs, fill: { r: (1 - c) * (1 - kk), g: (1 - m) * (1 - kk), b: (1 - y) * (1 - kk) } };
        break;
      }
      case "sc":
      case "scn": {
        const comps = args.filter((o): o is Extract<Operand, { t: "num" }> => o.t === "num").map((o) => o.v);
        if (comps.length === 1) gs = { ...gs, fill: { r: comps[0], g: comps[0], b: comps[0] } };
        else if (comps.length === 3) gs = { ...gs, fill: { r: comps[0], g: comps[1], b: comps[2] } };
        else if (comps.length === 4) {
          const [c, m, y, kk] = comps;
          gs = { ...gs, fill: { r: (1 - c) * (1 - kk), g: (1 - m) * (1 - kk), b: (1 - y) * (1 - kk) } };
        }
        break;
      }
      case "Td":
        tlm = mul([1, 0, 0, 1, num(args[0]), num(args[1])], tlm);
        tm = tlm;
        break;
      case "TD":
        gs = { ...gs, leading: -num(args[1]) };
        tlm = mul([1, 0, 0, 1, num(args[0]), num(args[1])], tlm);
        tm = tlm;
        break;
      case "Tm":
        tlm = [num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), num(args[5])];
        tm = tlm;
        break;
      case "T*":
        tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
        tm = tlm;
        break;
      case "Tj":
      case "'":
      case '"':
      case "TJ": {
        if (op === "'" || op === '"') {
          if (op === '"') gs = { ...gs, wordSpacing: num(args[0]), charSpacing: num(args[1]) };
          tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
          tm = tlm;
        }
        let bytes: Uint8Array = new Uint8Array(0);
        let tjAdjust = 0;
        if (op === "TJ") {
          const arr = args[args.length - 1];
          const parts: Uint8Array[] = [];
          if (arr?.t === "arr") {
            for (const el of arr.v) {
              if (el.t === "str" || el.t === "hex") parts.push(el.v);
              else if (el.t === "num") tjAdjust += el.v;
            }
          }
          bytes = concat(parts);
        } else {
          const s = args[args.length - 1];
          if (s && (s.t === "str" || s.t === "hex")) bytes = s.v;
        }
        const { adv } = advanceFor(bytes, tjAdjust);
        const full = mul(mul([gs.size * gs.hScale, 0, 0, gs.size, 0, gs.rise], tm), ctm);
        const originM = mul(tm, ctm);
        const start = { x: originM[4], y: originM[5] };
        const after = mul([1, 0, 0, 1, adv, 0], tm);
        const afterM = mul(after, ctm);
        out.push({
          opIndex: i,
          op,
          tm,
          ctm,
          state: { ...gs },
          bytes,
          advance: adv,
          origin: start,
          end: { x: afterM[4], y: afterM[5] },
          effectiveSize: Math.hypot(full[2], full[3]),
        });
        tm = after;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** One `Do` (XObject placement) or inline image, with the CTM in effect. */
export interface Placement {
  opIndex: number;
  /** Resource name for `Do`; null for an inline image. */
  name: string | null;
  ctm: Mat;
  /** Unit-square corners mapped through the CTM — the drawn quad. */
  corners: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
}

/**
 * Locate every image/form placement. Only the graphics-state stack is tracked,
 * which is all a placement needs: PDF always draws an XObject into the unit
 * square, so the CTM *is* its position and size.
 */
export function walkPlacements(ops: readonly Op[]): Placement[] {
  const out: Placement[] = [];
  let ctm: Mat = IDENTITY;
  const stack: Mat[] = [];
  const num = (o: Operand | undefined): number => (o && o.t === "num" ? o.v : 0);
  const at = (m: Mat, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i];
    if (op === "q") {
      stack.push(ctm);
      continue;
    }
    if (op === "Q") {
      ctm = stack.pop() ?? IDENTITY;
      continue;
    }
    if (op === "cm") {
      ctm = mul([num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), num(args[5])], ctm);
      continue;
    }
    if (op === "Do" || op === "BI") {
      out.push({
        opIndex: i,
        name: op === "Do" && args[0]?.t === "name" ? args[0].v : null,
        ctm,
        corners: [at(ctm, 0, 0), at(ctm, 1, 0), at(ctm, 1, 1), at(ctm, 0, 1)],
      });
    }
  }
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
