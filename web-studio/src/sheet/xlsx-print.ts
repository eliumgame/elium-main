/**
 * Mise en page d'impression ⇄ OOXML : `<sheetPr><pageSetUpPr fitToPage>`, `<printOptions>`,
 * `<pageMargins>`, `<pageSetup>`, `<headerFooter>`, `<rowBreaks>`/`<colBreaks>`, et les noms
 * définis `_xlnm.Print_Area` / `_xlnm.Print_Titles`. Écriture (chaînes) et lecture (Document).
 */
import { indexToCol, parseRef } from "./formula";
import { PAPER_XLSX, normalizePrint, type PaperName, type PrintSetup } from "./print";

const xe = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inch = (mm: number): string => (Math.round((mm / 25.4) * 1000) / 1000).toString();

/** `{page}` → `&P`, etc. ; le « & » littéral est doublé. */
export function hfToExcel(t: string): string {
  return t
    .replace(/&/g, "&&")
    .replace(/\{page\}/gi, "&P")
    .replace(/\{pages\}/gi, "&N")
    .replace(/\{feuille\}/gi, "&A")
    .replace(/\{date\}/gi, "&D");
}
export function hfFromExcel(t: string): string {
  // On ne garde que la section centrale (&C) ou, à défaut, tout le texte sans codes de section.
  const center = /&C([^&]*(?:&&[^&]*|&[PNAD][^&]*)*)/.exec(t)?.[1];
  const body = (center ?? t.replace(/&[LR][^&]*(?:&&[^&]*|&[PNAD][^&]*)*/g, "")).replace(/&C/g, "");
  return body
    .replace(/&&/g, "\u0000")
    .replace(/&P/g, "{page}")
    .replace(/&N/g, "{pages}")
    .replace(/&A/g, "{feuille}")
    .replace(/&D/g, "{date}")
    .replace(/&[A-Z]|&\d+|&"[^"]*"/g, "")
    .replace(/\u0000/g, "&")
    .trim();
}

export function sheetPrXml(p: PrintSetup | undefined): string {
  return p?.fitWidth ? `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` : "";
}

/** Éléments à insérer après dataValidations et avant drawing. */
export function printXml(p: PrintSetup | undefined): string {
  if (!p) return "";
  const m = p.margins;
  let out = "";
  if (p.gridlines || p.headings)
    out += `<printOptions${p.headings ? ' headings="1"' : ""}${p.gridlines ? ' gridLines="1"' : ""}/>`;
  out += `<pageMargins left="${inch(m.left)}" right="${inch(m.right)}" top="${inch(m.top)}" bottom="${inch(m.bottom)}" header="0.3" footer="0.3"/>`;
  out += `<pageSetup paperSize="${PAPER_XLSX[p.paper]}" orientation="${p.orientation}"${
    p.fitWidth ? ' fitToWidth="1" fitToHeight="0"' : p.scale !== 100 ? ` scale="${p.scale}"` : ""
  }${p.order === "over" ? ' pageOrder="overThenDown"' : ""}/>`;
  if (p.header || p.footer)
    out += `<headerFooter>${p.header ? `<oddHeader>&amp;C${xe(hfToExcel(p.header))}</oddHeader>` : ""}${p.footer ? `<oddFooter>&amp;C${xe(hfToExcel(p.footer))}</oddFooter>` : ""}</headerFooter>`;
  const rb = p.rowBreaks ?? [];
  if (rb.length)
    out += `<rowBreaks count="${rb.length}" manualBreakCount="${rb.length}">${rb.map((r) => `<brk id="${r + 1}" max="16383" man="1"/>`).join("")}</rowBreaks>`;
  const cb = p.colBreaks ?? [];
  if (cb.length)
    out += `<colBreaks count="${cb.length}" manualBreakCount="${cb.length}">${cb.map((c) => `<brk id="${c + 1}" max="1048575" man="1"/>`).join("")}</colBreaks>`;
  return out;
}

const q = (name: string): string => `'${name.replace(/'/g, "''")}'`;

/** Noms définis d'impression d'une feuille (index 0-based pour localSheetId). */
export function printDefinedNames(sheetIndex: number, sheetName: string, p: PrintSetup | undefined): string {
  if (!p) return "";
  let out = "";
  if (p.area) {
    const a = p.area;
    out += `<definedName name="_xlnm.Print_Area" localSheetId="${sheetIndex}">${xe(`${q(sheetName)}!$${indexToCol(a.c0)}$${a.r0 + 1}:$${indexToCol(a.c1)}$${a.r1 + 1}`)}</definedName>`;
  }
  const parts: string[] = [];
  if (p.repeatCols) parts.push(`${q(sheetName)}!$${indexToCol(p.repeatCols.c0)}:$${indexToCol(p.repeatCols.c1)}`);
  if (p.repeatRows) parts.push(`${q(sheetName)}!$${p.repeatRows.r0 + 1}:$${p.repeatRows.r1 + 1}`);
  if (parts.length)
    out += `<definedName name="_xlnm.Print_Titles" localSheetId="${sheetIndex}">${xe(parts.join(","))}</definedName>`;
  return out;
}

// ---- lecture -----------------------------------------------------------------

const PAPER_FROM: Record<number, PaperName> = Object.fromEntries(
  Object.entries(PAPER_XLSX).map(([k, v]) => [v, k as PaperName]),
);

/** Lit les éléments d'impression d'une feuille (null si la feuille n'en porte aucun). */
export function readPrintElements(doc: Document): Partial<PrintSetup> | null {
  const one = (t: string) => doc.getElementsByTagName(t)[0];
  const ps = one("pageSetup");
  const pm = one("pageMargins");
  const po = one("printOptions");
  const hf = one("headerFooter");
  const rb = Array.from(doc.getElementsByTagName("rowBreaks")[0]?.getElementsByTagName("brk") ?? []);
  const cb = Array.from(doc.getElementsByTagName("colBreaks")[0]?.getElementsByTagName("brk") ?? []);
  const fit = one("pageSetUpPr")?.getAttribute("fitToPage") === "1";
  if (!ps && !pm && !po && !hf && !rb.length && !cb.length && !fit) return null;
  const mm = (v: string | null | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) * 25.4 : d);
  const out: Partial<PrintSetup> = {};
  if (ps) {
    const code = Number(ps.getAttribute("paperSize"));
    if (PAPER_FROM[code]) out.paper = PAPER_FROM[code];
    out.orientation = ps.getAttribute("orientation") === "landscape" ? "landscape" : "portrait";
    const sc = Number(ps.getAttribute("scale"));
    if (Number.isFinite(sc) && sc > 0) out.scale = sc;
    if (ps.getAttribute("pageOrder") === "overThenDown") out.order = "over";
  }
  if (fit) out.fitWidth = true;
  if (pm)
    out.margins = {
      top: mm(pm.getAttribute("top"), 15),
      right: mm(pm.getAttribute("right"), 12),
      bottom: mm(pm.getAttribute("bottom"), 15),
      left: mm(pm.getAttribute("left"), 12),
    };
  if (po) {
    out.gridlines = po.getAttribute("gridLines") === "1";
    out.headings = po.getAttribute("headings") === "1";
  }
  const hdr = one("oddHeader")?.textContent;
  const ftr = one("oddFooter")?.textContent;
  if (hdr) out.header = hfFromExcel(hdr);
  if (ftr) out.footer = hfFromExcel(ftr);
  const ids = (list: Element[]) =>
    list.map((b) => Number(b.getAttribute("id")) - 1).filter((n) => Number.isInteger(n) && n >= 0);
  if (rb.length) out.rowBreaks = ids(rb);
  if (cb.length) out.colBreaks = ids(cb);
  return out;
}

/** `_xlnm.Print_Area` / `_xlnm.Print_Titles` d'une feuille → champs d'impression. */
export function readPrintNames(text: string, kind: "area" | "titles"): Partial<PrintSetup> {
  const parts = text.split(",").map((s) => s.slice(s.lastIndexOf("!") + 1).replace(/\$/g, ""));
  if (kind === "area") {
    const [a, b] = (parts[0] ?? "").split(":");
    const pa = a ? parseRef(a) : null;
    const pb = b ? parseRef(b) : pa;
    return pa && pb
      ? {
          area: {
            c0: Math.min(pa.col, pb.col),
            r0: Math.min(pa.row, pb.row),
            c1: Math.max(pa.col, pb.col),
            r1: Math.max(pa.row, pb.row),
          },
        }
      : {};
  }
  const out: Partial<PrintSetup> = {};
  for (const p of parts) {
    const rows = /^(\d+):(\d+)$/.exec(p);
    const cols = /^([A-Z]+):([A-Z]+)$/.exec(p);
    if (rows) out.repeatRows = { r0: Number(rows[1]) - 1, r1: Number(rows[2]) - 1 };
    if (cols) {
      const c0 = parseRef(`${cols[1]}1`)?.col;
      const c1 = parseRef(`${cols[2]}1`)?.col;
      if (c0 !== undefined && c1 !== undefined) out.repeatCols = { c0, c1 };
    }
  }
  return out;
}

/** Fusionne en une configuration normalisée (undefined si rien). */
export function mergePrint(a: Partial<PrintSetup> | null, b: Partial<PrintSetup>): PrintSetup | undefined {
  const m = { ...(a ?? {}), ...b };
  return Object.keys(m).length ? normalizePrint(m) : undefined;
}
