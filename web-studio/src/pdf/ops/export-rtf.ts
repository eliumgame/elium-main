/**
 * RTF 1.9 writer for « Exporter un PDF → RTF » (see export-office.ts).
 *
 * Small on purpose: named heading styles (so Word's navigation pane and outline
 * see them), paragraphs with alignment and indents, inline bold / italic /
 * font / size, hyperlinks as HYPERLINK fields, lists as hanging-indent
 * paragraphs keeping their printed markers, tables as `\trowd` rows, pictures as
 * `\pngblip` / `\jpegblip`, and the page size of the PDF. Output is pure ASCII:
 * everything else is written as `\uN?` escapes (UTF-16 code units).
 */

import type { OfficeDocument, OfficeImage, OfficeItem, OfficeRun, OfficeTable } from "./export-office-model";
import { textMargins } from "./export-office-model";

const twips = (pt: number) => Math.round(pt * 20);

/** Escape text for RTF: control characters of the format, then non-ASCII as `\uN?`. */
export function rtfEscape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i); // UTF-16 code unit: astral characters come out as their surrogate pair
    if (ch === "\\" || ch === "{" || ch === "}") out += `\\${ch}`;
    else if (ch === "\t") out += "\\tab ";
    else if (ch === "\n") out += "\\line ";
    else if (c < 0x20) continue;
    else if (c < 0x80) out += ch;
    else out += `\\u${c > 32767 ? c - 65536 : c}?`;
  }
  return out;
}

const FAMILY_CLASS = (name: string) =>
  /times|georgia|garamond|cambria|serif/i.test(name) && !/sans/i.test(name)
    ? "froman"
    : /courier|mono|consol/i.test(name)
      ? "fmodern"
      : "fswiss";

const ALIGN: Record<string, string> = { left: "\\ql", center: "\\qc", right: "\\qr", justify: "\\qj" };

/** Pixel size of a PNG or JPEG, for `\picw` / `\pich`. */
function pictureSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
      }
      i += 2 + len;
    }
  }
  return null;
}

const hex = (bytes: Uint8Array) => {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 64) {
    parts.push(Array.from(bytes.subarray(i, i + 64), (b) => b.toString(16).padStart(2, "0")).join(""));
  }
  return parts.join("\n");
};

/** Serialise the office model to an RTF document (ASCII string). */
export function officeToRtf(
  model: OfficeDocument,
  images: ReadonlyMap<OfficeImage, Uint8Array> = new Map(),
  title = "",
): string {
  const first = model.pages[0];
  const pageW = first?.w ?? 595;
  const pageH = first?.h ?? 842;
  const margins = first ? textMargins(first) : { top: 56.7, right: 56.7, bottom: 56.7, left: 56.7 };
  const contentW = pageW - margins.left - margins.right;

  // Font table: Arial first (the default), then every family the runs use.
  const fonts = ["Arial"];
  const fontIndex = (name: string | undefined) => {
    const n = name || "Arial";
    let i = fonts.indexOf(n);
    if (i < 0) i = fonts.push(n) - 1;
    return i;
  };
  const body = Math.round(model.bodySize * 2);

  const runXml = (r: OfficeRun) => {
    const fmt =
      `${r.bold ? "\\b" : ""}${r.italic ? "\\i" : ""}\\f${fontIndex(r.fontFamily)}\\fs${Math.round(r.fontSize * 2)}` +
      " ";
    const text = rtfEscape(r.text);
    if (!r.href) return `{${fmt}${text}}`;
    const url = r.href.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/"/g, "%22");
    return `{\\field{\\*\\fldinst{HYPERLINK "${rtfEscape(url)}"}}{\\fldrslt{${fmt}\\ul\\cf1 ${text}}}}`;
  };
  const runsXml = (runs: readonly OfficeRun[]) => runs.map(runXml).join("");

  const out: string[] = [];
  let pendingBreak = false;
  const pagebb = () => {
    const s = pendingBreak ? "\\pagebb" : "";
    pendingBreak = false;
    return s;
  };

  const tableXml = (t: OfficeTable) => {
    const cols = Math.max(1, ...t.rows.map((r) => r.length));
    // Column widths from the PDF's own column edges, scaled into the text width.
    const edges = [...t.columns.slice(0, cols)];
    while (edges.length < cols) edges.push(t.rect.x + (t.rect.w * edges.length) / cols);
    const widths = edges.map((e, i) => Math.max(18, (i + 1 < edges.length ? edges[i + 1] : t.rect.x + t.rect.w) - e));
    const total = widths.reduce((a, b) => a + b, 0);
    const scale = total > contentW ? contentW / total : Math.max(1, Math.min(contentW / total, 1.15));
    let x = 0;
    const cellx = widths.map((w) => (x += twips(w * scale)));
    const border =
      "\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10";
    const rows = t.rows.map((row) => {
      const def = `\\trowd\\trgaph108\\trleft0${cellx.map((c) => `${border}\\cellx${c}`).join("")}`;
      const cells = Array.from({ length: cols }, (_, i) => {
        const c = row[i] ?? { text: "", bold: false };
        return `\\pard\\intbl\\plain\\f0\\fs${Math.round(t.fontSize * 2)}${c.bold ? "\\b" : ""} ${rtfEscape(c.text)}\\cell`;
      }).join("");
      return `${def}\n${cells}\\row`;
    });
    return rows.join("\n");
  };

  const itemXml = (item: OfficeItem): string => {
    switch (item.kind) {
      case "heading":
        return (
          `\\pard\\plain\\s${item.level}\\outlinelevel${item.level - 1}\\keepn\\sb240\\sa120${pagebb()}` +
          `${ALIGN[item.align] ?? "\\ql"} ${runsXml(item.runs)}\\par`
        );
      case "paragraph": {
        const li = twips(Math.min(item.indent, contentW / 2));
        const fi = twips(item.firstLine);
        return (
          `\\pard\\plain\\sa120${pagebb()}${ALIGN[item.align] ?? "\\ql"}` +
          `${li > 120 ? `\\li${li}` : ""}${fi ? `\\fi${fi}` : ""} ${runsXml(item.runs)}\\par`
        );
      }
      case "list":
        return item.items
          .map(
            (it, i) =>
              `\\pard\\plain\\li720\\fi-360\\tx720\\sa60${i === 0 ? pagebb() : ""} ` +
              `{\\f0\\fs${Math.round(item.fontSize * 2)} ${rtfEscape(it.marker)}}\\tab ${runsXml(it.runs)}\\par`,
          )
          .join("\n");
      case "table": {
        const lead = pendingBreak ? `\\pard\\plain${pagebb()}\\fs2\\par\n` : "";
        return lead + tableXml(item);
      }
      case "image": {
        const bytes = images.get(item);
        if (!bytes) return "";
        const size = pictureSize(bytes);
        const kind = bytes[0] === 0xff ? "\\jpegblip" : "\\pngblip";
        let gw = item.rect.w;
        let gh = item.rect.h;
        if (gw > contentW) {
          gh = (gh * contentW) / gw;
          gw = contentW;
        }
        const picw = size?.w ?? Math.round(gw);
        const pich = size?.h ?? Math.round(gh);
        return (
          `\\pard\\plain\\qc\\sa120${pagebb()} {\\pict${kind}\\picw${picw}\\pich${pich}` +
          `\\picwgoal${twips(gw)}\\pichgoal${twips(gh)}\n${hex(bytes)}}\\par`
        );
      }
    }
  };

  model.pages.forEach((page, i) => {
    if (i > 0) pendingBreak = true;
    for (const item of page.items) {
      const xml = itemXml(item);
      if (xml) out.push(xml);
    }
  });
  out.push("\\pard\\plain\\par");

  const fontTable = fonts.map((f, i) => `{\\f${i}\\${FAMILY_CLASS(f)}\\fcharset0 ${rtfEscape(f)};}`).join("");
  const headingStyle = (level: number, size: number) =>
    `{\\s${level}\\ql\\sb240\\sa120\\keepn\\outlinelevel${level - 1}\\b\\f0\\fs${size}\\sbasedon0\\snext0 heading ${level};}`;
  const landscape = pageW > pageH ? "\\landscape" : "";
  const header =
    `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1\n` +
    `{\\fonttbl${fontTable}}\n` +
    `{\\colortbl;\\red5\\green99\\blue193;}\n` +
    `{\\stylesheet{\\ql\\f0\\fs${body}\\snext0 Normal;}` +
    `${headingStyle(1, Math.round(body * 1.8))}${headingStyle(2, Math.round(body * 1.45))}${headingStyle(3, Math.round(body * 1.2))}}\n` +
    `{\\*\\generator Elium;}{\\info{\\title ${rtfEscape(title)}}}\n` +
    `\\paperw${twips(pageW)}\\paperh${twips(pageH)}\\margl${twips(margins.left)}\\margr${twips(margins.right)}` +
    `\\margt${twips(margins.top)}\\margb${twips(margins.bottom)}${landscape}\n` +
    `\\sectd\\pgwsxn${twips(pageW)}\\pghsxn${twips(pageH)}${landscape ? "\\lndscpsxn" : ""}\n`;
  return `${header}${out.join("\n")}\n}`;
}
