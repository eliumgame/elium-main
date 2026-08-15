/**
 * Mail merge (publipostage) — pure.
 *
 * A data source is a list of records (column name → value); the document carries
 * `mergeField` placeholders. This module owns:
 *   - parsing a delimited data source (CSV / TSV / semicolon, quoted fields,
 *     embedded newlines, BOM, CRLF) — no dependency, works in Node and browser;
 *   - substituting fields into a document (`applyMerge`);
 *   - producing the merged output for a whole list of records (`mergeAll`),
 *     either one document per record or a single document separated by page
 *     breaks;
 *   - the recipient filter, so a run can be limited to selected records.
 *
 * `{Champ}` typed in plain text is honoured too, so a document imported from
 * elsewhere merges without having to re-insert every placeholder by hand.
 */

import type { ProseMirrorNode } from "../format/types";

export interface MergeData {
  fields: string[];
  records: Record<string, string>[];
}

/** Guess the delimiter from the header line: the most frequent candidate. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const c of candidates) {
    // Count only outside quotes, so "Nom, Prénom" does not skew the vote.
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === c) count++;
    }
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

/** Split delimited text into rows of cells (RFC 4180 quoting). */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const delim = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\r") {
      // swallow: handled by the \n that follows (or by the final flush)
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);

  // Drop trailing blank rows (a file usually ends with a newline).
  while (rows.length && rows[rows.length - 1]!.every((c) => c.trim() === "")) rows.pop();
  return rows;
}

/**
 * Parse a delimited data source: the first row is the header. Blank and
 * duplicate column names are repaired so every field is addressable.
 */
export function parseDataSource(text: string, delimiter?: string): MergeData {
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) return { fields: [], records: [] };

  const seen = new Map<string, number>();
  const fields = rows[0]!.map((raw, i) => {
    const base = raw.replace(/\s+/g, " ").trim() || `Colonne ${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base} (${n + 1})`;
  });

  const records = rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    fields.forEach((field, i) => {
      record[field] = (cells[i] ?? "").trim();
    });
    return record;
  });

  return { fields, records };
}

/** A short, human label for a record (first non-empty cell, then the rest). */
export function recordLabel(record: Record<string, string>, fields: string[]): string {
  const parts = fields.map((f) => record[f]).filter((v): v is string => !!v && v.trim() !== "");
  return parts.slice(0, 3).join(" · ") || "(enregistrement vide)";
}

/** Fields actually used by the document (merge-field nodes + `{Champ}` text). */
export function usedFields(doc: ProseMirrorNode): string[] {
  const out = new Set<string>();
  const walk = (node: ProseMirrorNode) => {
    if (node.type === "mergeField") {
      const field = String(node.attrs?.field ?? "").trim();
      if (field) out.add(field);
    }
    if (node.type === "text" && node.text) {
      for (const m of node.text.matchAll(/\{([^{}\n]{1,80})\}/g)) {
        const name = m[1]!.trim();
        // `{titre}` / `{date}` belong to the header/footer token syntax.
        if (name && !/^(titre|date)$/i.test(name)) out.add(name);
      }
    }
    (node.content ?? []).forEach(walk);
  };
  walk(doc);
  return [...out];
}

/** Fields the document asks for but the data source does not provide. */
export function missingFields(doc: ProseMirrorNode, data: MergeData): string[] {
  const available = new Set(data.fields.map((f) => f.toLowerCase()));
  return usedFields(doc).filter((f) => !available.has(f.toLowerCase()));
}

/** Case-insensitive record lookup, so «nom» matches a "Nom" column. */
function valueOf(record: Record<string, string>, field: string): string | null {
  if (Object.prototype.hasOwnProperty.call(record, field)) return record[field] ?? "";
  const lower = field.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lower) return record[key] ?? "";
  }
  return null;
}

export interface MergeOptions {
  /** Text substituted for a field the data source has no column for. */
  fallback?: string;
  /** Also expand `{Champ}` written as plain text (default true). */
  expandTextTokens?: boolean;
}

/**
 * Substitute every merge field with this record's values. Merge-field NODES
 * become plain text carrying the node's own marks, so the merged document has no
 * placeholders left.
 */
export function applyMerge(
  doc: ProseMirrorNode,
  record: Record<string, string>,
  opts: MergeOptions = {},
): ProseMirrorNode {
  const fallback = opts.fallback ?? "";
  const expandText = opts.expandTextTokens !== false;

  const mapNode = (node: ProseMirrorNode): ProseMirrorNode[] => {
    if (node.type === "mergeField") {
      const field = String(node.attrs?.field ?? "").trim();
      const value = valueOf(record, field);
      const text = value == null ? fallback : value;
      if (!text) return [];
      return [node.marks?.length ? { type: "text", text, marks: node.marks } : { type: "text", text }];
    }
    if (node.type === "text" && node.text != null && expandText) {
      const text = node.text.replace(/\{([^{}\n]{1,80})\}/g, (whole, name: string) => {
        const field = name.trim();
        if (/^(titre|date)$/i.test(field)) return whole;
        const value = valueOf(record, field);
        return value == null ? whole : value;
      });
      if (!text) return [];
      return [{ ...node, text }];
    }
    if (node.content) {
      const content = node.content.flatMap(mapNode);
      return [{ ...node, content }];
    }
    return [{ ...node }];
  };

  const merged = mapNode(doc)[0] ?? { type: "doc", content: [{ type: "paragraph" }] };
  // A block must never end up empty of required content.
  if (merged.content && merged.content.length === 0) merged.content = [{ type: "paragraph" }];
  return merged;
}

export interface MergeAllOptions extends MergeOptions {
  /** Indices (into `data.records`) to include; omitted = every record. */
  selected?: number[];
}

/** One merged document per selected record. */
export function mergeAll(doc: ProseMirrorNode, data: MergeData, opts: MergeAllOptions = {}): ProseMirrorNode[] {
  const indices = opts.selected ?? data.records.map((_, i) => i);
  return indices.filter((i) => i >= 0 && i < data.records.length).map((i) => applyMerge(doc, data.records[i]!, opts));
}

/**
 * All selected records merged into ONE document, each starting on a new page —
 * the usual "print the whole run" output.
 */
export function mergeCombined(doc: ProseMirrorNode, data: MergeData, opts: MergeAllOptions = {}): ProseMirrorNode {
  const docs = mergeAll(doc, data, opts);
  const content: ProseMirrorNode[] = [];
  docs.forEach((merged, i) => {
    if (i > 0) content.push({ type: "pageBreak" });
    content.push(...(merged.content ?? []));
  });
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}
