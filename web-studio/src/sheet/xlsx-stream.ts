/**
 * Lecteur XLSX en flux, sans DOM : tourne dans un Web Worker (voir
 * xlsx-import.worker.ts) comme en ligne de commande ou en test.
 *
 * Le gros d'un classeur (`<sheetData>` d'une feuille, `sharedStrings.xml`) n'est
 * jamais construit en arbre : on décompresse par petits blocs (fflate `Inflate`),
 * on découpe ligne par ligne et on n'envoie à l'appelant que des lots compacts de
 * cellules (indices numériques + valeur). Le fil principal ne manipule jamais
 * plus d'un lot à la fois, et une feuille géante n'est lue que sur la plage
 * demandée (ou jusqu'au plafond de cellules) : le reste est décompressé sans
 * être analysé, voire pas du tout.
 *
 * Les petites parties (styles, thème, relations, dessins, commentaires…) sont
 * renvoyées telles quelles : l'appelant les lit avec le DOMParser, c'est
 * négligeable. Le flux ne s'occupe que de ce qui peut être énorme.
 */
import { Inflate, inflateSync } from "fflate";
import { decodeOoxmlEscapes, stripXlfnPrefixes } from "./xlsx-text";
import { rewriteRefs } from "./formula";

// ── options et messages ─────────────────────────────────────────────────────

/** Plage d'import d'une feuille (lignes numérotées comme dans Excel, à partir de 1). */
export interface SheetWindow {
  /** Ne pas importer cette feuille (elle reste dans le classeur, vide). */
  skip?: boolean;
  rowStart?: number;
  rowEnd?: number;
  /** Conserver la ligne 1 en tête quand `rowStart` > 1. */
  keepHeader?: boolean;
}

export interface StreamOptions {
  /** Plage par chemin de feuille (`xl/worksheets/sheet3.xml`). */
  windows?: Record<string, SheetWindow>;
  maxCellsPerSheet?: number;
  maxCellsTotal?: number;
}

/** Plafonds par défaut : un modèle `cells` en objets ne supporte pas des millions de cellules. */
export const DEFAULT_MAX_CELLS_PER_SHEET = 250_000;
export const DEFAULT_MAX_CELLS_TOTAL = 400_000;

export interface MetaMsg {
  type: "meta";
  /** Petites parties du paquet (hors feuilles et chaînes partagées), décompressées. */
  zip: Record<string, Uint8Array>;
  sheetPaths: string[];
  /** Taille décompressée de chaque feuille. */
  sheetBytes: Record<string, number>;
}
export interface CellsMsg {
  type: "cells";
  path: string;
  rows: Int32Array; // 0-based, après remise en forme de la plage
  cols: Int32Array;
  styles: Int32Array; // indice de style `s` (0 = aucun)
  /** 1 = valeur numérique brute (sert à la conversion des dates 1904). */
  kinds: Uint8Array;
  vals: (string | null)[];
}
export interface SheetMsg {
  type: "sheet";
  path: string;
  /** Balise ouvrante `<worksheet …>` (porte les espaces de noms). */
  rootOpen: string;
  /** XML avant `<sheetData>` (cols, vues, …). */
  head: string;
  /** XML après `</sheetData>` ; `null` quand la lecture s'est arrêtée avant la fin. */
  tail: string | null;
  /** [ligne 0-based, hauteur en points] */
  rowHeights: [number, number][];
  cells: number;
  truncated: boolean;
  skipped: boolean;
  /** Dernière ligne annoncée par `<dimension>` (0 si absente). */
  totalRows: number;
  /** Première et dernière lignes (numérotation Excel) réellement lues. */
  firstRow: number;
  lastRow: number;
  /** Octets décompressés de la feuille d'origine. */
  originalBytes: number;
}
export interface ProgressMsg {
  type: "progress";
  fraction: number;
  label: string;
}
export type StreamMsg = MetaMsg | CellsMsg | SheetMsg | ProgressMsg;

// ── archive ZIP (répertoire central lu à la main : accès direct, sans ordre imposé) ──

interface ZipEntry {
  name: string;
  method: number;
  csize: number;
  usize: number;
  offset: number;
}

function readZipDirectory(b: Uint8Array): ZipEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const min = Math.max(0, b.length - 22 - 65535);
  let e = b.length - 22;
  for (; e >= min; e--) if (dv.getUint32(e, true) === 0x06054b50) break;
  if (e < min) throw new Error("Archive ZIP invalide (répertoire central introuvable).");
  let count = dv.getUint16(e + 10, true);
  let off = dv.getUint32(e + 16, true);
  if ((count === 0xffff || off === 0xffffffff) && e >= 20 && dv.getUint32(e - 20, true) === 0x07064b50) {
    const z = Number(dv.getBigUint64(e - 20 + 8, true));
    if (dv.getUint32(z, true) === 0x06064b50) {
      count = Number(dv.getBigUint64(z + 32, true));
      off = Number(dv.getBigUint64(z + 48, true));
    }
  }
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count && off + 46 <= b.length; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    let csize = dv.getUint32(off + 20, true);
    let usize = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    let offset = dv.getUint32(off + 42, true);
    const name = dec.decode(b.subarray(off + 46, off + 46 + nameLen));
    if (usize === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
      // Extension ZIP64 : les champs saturés y figurent dans l'ordre taille, taille compressée, décalage.
      let x = off + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = dv.getUint16(x, true);
        const len = dv.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) {
            usize = Number(dv.getBigUint64(q, true));
            q += 8;
          }
          if (csize === 0xffffffff) {
            csize = Number(dv.getBigUint64(q, true));
            q += 8;
          }
          if (offset === 0xffffffff) offset = Number(dv.getBigUint64(q, true));
          break;
        }
        x += 4 + len;
      }
    }
    out.push({ name, method, csize, usize, offset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function entryData(b: Uint8Array, ent: ZipEntry): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(ent.offset, true) !== 0x04034b50) throw new Error(`Entrée ZIP corrompue : ${ent.name}`);
  const start = ent.offset + 30 + dv.getUint16(ent.offset + 26, true) + dv.getUint16(ent.offset + 28, true);
  return b.subarray(start, start + ent.csize);
}

const IN_STEP = 64 * 1024;

/** Décompresse une entrée par blocs ; `onChunk` renvoie false pour s'arrêter net. */
function streamEntry(
  b: Uint8Array,
  ent: ZipEntry,
  onChunk: (chunk: Uint8Array) => boolean,
  onConsumed: (n: number) => void,
): void {
  const data = entryData(b, ent);
  if (ent.method === 0) {
    for (let i = 0; i < data.length; i += 1 << 20) {
      const part = data.subarray(i, i + (1 << 20));
      onConsumed(part.length);
      if (!onChunk(part)) return;
    }
    return;
  }
  if (ent.method !== 8) throw new Error(`Méthode de compression ZIP non prise en charge (${ent.method}).`);
  let stop = false;
  const inf = new Inflate((chunk) => {
    if (!stop && !onChunk(chunk)) stop = true;
  });
  for (let i = 0; i < data.length && !stop; i += IN_STEP) {
    const part = data.subarray(i, i + IN_STEP);
    onConsumed(part.length);
    inf.push(part, i + IN_STEP >= data.length);
  }
}

// ── décodage XML minimal ────────────────────────────────────────────────────

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY_RE, (_m, e: string) => {
    switch (e) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** Valeur d'un attribut dans une balise ouvrante (`<c r="A1" s="3">`). */
function attr(tag: string, name: string): string | undefined {
  let i = tag.indexOf(` ${name}=`);
  if (i < 0) return undefined;
  i += name.length + 2;
  const q = tag[i];
  if (q !== '"' && q !== "'") return undefined;
  const end = tag.indexOf(q, i + 1);
  return end < 0 ? undefined : decodeEntities(tag.slice(i + 1, end));
}

/** Texte d'un `<si>` ou d'un `<is>` : tous les `<t>`, sauf le guide phonétique `<rPh>`. */
function textOfSi(inner: string): string {
  const src = inner.includes("<rPh") ? inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "") : inner;
  let out = "";
  let p = 0;
  for (;;) {
    const i = src.indexOf("<t", p);
    if (i < 0) break;
    const c = src.charCodeAt(i + 2);
    if (c !== 62 && c !== 32 && c !== 47) {
      p = i + 2;
      continue;
    }
    const te = src.indexOf(">", i);
    if (te < 0) break;
    if (src.charCodeAt(te - 1) === 47) {
      p = te + 1;
      continue;
    }
    const end = src.indexOf("</t>", te);
    if (end < 0) break;
    out += src.slice(te + 1, end);
    p = end + 4;
  }
  return decodeOoxmlEscapes(decodeEntities(out));
}

// ── chaînes partagées ───────────────────────────────────────────────────────

function readSharedStrings(bytes: Uint8Array, ent: ZipEntry | undefined, onConsumed: (n: number) => void): string[] {
  const out: string[] = [];
  if (!ent) return out;
  const dec = new TextDecoder();
  let buf = "";
  streamEntry(
    bytes,
    ent,
    (chunk) => {
      buf += dec.decode(chunk, { stream: true });
      let p = 0;
      for (;;) {
        const i = buf.indexOf("<si", p);
        if (i < 0) break;
        const c = buf.charCodeAt(i + 3);
        if (c !== 62 && c !== 32 && c !== 47) {
          p = i + 3;
          continue;
        }
        const te = buf.indexOf(">", i);
        if (te < 0) break;
        if (buf.charCodeAt(te - 1) === 47) {
          out.push("");
          p = te + 1;
          continue;
        }
        const end = buf.indexOf("</si>", te);
        if (end < 0) break;
        out.push(textOfSi(buf.slice(te + 1, end)));
        p = end + 5;
      }
      buf = p ? buf.slice(p) : buf;
      return true;
    },
    onConsumed,
  );
  return out;
}

// ── feuille ─────────────────────────────────────────────────────────────────

const BATCH = 2048;
const MAX_TAIL_CHARS = 16 * 1024 * 1024;

interface SharedMaster {
  formula: string;
  col: number;
  row: number;
}

class SheetReader {
  private buf = "";
  private state: "head" | "rows" | "tail" = "head";
  private seqRow = 0;
  private masters = new Map<number, SharedMaster>();
  private rowHeights: [number, number][] = [];
  private rows: number[] = [];
  private cols: number[] = [];
  private styles: number[] = [];
  private kinds: number[] = [];
  private vals: (string | null)[] = [];
  count = 0;
  truncated = false;
  rootOpen = "<worksheet>";
  head = "";
  tail = "";
  totalRows = 0;
  firstRow = 0;
  lastRow = 0;
  private winStart: number;
  private winEnd: number;
  private keepHeader: boolean;

  constructor(
    private path: string,
    private shared: string[],
    win: SheetWindow,
    private cap: number,
    private emit: (m: CellsMsg) => void,
  ) {
    this.winStart = Math.max(1, Math.floor(win.rowStart ?? 1));
    this.winEnd = win.rowEnd && win.rowEnd >= this.winStart ? Math.floor(win.rowEnd) : Infinity;
    this.keepHeader = !!win.keepHeader && this.winStart > 1;
  }

  /** Renvoie false quand il est inutile de continuer à décompresser. */
  feed(text: string): boolean {
    if (this.state === "tail") {
      if (this.tail.length < MAX_TAIL_CHARS) this.tail += text;
      return true;
    }
    this.buf += text;
    if (this.state === "head") this.pumpHead();
    return this.state === "rows" ? this.pumpRows() : true;
  }

  finish(): void {
    this.flush();
    if (this.state === "head") this.head = this.buf;
  }

  private pumpHead(): boolean {
    const idx = this.buf.indexOf("<sheetData");
    if (idx < 0) return false;
    const te = this.buf.indexOf(">", idx);
    if (te < 0) return false;
    const pre = this.buf.slice(0, idx);
    const m = /<worksheet\b[^>]*>/.exec(pre);
    if (m) {
      this.rootOpen = m[0];
      this.head = pre.slice(m.index + m[0].length);
    } else this.head = pre;
    const dim = /<dimension\s+ref="[^"]*?(\d+)"/.exec(this.head);
    if (dim) this.totalRows = Number(dim[1]);
    const rest = this.buf.slice(te + 1);
    if (this.buf.charCodeAt(te - 1) === 47) {
      this.state = "tail";
      this.tail = rest;
    } else {
      this.state = "rows";
      this.buf = rest;
    }
    return true;
  }

  private stop(): false {
    this.truncated = true;
    this.buf = "";
    return false;
  }

  private pumpRows(): boolean {
    const b = this.buf;
    let p = 0;
    let sharedAt = b.indexOf('t="shared"');
    for (;;) {
      while (p < b.length && b.charCodeAt(p) <= 32) p++;
      if (p >= b.length) break;
      if (b.startsWith("</sheetData", p)) {
        const close = b.indexOf(">", p);
        if (close < 0) break;
        this.state = "tail";
        this.tail = b.slice(close + 1);
        this.buf = "";
        return true;
      }
      if (!b.startsWith("<row", p)) {
        const nx = b.indexOf("<", p + 1);
        if (nx < 0) break;
        p = nx;
        continue;
      }
      const te = b.indexOf(">", p);
      if (te < 0) break;
      const self = b.charCodeAt(te - 1) === 47;
      let bodyEnd = te;
      let next = te + 1;
      if (!self) {
        bodyEnd = b.indexOf("</row>", te + 1);
        if (bodyEnd < 0) break;
        next = bodyEnd + 6;
      }
      const tag = b.slice(p, te);
      const rAttr = attr(tag, "r");
      const rowNum = rAttr ? Number(rAttr) : this.seqRow + 1;
      this.seqRow = rowNum;
      if (rowNum > this.winEnd || this.count >= this.cap) return this.stop();
      const inWin = rowNum >= this.winStart || (this.keepHeader && rowNum === 1);
      if (inWin) {
        if (!self) this.parseRow(b, te + 1, bodyEnd, rowNum, tag, true);
        else this.noteRow(rowNum, tag);
      } else if (!self) {
        if (sharedAt !== -1 && sharedAt < p) sharedAt = b.indexOf('t="shared"', p);
        if (sharedAt !== -1 && sharedAt < bodyEnd) this.parseRow(b, te + 1, bodyEnd, rowNum, tag, false);
      }
      p = next;
    }
    this.buf = b.slice(p);
    return true;
  }

  private outRow(rowNum: number): number {
    if (this.winStart === 1) return rowNum - 1;
    if (this.keepHeader) return rowNum === 1 ? 0 : rowNum - this.winStart + 1;
    return rowNum - this.winStart;
  }

  private noteRow(rowNum: number, tag: string): void {
    if (!(this.keepHeader && rowNum === 1) && !this.firstRow) this.firstRow = rowNum;
    if (rowNum > this.lastRow) this.lastRow = rowNum;
    if (attr(tag, "customHeight") === "1") {
      const ht = Number(attr(tag, "ht"));
      if (Number.isFinite(ht)) this.rowHeights.push([this.outRow(rowNum), ht]);
    }
  }

  private parseRow(b: string, from: number, to: number, rowNum: number, rowTag: string, emit: boolean): void {
    if (emit) this.noteRow(rowNum, rowTag);
    const outRow = this.outRow(rowNum);
    let p = from;
    let col = -1;
    for (;;) {
      const i = b.indexOf("<c", p);
      if (i < 0 || i >= to) break;
      const ch = b.charCodeAt(i + 2);
      if (ch !== 32 && ch !== 62 && ch !== 47) {
        p = i + 2;
        continue;
      }
      const te = b.indexOf(">", i);
      const selfC = b.charCodeAt(te - 1) === 47;
      let inner = "";
      if (selfC) p = te + 1;
      else {
        const ce = b.indexOf("</c>", te);
        inner = b.slice(te + 1, ce);
        p = ce + 4;
      }
      const tag = b.slice(i, te);
      const ref = attr(tag, "r");
      if (ref) {
        let c = 0;
        let k = 0;
        for (; k < ref.length; k++) {
          const code = ref.charCodeAt(k);
          if (code >= 65 && code <= 90) c = c * 26 + code - 64;
          else if (code >= 97 && code <= 122) c = c * 26 + code - 96;
          else break;
        }
        col = c - 1;
      } else col++;
      if (col < 0) continue;
      const sAttr = attr(tag, "s");
      const sIdx = sAttr ? Number(sAttr) || 0 : 0;
      const t = attr(tag, "t");

      let val: string | null = null;
      let numeric = 0;
      const fi = inner.indexOf("<f");
      const fch = fi >= 0 ? inner.charCodeAt(fi + 2) : 0;
      if (fi >= 0 && (fch === 62 || fch === 32 || fch === 47)) {
        const fte = inner.indexOf(">", fi);
        const fSelf = inner.charCodeAt(fte - 1) === 47;
        const ftag = inner.slice(fi, fte);
        const ftext = fSelf ? "" : decodeEntities(inner.slice(fte + 1, inner.indexOf("</f>", fte)));
        const shared = attr(ftag, "t") === "shared";
        const si = shared ? Number(attr(ftag, "si")) : NaN;
        if (ftext) {
          val = "=" + stripXlfnPrefixes(ftext);
          if (shared && Number.isFinite(si) && !this.masters.has(si))
            this.masters.set(si, { formula: ftext, col, row: rowNum - 1 });
        } else if (shared && Number.isFinite(si)) {
          const m = this.masters.get(si);
          if (m) {
            const dCol = col - m.col;
            const dRow = rowNum - 1 - m.row;
            val = "=" + stripXlfnPrefixes(rewriteRefs(m.formula, (c, r) => ({ col: c + dCol, row: r + dRow }), true));
          }
        }
      }
      if (!emit) continue;
      if (val === null) {
        if (t === "inlineStr") {
          const txt = textOfSi(inner);
          if (txt) val = txt;
        } else {
          const vi = inner.indexOf("<v");
          const vch = vi >= 0 ? inner.charCodeAt(vi + 2) : 0;
          if (vi >= 0 && (vch === 62 || vch === 32)) {
            const vte = inner.indexOf(">", vi);
            const ve = inner.indexOf("</v>", vte);
            const raw = ve >= 0 ? inner.slice(vte + 1, ve) : "";
            if (t === "s") val = this.shared[parseInt(raw, 10)] ?? "";
            else if (t === "str") val = decodeOoxmlEscapes(decodeEntities(raw));
            else if (t === "b") val = raw.trim() === "1" ? "TRUE" : "FALSE";
            else if (t === "e") val = decodeEntities(raw).trim();
            else {
              val = decodeEntities(raw);
              numeric = 1;
            }
          }
        }
      }
      if (val === null && !sIdx) continue;
      if (val === "") val = null;
      if (val === null && !sIdx) continue;
      this.rows.push(outRow);
      this.cols.push(col);
      this.styles.push(sIdx);
      this.kinds.push(numeric);
      this.vals.push(val);
      this.count++;
      if (this.rows.length >= BATCH) this.flush();
    }
  }

  private flush(): void {
    if (!this.rows.length) return;
    this.emit({
      type: "cells",
      path: this.path,
      rows: Int32Array.from(this.rows),
      cols: Int32Array.from(this.cols),
      styles: Int32Array.from(this.styles),
      kinds: Uint8Array.from(this.kinds),
      vals: this.vals,
    });
    this.rows = [];
    this.cols = [];
    this.styles = [];
    this.kinds = [];
    this.vals = [];
  }

  result(path: string, originalBytes: number, skipped: boolean): SheetMsg {
    return {
      type: "sheet",
      path,
      rootOpen: this.rootOpen,
      head: this.head,
      tail: this.truncated || skipped ? null : this.tail.replace(/<\/worksheet>\s*$/, ""),
      rowHeights: this.rowHeights,
      cells: this.count,
      truncated: this.truncated,
      skipped,
      totalRows: this.totalRows,
      firstRow: this.firstRow,
      lastRow: this.lastRow,
      originalBytes,
    };
  }
}

// ── point d'entrée ──────────────────────────────────────────────────────────

const SKIP_PART = /^xl\/(calcChain\.xml|externalLinks\/|media\/|embeddings\/|printerSettings\/)/;
const MAX_SMALL_PART = 64 * 1024 * 1024;

export function runStreamImport(bytes: Uint8Array, opts: StreamOptions, emit: (m: StreamMsg) => void): void {
  const dir = readZipDirectory(bytes);
  const sheetEntries = dir.filter((e) => /^xl\/worksheets\/[^/]+\.xml$/.test(e.name));
  const sstEntry = dir.find((e) => /^xl\/sharedstrings\.xml$/i.test(e.name));

  const zip: Record<string, Uint8Array> = {};
  for (const e of dir) {
    if (e.name.endsWith("/") || e === sstEntry || sheetEntries.includes(e) || SKIP_PART.test(e.name)) continue;
    if (e.usize > MAX_SMALL_PART) continue;
    const data = entryData(bytes, e);
    zip[e.name] = e.method === 0 ? data.slice() : inflateSync(data);
  }
  emit({
    type: "meta",
    zip,
    sheetPaths: sheetEntries.map((e) => e.name),
    sheetBytes: Object.fromEntries(sheetEntries.map((e) => [e.name, e.usize])),
  });

  const windows = opts.windows ?? {};
  const todo = sheetEntries.filter((e) => !windows[e.name]?.skip);
  const totalIn = (sstEntry?.csize ?? 0) + todo.reduce((n, e) => n + e.csize, 0) || 1;
  let doneIn = 0;
  let lastTick = 0;
  const tick = (label: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < 120) return;
    lastTick = now;
    emit({ type: "progress", fraction: Math.min(1, doneIn / totalIn), label });
  };

  const shared = readSharedStrings(bytes, sstEntry, (n) => {
    doneIn += n;
    tick("Lecture des textes…");
  });
  if (sstEntry) tick("Lecture des textes…", true);

  let remaining = opts.maxCellsTotal ?? DEFAULT_MAX_CELLS_TOTAL;
  const perSheet = opts.maxCellsPerSheet ?? DEFAULT_MAX_CELLS_PER_SHEET;
  for (const ent of sheetEntries) {
    const win = windows[ent.name] ?? {};
    if (win.skip) {
      const reader = new SheetReader(ent.name, shared, win, 0, () => {});
      emit(reader.result(ent.name, ent.usize, true));
      continue;
    }
    const cap = Math.min(perSheet, Math.max(50_000, remaining));
    const reader = new SheetReader(ent.name, shared, win, cap, emit);
    const dec = new TextDecoder();
    let first = true;
    streamEntry(
      bytes,
      ent,
      (chunk) => {
        let text = dec.decode(chunk, { stream: true });
        if (first) {
          first = false;
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        }
        return reader.feed(text);
      },
      (n) => {
        doneIn += n;
        tick("Lecture des feuilles…");
      },
    );
    reader.finish();
    doneIn = Math.min(totalIn, doneIn); // une lecture interrompue laisse du compressé non consommé : sans importance
    remaining -= reader.count;
    emit(reader.result(ent.name, ent.usize, false));
    tick("Lecture des feuilles…", true);
  }
}
