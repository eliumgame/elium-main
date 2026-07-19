/**
 * Tiny spreadsheet formula engine — no dependency.
 *
 * Supports: numbers, strings ("..."), cell refs (A1), arithmetic (+ - * /),
 * unary minus, parentheses, comparisons (= <> < > <= >=), and a large library
 * of functions (SUM, IF, VLOOKUP, IFERROR, …) — with A1:B2 ranges as function
 * arguments. Recalculation resolves references lazily with cycle detection.
 * Errors surface as { error: "#…" } values.
 *
 * Pipeline: tokenize → parse (builds an AST, no evaluation) → evaluate (walks
 * the AST). The parse/eval split lets IFERROR/IFNA run a sub-expression inside
 * a try/catch and swallow its error instead of failing the whole formula.
 */
export type CellError = { error: string };
export type CellValue = number | string | boolean | CellError;

/** Dimensions of a range argument (row-major values); null for scalar args. */
interface RangeShape { rows: number; cols: number; }

export function isError(v: CellValue): v is CellError {
  return typeof v === "object" && v !== null && "error" in v;
}

class FormulaError extends Error {}

// --- A1 reference helpers -------------------------------------------------

const REF_RE = /^\$?([A-Z]+)\$?([0-9]+)$/; // optional $ anchors (absolute refs)

export function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0-based
}

export function indexToCol(idx: number): string {
  let s = "";
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function parseRef(ref: string): { col: number; row: number } | null {
  const m = REF_RE.exec(ref);
  if (!m) return null;
  return { col: colToIndex(m[1]), row: parseInt(m[2], 10) - 1 };
}

/** Expand "A1:B3" into the list of refs it covers. */
export function expandRange(a: string, b: string): string[] {
  const pa = parseRef(a);
  const pb = parseRef(b);
  if (!pa || !pb) throw new FormulaError("#REF");
  const refs: string[] = [];
  const c0 = Math.min(pa.col, pb.col);
  const c1 = Math.max(pa.col, pb.col);
  const r0 = Math.min(pa.row, pb.row);
  const r1 = Math.max(pa.row, pb.row);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) refs.push(indexToCol(c) + (r + 1));
  return refs;
}

export type RefMap = (col: number, row: number) => { col: number; row: number } | null;

/**
 * Rewrite every A1-style reference inside a formula using `map`. A ref that maps
 * to `null` (its row/column was deleted) becomes `#REF!`. Everything else —
 * numbers, string literals, function names, operators, the `;` separator and
 * whitespace — is preserved verbatim, so the user's formula keeps its shape.
 *
 * Used when rows/columns are inserted or deleted: cells move AND the references
 * inside surviving formulas must track the move (exactly like Excel/Sheets).
 *
 * Cross-sheet references (`Feuille2!A1`) live in another sheet's coordinate
 * space: a *structural* edit (respectAnchors=false) leaves them untouched,
 * while a *copy/fill* (respectAnchors=true) offsets the address part (Excel
 * behaviour) and keeps the sheet name.
 */
export function rewriteRefs(formula: string, map: RefMap, respectAnchors = false): string {
  // Rewrite a bare A1 address. `qualified` = it's the address of Sheet!A1.
  const rewriteAddr = (word: string, qualified: boolean): string => {
    const m = /^(\$?)([A-Za-z]+)(\$?)([0-9]+)$/.exec(word);
    const p = m ? parseRef(word.toUpperCase()) : null;
    if (!p || !m) return word;
    if (qualified && !respectAnchors) return word; // cross-sheet ref invariant under a local structural edit
    const np = map(p.col, p.row);
    if (!np) return "#REF!";
    // Structural ops shift both abs+rel (Excel-correct). Copy/fill
    // (respectAnchors) keeps $-anchored components fixed, shifts the rest.
    const col = respectAnchors && m[1] === "$" ? p.col : np.col;
    const row = respectAnchors && m[3] === "$" ? p.row : np.row;
    return `${m[1]}${indexToCol(col)}${m[3]}${row + 1}`;
  };
  // Consume the bare address word starting at `i`; returns [text, nextIndex].
  const takeAddr = (i: number, qualified: boolean): [string, number] => {
    let k = i;
    while (k < formula.length && /[A-Za-z0-9_$]/.test(formula[k])) k++;
    return [rewriteAddr(formula.slice(i, k), qualified), k];
  };

  let out = "";
  let i = 0;
  while (i < formula.length) {
    const c = formula[i];
    if (c === '"') {
      // string literal — copy verbatim, including the closing quote
      let j = i + 1;
      while (j < formula.length && formula[j] !== '"') j++;
      out += formula.slice(i, Math.min(j + 1, formula.length));
      i = j + 1;
      continue;
    }
    if (c === "'") {
      // 'Quoted sheet'!A1 — copy the quoted name verbatim, then its address
      let j = i + 1;
      while (j < formula.length) { if (formula[j] === "'") { if (formula[j + 1] === "'") { j += 2; continue; } break; } j++; }
      out += formula.slice(i, Math.min(j + 1, formula.length)); // includes closing quote
      i = j + 1;
      const sp = formula.slice(i).match(/^\s*/)?.[0].length ?? 0;
      if (formula[i + sp] === "!") {
        out += formula.slice(i, i + sp + 1); // spaces + !
        const [addr, k] = takeAddr(i + sp + 1, true);
        out += addr;
        i = k;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < formula.length && /[A-Za-z0-9_$]/.test(formula[j])) j++;
      const word = formula.slice(i, j);
      const after = formula.slice(j).match(/^\s*/)?.[0].length ?? 0;
      const nextCh = formula[j + after];
      if (nextCh === "(") { out += word; i = j; continue; } // function name
      if (nextCh === "!") {
        // `word` is a sheet name; copy it + spaces + ! then offset the address
        out += formula.slice(i, j + after + 1);
        const [addr, k] = takeAddr(j + after + 1, true);
        out += addr;
        i = k;
        continue;
      }
      out += rewriteAddr(word, false); // local ref (or a non-ref word, returned as-is)
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Quote a sheet name for use in a formula if it isn't a bare identifier. */
export function quoteSheetName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/**
 * Rewrite `Sheet!…` qualified references when a sheet is renamed, so formulas
 * across the workbook keep pointing at the renamed sheet. Matches both bare
 * (`Feuille2!A1`) and quoted (`'Mon onglet'!A1`) qualifiers, case-insensitively
 * (like Excel), and re-quotes the new name when it needs it.
 */
export function renameSheetRefs(formula: string, oldName: string, newName: string): string {
  if (formula[0] !== "=") return formula;
  const oldLc = oldName.toLowerCase();
  const replacement = quoteSheetName(newName);
  let out = "";
  let i = 0;
  const n = formula.length;
  const followedByBang = (idx: number): boolean => {
    const sp = formula.slice(idx).match(/^\s*/)?.[0].length ?? 0;
    return formula[idx + sp] === "!";
  };
  while (i < n) {
    const c = formula[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && formula[j] !== '"') j++;
      out += formula.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let name = "";
      while (j < n) { if (formula[j] === "'") { if (formula[j + 1] === "'") { name += "'"; j += 2; continue; } break; } name += formula[j]; j++; }
      const closed = Math.min(j + 1, n); // index just past the closing quote
      out += followedByBang(closed) && name.toLowerCase() === oldLc ? replacement : formula.slice(i, closed);
      i = closed;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(formula[j])) j++;
      const word = formula.slice(i, j);
      out += followedByBang(j) && word.toLowerCase() === oldLc ? replacement : word;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Substitute defined names with their target reference before evaluation, using
 * the same tokeniser discipline as rewriteRefs: string literals, quoted sheet
 * names, function names (`word(`), sheet qualifiers (`word!`) and bare cell
 * addresses are left untouched — only free identifiers that resolve to a name
 * are replaced. Names are workbook-scoped; `resolve` returns the target ref
 * (e.g. "Feuille1!$A$1:$B$2") for a given upper-cased name, or undefined.
 */
export function applyNamedRanges(formula: string, resolve: (name: string) => string | undefined): string {
  let out = "";
  let i = 0;
  const n = formula.length;
  while (i < n) {
    const c = formula[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && formula[j] !== '"') j++;
      out += formula.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) { if (formula[j] === "'") { if (formula[j + 1] === "'") { j += 2; continue; } break; } j++; }
      out += formula.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$.]/.test(formula[j])) j++;
      const word = formula.slice(i, j);
      const after = formula.slice(j).match(/^\s*/)?.[0].length ?? 0;
      const nextCh = formula[j + after];
      const isAddr = /^\$?[A-Za-z]+\$?[0-9]+$/.test(word);
      if (nextCh === "(" || nextCh === "!" || isAddr) { out += word; i = j; continue; }
      const target = resolve(word.toUpperCase());
      out += target !== undefined ? target : word;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// --- Coercion -------------------------------------------------------------

function toNumber(v: CellValue): number {
  if (isError(v)) throw new FormulaError(v.error);
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === "") return 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new FormulaError("#VALUE");
  return n;
}

// --- Tokenizer ------------------------------------------------------------

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "sheet"; v: string } // quoted sheet name ('Mon onglet') for cross-sheet refs
  | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isAlpha = (c: string) => /[A-Za-z_$]/.test(c); // $ allows absolute refs ($A$1)
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      let j = i;
      let dots = 0;
      while (j < src.length && (isDigit(src[j]) || src[j] === ".")) { if (src[j] === ".") dots++; j++; }
      if (dots > 1) throw new FormulaError("#NUM"); // malformed (e.g. 1.2.3) — don't silently truncate to 1.2
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') { s += src[j]; j++; }
      if (j >= src.length) throw new FormulaError("#ERR");
      toks.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      // quoted sheet name ('Mon onglet'!A1); '' is an escaped single quote
      let j = i + 1;
      let s = "";
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") { s += "'"; j += 2; continue; }
          break;
        }
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new FormulaError("#ERR");
      toks.push({ t: "sheet", v: s });
      i = j + 1;
      continue;
    }
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    // multi-char operators
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { toks.push({ t: "op", v: two }); i += 2; continue; }
    if (c === ";") { toks.push({ t: "op", v: "," }); i++; continue; } // FR argument separator
    if ("+-*/(),:=<>!".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; } // ! = sheet separator (Feuille2!A1)
    // A reference that was invalidated by a deleted row/column is rewritten to
    // `#REF!` in the stored formula; encountering it makes the whole cell #REF.
    if (c === "#") throw new FormulaError("#REF");
    throw new FormulaError("#ERR");
  }
  return toks;
}

// --- AST -------------------------------------------------------------------
//
// Parsing builds a tree WITHOUT evaluating; a separate pass walks the tree.
// This split is what makes IFERROR/IFNA possible: a sub-expression can be
// evaluated inside a try/catch and its error swallowed, instead of an error
// anywhere in the formula tearing down the whole cell (which is what the old
// evaluate-as-you-parse design forced).

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "ref"; v: string; sheet?: string } // normalized: uppercase, $ stripped; sheet = cross-sheet qualifier
  | { k: "range"; a: string; b: string; sheet?: string } // A1:B2 (uppercase); sheet = cross-sheet qualifier
  | { k: "neg"; e: Node }
  | { k: "bin"; op: string; l: Node; r: Node } // + - * / and comparisons
  | { k: "call"; name: string; args: Node[] };

const COMPARE_OPS = ["=", "<>", "<", ">", "<=", ">="];

// --- Parser (recursive descent → AST, no evaluation) -----------------------

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.p];
  }
  private next(): Tok | undefined {
    return this.toks[this.p++];
  }
  private eatOp(v: string) {
    const t = this.next();
    if (!t || t.t !== "op" || t.v !== v) throw new FormulaError("#ERR");
  }

  parse(): Node {
    const n = this.comparison();
    if (this.p !== this.toks.length) throw new FormulaError("#ERR");
    return n;
  }

  // A single (non-chained) comparison, lowest precedence.
  private comparison(): Node {
    let n = this.additive();
    const t = this.peek();
    if (t && t.t === "op" && COMPARE_OPS.includes(t.v)) {
      this.next();
      n = { k: "bin", op: t.v, l: n, r: this.additive() };
    }
    return n;
  }

  private additive(): Node {
    let n = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
        this.next();
        n = { k: "bin", op: t.v, l: n, r: this.multiplicative() };
      } else break;
    }
    return n;
  }

  private multiplicative(): Node {
    let n = this.unary();
    for (;;) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/")) {
        this.next();
        n = { k: "bin", op: t.v, l: n, r: this.unary() };
      } else break;
    }
    return n;
  }

  private unary(): Node {
    const t = this.peek();
    if (t && t.t === "op" && t.v === "-") {
      this.next();
      return { k: "neg", e: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.next();
    if (!t) throw new FormulaError("#ERR");
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "op" && t.v === "(") {
      const n = this.comparison();
      this.eatOp(")");
      return n;
    }
    if (t.t === "sheet") return this.qualifiedRef(t.v); // 'Mon onglet'!A1
    if (t.t === "id") {
      const nx = this.peek();
      if (nx && nx.t === "op" && nx.v === "(") return this.funcCall(t.v.toUpperCase());
      if (nx && nx.t === "op" && nx.v === "!") return this.qualifiedRef(t.v); // Feuille2!A1
      const up = t.v.toUpperCase();
      // cell ref ($ anchors don't affect resolution, so strip them here)
      if (REF_RE.test(up)) return { k: "ref", v: up.replace(/\$/g, "") };
      // bare name (TRUE/FALSE)
      if (up === "TRUE") return { k: "bool", v: true };
      if (up === "FALSE") return { k: "bool", v: false };
      throw new FormulaError("#NAME");
    }
    throw new FormulaError("#ERR");
  }

  /** Parse `Sheet!A1` once the sheet name has been consumed. */
  private qualifiedRef(sheet: string): Node {
    this.eatOp("!");
    const t = this.next();
    if (!t || t.t !== "id" || !REF_RE.test(t.v.toUpperCase())) throw new FormulaError("#ERR");
    return { k: "ref", v: t.v.toUpperCase().replace(/\$/g, ""), sheet };
  }

  /** Collect function args; an arg may be a range A1:B2. */
  private funcCall(name: string): Node {
    this.eatOp("(");
    const args: Node[] = [];
    if (!(this.peek()?.t === "op" && this.peek()?.v === ")")) {
      for (;;) {
        args.push(this.argument());
        const t = this.peek();
        if (t && t.t === "op" && t.v === ",") { this.next(); continue; }
        break;
      }
    }
    this.eatOp(")");
    return { k: "call", name, args };
  }

  private argument(): Node {
    // range? [Sheet '!'] IDENT ':' IDENT where both are cell refs
    const q = this.peek();
    let base = 0;
    let sheet: string | undefined;
    if (q && (q.t === "sheet" || q.t === "id") && this.toks[this.p + 1]?.t === "op" && this.toks[this.p + 1]?.v === "!") {
      sheet = q.v;
      base = 2; // skip the qualifier (Sheet '!') when probing for a range
    }
    const a = this.toks[this.p + base];
    const colon = this.toks[this.p + base + 1];
    const end = this.toks[this.p + base + 2];
    if (
      a && a.t === "id" && REF_RE.test(a.v.toUpperCase()) &&
      colon && colon.t === "op" && colon.v === ":" &&
      end && end.t === "id" && REF_RE.test(end.v.toUpperCase())
    ) {
      this.p += base + 3;
      return { k: "range", a: a.v.toUpperCase(), b: end.v.toUpperCase(), sheet };
    }
    // not a range — let the expression grammar handle it (incl. a single Sheet!A1)
    return this.comparison();
  }
}

function parseFormula(toks: Tok[]): Node {
  return new Parser(toks).parse();
}

// --- Evaluator (walks the AST) ---------------------------------------------

// `sheet` is the cross-sheet qualifier (null = the current/local sheet).
type Resolve = (ref: string, sheet: string | null) => CellValue;

/** Functions whose arguments must NOT be eagerly evaluated (they decide which
 * sub-expressions to run, and may swallow errors). */
function evalGuarded(name: string, args: Node[], resolve: Resolve): CellValue | undefined {
  if (name !== "IFERROR" && name !== "IFNA") return undefined;
  // IFNA only intercepts #N/A; IFERROR intercepts any error.
  const wanted = name === "IFNA" ? "#N/A" : null;
  let v: CellValue;
  try {
    v = args[0] ? evaluate(args[0], resolve) : "";
  } catch (e) {
    v = { error: e instanceof FormulaError && e.message ? e.message : "#ERR" };
  }
  if (isError(v) && (wanted === null || v.error === wanted)) {
    return args[1] ? evaluate(args[1], resolve) : "";
  }
  return v;
}

function evaluate(node: Node, resolve: Resolve): CellValue {
  switch (node.k) {
    case "num": return node.v;
    case "str": return node.v;
    case "bool": return node.v;
    case "ref": return resolve(node.v, node.sheet ?? null);
    case "range": {
      // A range only reaches here when used in scalar position (e.g. as a
      // direct IFERROR argument): collapse to its first cell.
      const refs = expandRange(node.a, node.b);
      return refs.length ? resolve(refs[0], node.sheet ?? null) : { error: "#REF" };
    }
    case "neg":
      return -toNumber(evaluate(node.e, resolve));
    case "bin":
      return evalBin(node.op, node.l, node.r, resolve);
    case "call": {
      const guarded = evalGuarded(node.name, node.args, resolve);
      if (guarded !== undefined) return guarded;
      // Eager path: evaluate every arg (ranges expand to value lists + shape).
      const args: CellValue[][] = [];
      const shapes: (RangeShape | null)[] = [];
      for (const a of node.args) {
        if (a.k === "range") {
          const pa = parseRef(a.a)!;
          const pb = parseRef(a.b)!;
          args.push(expandRange(a.a, a.b).map((r) => resolve(r, a.sheet ?? null)));
          shapes.push({ rows: Math.abs(pa.row - pb.row) + 1, cols: Math.abs(pa.col - pb.col) + 1 });
        } else {
          args.push([evaluate(a, resolve)]);
          shapes.push(null);
        }
      }
      return applyFunction(node.name, args, shapes);
    }
  }
}

function evalBin(op: string, ln: Node, rn: Node, resolve: Resolve): CellValue {
  if (COMPARE_OPS.includes(op)) {
    const left = evaluate(ln, resolve);
    const right = evaluate(rn, resolve);
    if (isError(left)) return left;
    if (isError(right)) return right;
    // Numeric comparison when both sides are numeric, else string comparison.
    const an = typeof left === "boolean" ? (left ? 1 : 0) : Number(left);
    const bn = typeof right === "boolean" ? (right ? 1 : 0) : Number(right);
    const numeric = left !== "" && right !== "" && !Number.isNaN(an) && !Number.isNaN(bn);
    const a: number | string = numeric ? an : String(left);
    const b: number | string = numeric ? bn : String(right);
    switch (op) {
      case "=": return a === b;
      case "<>": return a !== b;
      case "<": return a < b;
      case ">": return a > b;
      case "<=": return a <= b;
      default: return a >= b; // ">="
    }
  }
  // Arithmetic: both operands coerced to number (an error operand throws).
  const l = toNumber(evaluate(ln, resolve));
  const r = toNumber(evaluate(rn, resolve));
  switch (op) {
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    default: // "/"
      if (r === 0) throw new FormulaError("#DIV/0");
      return l / r;
  }
}

function flat(args: CellValue[][]): CellValue[] {
  return args.flat();
}
function nums(args: CellValue[][]): number[] {
  const out: number[] = [];
  for (const v of flat(args)) {
    if (v === "" || isError(v)) {
      if (isError(v)) throw new FormulaError(v.error);
      continue; // skip blanks
    }
    if (typeof v === "number") out.push(v);
    else if (typeof v === "boolean") out.push(v ? 1 : 0);
    else {
      const n = Number(v);
      if (!Number.isNaN(n)) out.push(n); // numeric strings count; text ignored
    }
  }
  return out;
}

const DATE_EPOCH = Date.UTC(1899, 11, 30);
function serialDate(s: number): Date {
  return new Date(DATE_EPOCH + Math.round(s) * 86400000);
}
function todaySerial(): number {
  const d = new Date();
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - DATE_EPOCH) / 86400000);
}

function n0(args: CellValue[][], i = 0): number {
  return toNumber(args[i]?.[0] ?? 0);
}
function s0(args: CellValue[][], i = 0): string {
  const v = args[i]?.[0];
  if (v == null || isError(v)) return "";
  return typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
}
function truthy(v: CellValue | undefined): boolean {
  if (v == null) return false;
  if (isError(v)) throw new FormulaError(v.error);
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v.length > 0 && v.toUpperCase() !== "FALSE";
}

/** Excel-style criterion: ">5", "<=3", "<>x", or a plain value (equality). */
function matchCriterion(value: CellValue, crit: CellValue): boolean {
  if (isError(value)) return false;
  const cs = typeof crit === "string" ? crit : crit == null ? "" : String(crit);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(cs);
  const op = m?.[1] || "=";
  const target = (m?.[2] ?? "").trim();
  const tn = Number(target);
  const vn = typeof value === "number" ? value : Number(value);
  const bothNum = target !== "" && !Number.isNaN(tn) && !Number.isNaN(vn);
  if (op === "=") return bothNum ? vn === tn : String(value) === target;
  if (op === "<>") return bothNum ? vn !== tn : String(value) !== target;
  if (!bothNum) return false;
  if (op === "<") return vn < tn;
  if (op === ">") return vn > tn;
  if (op === "<=") return vn <= tn;
  return vn >= tn;
}

/** Case-insensitive loose equality used by lookups (numeric when both numeric). */
function looseEq(a: CellValue, b: CellValue): boolean {
  if (isError(a) || isError(b)) return false;
  const an = typeof a === "number" ? a : Number(a);
  const bn = typeof b === "number" ? b : Number(b);
  if (a !== "" && b !== "" && !Number.isNaN(an) && !Number.isNaN(bn)) return an === bn;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Ordered comparison (numeric when both numeric, else case-insensitive text). */
function cmpVals(a: CellValue, b: CellValue): number {
  const an = typeof a === "number" ? a : Number(a);
  const bn = typeof b === "number" ? b : Number(b);
  if (a !== "" && b !== "" && !Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
  const as = String(a).toLowerCase(), bs = String(b).toLowerCase();
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Pragmatic TEXT() formatter: percent, fixed decimals/grouping, and dd/mm/yyyy dates. */
function textFormat(v: CellValue | undefined, fmt: string): string {
  if (v == null || isError(v as CellValue)) return "";
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  const f = fmt || "";
  const decimals = (f.split(".")[1]?.match(/0/g)?.length) ?? 0;
  if (/%/.test(f)) return new Intl.NumberFormat("fr-FR", { style: "percent", minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
  if (/[dmy]/i.test(f) && !/[#0]/.test(f)) {
    const d = serialDate(n);
    const p = (x: number) => String(x).padStart(2, "0");
    return f
      .replace(/yyyy/gi, String(d.getUTCFullYear()))
      .replace(/yy/gi, String(d.getUTCFullYear()).slice(-2))
      .replace(/mm/g, p(d.getUTCMonth() + 1))
      .replace(/dd/gi, p(d.getUTCDate()));
  }
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: /,|#,/.test(f) }).format(n);
}

function applyFunction(name: string, args: CellValue[][], shapes: (RangeShape | null)[] = []): CellValue {
  switch (name) {
    // --- agrégats ---
    case "SUM": return nums(args).reduce((a, b) => a + b, 0);
    case "AVERAGE":
    case "AVG": {
      const ns = nums(args);
      if (ns.length === 0) throw new FormulaError("#DIV/0");
      return ns.reduce((a, b) => a + b, 0) / ns.length;
    }
    case "MIN": { const ns = nums(args); return ns.length ? Math.min(...ns) : 0; }
    case "MAX": { const ns = nums(args); return ns.length ? Math.max(...ns) : 0; }
    case "COUNT": return nums(args).length;
    case "COUNTA": return flat(args).filter((v) => v !== "").length;
    case "PRODUCT": return nums(args).reduce((a, b) => a * b, 1);
    case "MEDIAN": {
      const ns = nums(args).slice().sort((a, b) => a - b);
      if (!ns.length) throw new FormulaError("#NUM");
      const m = Math.floor(ns.length / 2);
      return ns.length % 2 ? ns[m] : (ns[m - 1] + ns[m]) / 2;
    }
    case "COUNTIF": {
      const crit = args[1]?.[0] ?? "";
      return (args[0] ?? []).filter((v) => matchCriterion(v, crit)).length;
    }
    case "SUMIF": {
      const range = args[0] ?? [];
      const crit = args[1]?.[0] ?? "";
      const sumRange = args[2] ?? range;
      let s = 0;
      range.forEach((v, i) => {
        if (!matchCriterion(v, crit)) return;
        const sv = sumRange[i];
        if (typeof sv === "number") s += sv;
        else if (typeof sv === "string" && sv !== "") {
          const n = Number(sv);
          if (!Number.isNaN(n)) s += n;
        }
      });
      return s;
    }
    case "SUMIFS": {
      const sum = args[0] ?? [];
      let total = 0;
      for (let i = 0; i < sum.length; i++) {
        let ok = true;
        for (let a = 1; a + 1 < args.length; a += 2) {
          if (!matchCriterion((args[a] ?? [])[i], args[a + 1]?.[0] ?? "")) { ok = false; break; }
        }
        if (!ok) continue;
        const v = sum[i];
        const n = typeof v === "number" ? v : Number(v);
        if (v !== "" && !Number.isNaN(n)) total += n;
      }
      return total;
    }
    case "COUNTIFS": {
      const first = args[0] ?? [];
      let count = 0;
      for (let i = 0; i < first.length; i++) {
        let ok = true;
        for (let a = 0; a + 1 < args.length; a += 2) {
          if (!matchCriterion((args[a] ?? [])[i], args[a + 1]?.[0] ?? "")) { ok = false; break; }
        }
        if (ok) count++;
      }
      return count;
    }
    case "AVERAGEIF": {
      const range = args[0] ?? [];
      const crit = args[1]?.[0] ?? "";
      const avg = args[2] ?? range;
      let s = 0, c = 0;
      range.forEach((v, i) => {
        if (!matchCriterion(v, crit)) return;
        const av = avg[i];
        const n = typeof av === "number" ? av : Number(av);
        if (av !== "" && av != null && !Number.isNaN(n)) { s += n; c++; }
      });
      if (c === 0) throw new FormulaError("#DIV/0");
      return s / c;
    }
    case "IFS": {
      for (let a = 0; a + 1 < args.length; a += 2) if (truthy(args[a]?.[0])) return args[a + 1]?.[0] ?? "";
      throw new FormulaError("#N/A");
    }
    case "SUBSTITUTE": {
      const t = s0(args, 0), old = s0(args, 1), rep = s0(args, 2);
      if (old === "") return t;
      if (args[3]) {
        const nth = Math.trunc(n0(args, 3));
        let from = 0, count = 0, idx = -1;
        while ((idx = t.indexOf(old, from)) >= 0) {
          if (++count === nth) return t.slice(0, idx) + rep + t.slice(idx + old.length);
          from = idx + old.length;
        }
        return t;
      }
      return t.split(old).join(rep);
    }
    case "FIND": {
      const idx = s0(args, 1).indexOf(s0(args, 0), args[2] ? Math.max(0, Math.trunc(n0(args, 2)) - 1) : 0);
      if (idx < 0) throw new FormulaError("#VALUE");
      return idx + 1;
    }
    case "SEARCH": {
      const idx = s0(args, 1).toLowerCase().indexOf(s0(args, 0).toLowerCase(), args[2] ? Math.max(0, Math.trunc(n0(args, 2)) - 1) : 0);
      if (idx < 0) throw new FormulaError("#VALUE");
      return idx + 1;
    }
    case "REPLACE": {
      const t = s0(args, 0), start = Math.max(0, Math.trunc(n0(args, 1)) - 1), count = Math.max(0, Math.trunc(n0(args, 2)));
      return t.slice(0, start) + s0(args, 3) + t.slice(start + count);
    }
    case "DATE": {
      const ms = Date.UTC(Math.trunc(n0(args, 0)), Math.trunc(n0(args, 1)) - 1, Math.trunc(n0(args, 2)));
      return Math.round((ms - DATE_EPOCH) / 86400000);
    }
    case "TEXT": return textFormat(args[0]?.[0], s0(args, 1));
    // --- recherche ---
    case "VLOOKUP":
    case "HLOOKUP": {
      const key = args[0]?.[0] ?? "";
      const table = args[1] ?? [];
      const shape = shapes[1];
      if (!shape) throw new FormulaError("#REF");
      const { rows, cols } = shape;
      const idx = Math.trunc(n0(args, 2)); // 1-based: column (V) or row (H) to return
      const approx = args[3] ? truthy(args[3][0]) : true; // par défaut : approché (comme Excel/Sheets)
      const isV = name === "VLOOKUP";
      const lanes = isV ? rows : cols; // candidate rows (V) / columns (H)
      const keyAt = (l: number) => (isV ? table[l * cols] : table[l]); // first column / first row
      const resultAt = (l: number) => {
        if (isV) { if (idx < 1 || idx > cols) throw new FormulaError("#REF"); return table[l * cols + (idx - 1)] ?? ""; }
        if (idx < 1 || idx > rows) throw new FormulaError("#REF");
        return table[(idx - 1) * cols + l] ?? "";
      };
      if (!approx) {
        for (let l = 0; l < lanes; l++) if (looseEq(keyAt(l), key)) return resultAt(l);
        throw new FormulaError("#N/A");
      }
      let best = -1;
      for (let l = 0; l < lanes; l++) { if (cmpVals(keyAt(l), key) <= 0) best = l; else break; }
      if (best < 0) throw new FormulaError("#N/A");
      return resultAt(best);
    }
    case "MATCH": {
      const key = args[0]?.[0] ?? "";
      const range = args[1] ?? [];
      const type = args[2] ? Math.trunc(n0(args, 2)) : 1; // 0 exact, 1 ↑ trié, -1 ↓ trié
      if (type === 0) {
        for (let i = 0; i < range.length; i++) if (looseEq(range[i], key)) return i + 1;
        throw new FormulaError("#N/A");
      }
      let best = -1;
      for (let i = 0; i < range.length; i++) {
        const cmp = cmpVals(range[i], key);
        if (type === 1 ? cmp <= 0 : cmp >= 0) best = i; else break;
      }
      if (best < 0) throw new FormulaError("#N/A");
      return best + 1;
    }
    case "INDEX": {
      const range = args[0] ?? [];
      const shape = shapes[0];
      const a1 = Math.trunc(n0(args, 1));
      if (!shape || shape.rows === 1 || shape.cols === 1) {
        // 1-D range: a single position (use the column arg when the range is one row)
        const i = (args[2] && shape && shape.rows === 1 ? Math.trunc(n0(args, 2)) : a1) - 1;
        if (i < 0 || i >= range.length) throw new FormulaError("#REF");
        return range[i] ?? "";
      }
      const r = a1 - 1, c = (args[2] ? Math.trunc(n0(args, 2)) : 1) - 1;
      if (r < 0 || r >= shape.rows || c < 0 || c >= shape.cols) throw new FormulaError("#REF");
      return range[r * shape.cols + c] ?? "";
    }
    // --- maths ---
    case "ABS": return Math.abs(n0(args));
    case "SQRT": { const x = n0(args); if (x < 0) throw new FormulaError("#NUM"); return Math.sqrt(x); }
    case "POWER": return Math.pow(n0(args, 0), n0(args, 1));
    case "EXP": return Math.exp(n0(args));
    case "LN": { const x = n0(args); if (x <= 0) throw new FormulaError("#NUM"); return Math.log(x); }
    case "LOG": { const x = n0(args); const base = args[1] ? n0(args, 1) : 10; if (x <= 0 || base <= 0) throw new FormulaError("#NUM"); return Math.log(x) / Math.log(base); }
    case "MOD": { const b = n0(args, 1); if (b === 0) throw new FormulaError("#DIV/0"); return n0(args, 0) % b; }
    case "INT": return Math.floor(n0(args));
    case "SIGN": return Math.sign(n0(args));
    case "CEILING": return Math.ceil(n0(args));
    case "FLOOR": return Math.floor(n0(args));
    case "ROUND": { const x = n0(args, 0); const d = args[1] ? n0(args, 1) : 0; const f = Math.pow(10, d); return Math.round(x * f) / f; }
    case "ROUNDUP": { const x = n0(args, 0); const d = args[1] ? n0(args, 1) : 0; const f = Math.pow(10, d); return (Math.ceil(Math.abs(x) * f) / f) * (x < 0 ? -1 : 1); }
    case "ROUNDDOWN": { const x = n0(args, 0); const d = args[1] ? n0(args, 1) : 0; const f = Math.pow(10, d); return Math.trunc(x * f) / f; }
    // --- logique ---
    case "IF": { const branch = truthy(args[0]?.[0]) ? args[1] : args[2]; return branch?.[0] ?? ""; }
    case "AND": return flat(args).every(truthy);
    case "OR": return flat(args).some(truthy);
    case "NOT": return !truthy(args[0]?.[0]);
    // --- texte ---
    case "CONCAT":
    case "CONCATENATE":
      return flat(args).map((v) => (isError(v) ? v.error : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v))).join("");
    case "LEN": return s0(args).length;
    case "LEFT": { const t = s0(args); const n = args[1] ? Math.trunc(n0(args, 1)) : 1; return t.slice(0, Math.max(0, n)); }
    case "RIGHT": { const t = s0(args); const n = args[1] ? Math.trunc(n0(args, 1)) : 1; return n <= 0 ? "" : t.slice(-n); }
    case "MID": { const t = s0(args); const start = Math.max(0, Math.trunc(n0(args, 1)) - 1); const len = Math.max(0, Math.trunc(n0(args, 2))); return t.slice(start, start + len); }
    case "UPPER": return s0(args).toUpperCase();
    case "LOWER": return s0(args).toLowerCase();
    case "TRIM": return s0(args).trim().replace(/\s+/g, " ");
    // --- date ---
    case "TODAY": return todaySerial();
    case "NOW": return (Date.now() - DATE_EPOCH) / 86400000;
    case "YEAR": return serialDate(n0(args)).getUTCFullYear();
    case "MONTH": return serialDate(n0(args)).getUTCMonth() + 1;
    case "DAY": return serialDate(n0(args)).getUTCDate();
    default:
      throw new FormulaError("#NAME");
  }
}

export interface FnDoc { name: string; sig: string; desc: string; cat: string; }

/** Catalogue de fonctions pour la bibliothèque de formules (insertion guidée). */
export const FUNCTIONS: FnDoc[] = [
  { name: "SUM", sig: "SUM(plage)", desc: "Somme des nombres", cat: "Maths" },
  { name: "AVERAGE", sig: "AVERAGE(plage)", desc: "Moyenne", cat: "Maths" },
  { name: "MIN", sig: "MIN(plage)", desc: "Valeur minimale", cat: "Maths" },
  { name: "MAX", sig: "MAX(plage)", desc: "Valeur maximale", cat: "Maths" },
  { name: "PRODUCT", sig: "PRODUCT(plage)", desc: "Produit des nombres", cat: "Maths" },
  { name: "ABS", sig: "ABS(n)", desc: "Valeur absolue", cat: "Maths" },
  { name: "SQRT", sig: "SQRT(n)", desc: "Racine carrée", cat: "Maths" },
  { name: "POWER", sig: "POWER(n; p)", desc: "n puissance p", cat: "Maths" },
  { name: "MOD", sig: "MOD(a; b)", desc: "Reste de la division", cat: "Maths" },
  { name: "INT", sig: "INT(n)", desc: "Partie entière", cat: "Maths" },
  { name: "ROUND", sig: "ROUND(n; déc)", desc: "Arrondi", cat: "Maths" },
  { name: "ROUNDUP", sig: "ROUNDUP(n; déc)", desc: "Arrondi supérieur", cat: "Maths" },
  { name: "ROUNDDOWN", sig: "ROUNDDOWN(n; déc)", desc: "Arrondi inférieur", cat: "Maths" },
  { name: "CEILING", sig: "CEILING(n)", desc: "Arrondi à l'entier sup.", cat: "Maths" },
  { name: "FLOOR", sig: "FLOOR(n)", desc: "Arrondi à l'entier inf.", cat: "Maths" },
  { name: "EXP", sig: "EXP(n)", desc: "Exponentielle", cat: "Maths" },
  { name: "LN", sig: "LN(n)", desc: "Logarithme népérien", cat: "Maths" },
  { name: "LOG", sig: "LOG(n; base)", desc: "Logarithme", cat: "Maths" },
  { name: "SIGN", sig: "SIGN(n)", desc: "Signe (-1, 0, 1)", cat: "Maths" },
  { name: "COUNT", sig: "COUNT(plage)", desc: "Nombre de valeurs numériques", cat: "Statistiques" },
  { name: "COUNTA", sig: "COUNTA(plage)", desc: "Nombre de cellules non vides", cat: "Statistiques" },
  { name: "MEDIAN", sig: "MEDIAN(plage)", desc: "Médiane", cat: "Statistiques" },
  { name: "COUNTIF", sig: "COUNTIF(plage; critère)", desc: "Compte selon un critère", cat: "Statistiques" },
  { name: "SUMIF", sig: "SUMIF(plage; critère; [somme])", desc: "Somme selon un critère", cat: "Statistiques" },
  { name: "SUMIFS", sig: "SUMIFS(somme; plage1; crit1; …)", desc: "Somme multi-critères", cat: "Statistiques" },
  { name: "COUNTIFS", sig: "COUNTIFS(plage1; crit1; …)", desc: "Compte multi-critères", cat: "Statistiques" },
  { name: "AVERAGEIF", sig: "AVERAGEIF(plage; critère; [moy])", desc: "Moyenne selon un critère", cat: "Statistiques" },
  { name: "VLOOKUP", sig: "VLOOKUP(clé; table; index; [approx])", desc: "Recherche verticale", cat: "Recherche" },
  { name: "HLOOKUP", sig: "HLOOKUP(clé; table; index; [approx])", desc: "Recherche horizontale", cat: "Recherche" },
  { name: "INDEX", sig: "INDEX(plage; ligne; [colonne])", desc: "Valeur par position", cat: "Recherche" },
  { name: "MATCH", sig: "MATCH(clé; plage; [type])", desc: "Position d'une valeur", cat: "Recherche" },
  { name: "IF", sig: "IF(test; si_vrai; si_faux)", desc: "Condition", cat: "Logique" },
  { name: "IFS", sig: "IFS(test1; val1; …)", desc: "Premier test vrai", cat: "Logique" },
  { name: "IFERROR", sig: "IFERROR(valeur; si_erreur)", desc: "Remplace une erreur par une valeur", cat: "Logique" },
  { name: "IFNA", sig: "IFNA(valeur; si_na)", desc: "Remplace #N/A par une valeur", cat: "Logique" },
  { name: "AND", sig: "AND(a; b; …)", desc: "ET logique", cat: "Logique" },
  { name: "OR", sig: "OR(a; b; …)", desc: "OU logique", cat: "Logique" },
  { name: "NOT", sig: "NOT(a)", desc: "Négation", cat: "Logique" },
  { name: "CONCAT", sig: "CONCAT(a; b; …)", desc: "Concatène du texte", cat: "Texte" },
  { name: "LEN", sig: "LEN(texte)", desc: "Longueur", cat: "Texte" },
  { name: "LEFT", sig: "LEFT(texte; n)", desc: "n premiers caractères", cat: "Texte" },
  { name: "RIGHT", sig: "RIGHT(texte; n)", desc: "n derniers caractères", cat: "Texte" },
  { name: "MID", sig: "MID(texte; début; n)", desc: "Sous-chaîne", cat: "Texte" },
  { name: "UPPER", sig: "UPPER(texte)", desc: "Majuscules", cat: "Texte" },
  { name: "LOWER", sig: "LOWER(texte)", desc: "Minuscules", cat: "Texte" },
  { name: "TRIM", sig: "TRIM(texte)", desc: "Supprime les espaces superflus", cat: "Texte" },
  { name: "SUBSTITUTE", sig: "SUBSTITUTE(texte; ancien; nouveau; [n])", desc: "Remplace du texte", cat: "Texte" },
  { name: "FIND", sig: "FIND(cherché; texte; [début])", desc: "Position (sensible à la casse)", cat: "Texte" },
  { name: "SEARCH", sig: "SEARCH(cherché; texte; [début])", desc: "Position (insensible à la casse)", cat: "Texte" },
  { name: "REPLACE", sig: "REPLACE(texte; début; n; nouveau)", desc: "Remplace par position", cat: "Texte" },
  { name: "TEXT", sig: "TEXT(valeur; format)", desc: "Formate un nombre/date", cat: "Texte" },
  { name: "TODAY", sig: "TODAY()", desc: "Date du jour", cat: "Date" },
  { name: "NOW", sig: "NOW()", desc: "Date et heure", cat: "Date" },
  { name: "YEAR", sig: "YEAR(date)", desc: "Année", cat: "Date" },
  { name: "MONTH", sig: "MONTH(date)", desc: "Mois", cat: "Date" },
  { name: "DAY", sig: "DAY(date)", desc: "Jour", cat: "Date" },
  { name: "DATE", sig: "DATE(année; mois; jour)", desc: "Construit une date", cat: "Date" },
];

// --- Public API -----------------------------------------------------------

/** Cross-sheet access for cross-sheet references (Feuille2!A1). */
export interface CrossSheet {
  /** Raw content of a cell on a named sheet (undefined if empty/missing). */
  getSheetRaw: (sheet: string, ref: string) => string | undefined;
  /** Whether a sheet of that name exists (else qualified refs return #REF). */
  hasSheet: (sheet: string) => boolean;
}

/**
 * Build a calculator over a cell map. `getRaw(ref)` returns the raw string of a
 * cell on the active sheet. Pass `cross` to resolve cross-sheet references
 * (`Feuille2!A1`). `valueOf(ref)` returns the computed value, memoized with
 * cycle detection. `display(ref)` returns the string to show in the grid.
 *
 * Internally a "context" is the sheet a formula lives on: `null` = the active
 * sheet (via getRaw), a string = a named sheet (via cross.getSheetRaw). A
 * formula's local refs resolve in its own context; qualified refs in the named
 * sheet. The cache/cycle key is `context + ref`, so the same address on two
 * sheets stays distinct.
 */
export function createCalc(
  getRaw: (ref: string) => string | undefined,
  cross?: CrossSheet,
  names?: (name: string) => string | undefined,
) {
  const cache = new Map<string, CellValue>();
  const visiting = new Set<string>();

  const rawIn = (ctx: string | null, ref: string): string | undefined =>
    ctx === null ? getRaw(ref) : cross?.getSheetRaw(ctx, ref);

  function valueOf(ctx: string | null, ref: string): CellValue {
    const key = (ctx ?? "") + " " + ref;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return { error: "#CYCLE" };
    visiting.add(key);
    const v = evalRaw(rawIn(ctx, ref), ctx);
    visiting.delete(key);
    cache.set(key, v);
    return v;
  }

  function evalRaw(raw: string | undefined, ctx: string | null): CellValue {
    if (raw == null || raw === "") return "";
    if (raw[0] === "=") {
      try {
        const resolve: Resolve = (ref, sheet) => {
          if (sheet === null) return valueOf(ctx, ref); // local → same sheet
          if (!cross || !cross.hasSheet(sheet)) return { error: "#REF" };
          return valueOf(sheet, ref); // qualified → named sheet
        };
        const body = names ? applyNamedRanges(raw.slice(1), names) : raw.slice(1);
        return evaluate(parseFormula(tokenize(body)), resolve);
      } catch (e) {
        return { error: e instanceof FormulaError && e.message ? e.message : "#ERR" };
      }
    }
    const n = Number(raw);
    return raw.trim() !== "" && !Number.isNaN(n) ? n : raw;
  }

  function display(ref: string): string {
    const v = valueOf(null, ref);
    if (isError(v)) return v.error;
    if (typeof v === "boolean") return v ? "VRAI" : "FAUX";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
    return v;
  }

  return { valueOf: (ref: string) => valueOf(null, ref), display };
}
