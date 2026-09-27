/**
 * Acrobat's form JavaScript for the Format / Validate / Calculate tabs, both
 * ways: the AF* calls Acrobat writes for a choice made in its Properties
 * dialog, and that choice read back from a field's scripts (so the dialog of
 * a field made in Acrobat opens on the right settings). Anything that is not
 * one of those calls stays « custom », script kept as is.
 */

import type { FieldCalculation, FieldFormat, FieldProps } from "../../model/types";

const js = JSON.stringify;

/** Keystroke and format scripts of a Format choice (null: none). */
export function formatScripts(f: FieldFormat | undefined): { K: string; F: string } | null {
  if (!f || f.kind === "none") return null;
  switch (f.kind) {
    case "number": {
      const args = `${f.decimals}, ${f.sepStyle}, ${f.negStyle}, 0, ${js(f.currency)}, ${f.currencyPrepend}`;
      return { K: `AFNumber_Keystroke(${args});`, F: `AFNumber_Format(${args});` };
    }
    case "percent":
      return {
        K: `AFPercent_Keystroke(${f.decimals}, ${f.sepStyle});`,
        F: `AFPercent_Format(${f.decimals}, ${f.sepStyle});`,
      };
    case "date":
      return { K: `AFDate_KeystrokeEx(${js(f.pattern)});`, F: `AFDate_FormatEx(${js(f.pattern)});` };
    case "time":
      return { K: `AFTime_Keystroke(${f.style});`, F: `AFTime_Format(${f.style});` };
    case "custom":
      return { K: f.keystroke ?? "", F: f.format ?? "" };
  }
}

export function validateScript(v: FieldProps["validate"]): string | null {
  if (!v || (v.min == null && v.max == null)) return null;
  return `AFRange_Validate(${v.min != null}, ${v.min ?? 0}, ${v.max != null}, ${v.max ?? 0});`;
}

export function calculateScript(c: FieldProps["calculate"]): string | null {
  if (!c) return null;
  if (c.kind === "custom") return c.script;
  return `AFSimple_Calculate(${js(c.op)}, new Array(${c.fields.map((n) => js(n)).join(", ")}));`;
}

// ---------------------------------------------------------------------------
// Reading scripts back
// ---------------------------------------------------------------------------

type Arg = number | boolean | string | Arg[];

/** Arguments of a single call `Name(a, b, "c", new Array("d"))`, or null. */
export function parseCall(code: string): { name: string; args: Arg[] } | null {
  const m = /^\s*([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(code);
  if (!m) return null;
  const src = m[2];
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const value = (): Arg => {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") {
      let out = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") {
          const e = src[++i];
          if (e === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 1, i + 5))) {
            out += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16));
            i += 4;
          } else if (e === "x" && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 1, i + 3))) {
            out += String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16));
            i += 2;
          } else if (/[0-7]/.test(e)) {
            const oct = /^[0-7]{1,3}/.exec(src.slice(i))![0];
            out += String.fromCharCode(parseInt(oct, 8));
            i += oct.length - 1;
          } else {
            out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "b" ? "\b" : e === "f" ? "\f" : e;
          }
        } else out += src[i];
        i++;
      }
      if (src[i] !== c) throw new Error("chaîne non fermée");
      i++;
      return out;
    }
    if (src.startsWith("new Array", i) || src[i] === "[") {
      const close = src[i] === "[" ? "]" : ")";
      i = src[i] === "[" ? i + 1 : src.indexOf("(", i) + 1;
      const items: Arg[] = [];
      ws();
      if (src[i] === close) {
        i++;
        return items;
      }
      for (;;) {
        items.push(value());
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === close) {
          i++;
          return items;
        }
        throw new Error("tableau mal formé");
      }
    }
    const word = /^(true|false|-?\d*\.?\d+(?:e-?\d+)?)/i.exec(src.slice(i));
    if (!word) throw new Error("argument inconnu");
    i += word[0].length;
    if (word[0] === "true" || word[0] === "false") return word[0] === "true";
    return Number(word[0]);
  };
  try {
    const args: Arg[] = [];
    ws();
    if (i < src.length) {
      for (;;) {
        args.push(value());
        ws();
        if (i >= src.length) break;
        if (src[i] !== ",") return null;
        i++;
      }
    }
    return { name: m[1], args };
  } catch {
    return null;
  }
}

const num = (a: Arg | undefined, d = 0) => (typeof a === "number" ? a : d);
const clampStyle = <T extends number>(n: number, max: number) => Math.max(0, Math.min(max, Math.trunc(n))) as T;

/** Acrobat's legacy AFDate_Format(n) indices. */
const DATE_FORMATS = [
  "m/d",
  "m/d/yy",
  "mm/dd/yy",
  "mm/yy",
  "d-mmm",
  "d-mmm-yy",
  "dd-mmm-yy",
  "yy-mm-dd",
  "mmm-yy",
  "mmmm-yy",
  "mmm d, yyyy",
  "mmmm d, yyyy",
  "m/d/yy h:MM tt",
  "m/d/yy HH:MM",
];

/** The Format choice behind a field's keystroke / format scripts. */
export function parseFormat(keystroke: string | undefined, format: string | undefined): FieldFormat {
  if (!keystroke && !format) return { kind: "none" };
  const call = parseCall(format ?? keystroke ?? "");
  if (call) {
    const a = call.args;
    switch (call.name) {
      case "AFNumber_Format":
      case "AFNumber_Keystroke":
        return {
          kind: "number",
          decimals: num(a[0]),
          sepStyle: clampStyle(num(a[1]), 4),
          negStyle: clampStyle(num(a[2]), 3),
          currency: typeof a[4] === "string" ? a[4] : "",
          currencyPrepend: a[5] === true,
        };
      case "AFPercent_Format":
      case "AFPercent_Keystroke":
        return { kind: "percent", decimals: num(a[0]), sepStyle: clampStyle(num(a[1]), 4) };
      case "AFDate_FormatEx":
      case "AFDate_KeystrokeEx":
        if (typeof a[0] === "string") return { kind: "date", pattern: a[0] };
        break;
      case "AFDate_Format":
      case "AFDate_Keystroke":
        return { kind: "date", pattern: DATE_FORMATS[num(a[0])] ?? "mm/dd/yy" };
      case "AFTime_Format":
      case "AFTime_Keystroke":
        return { kind: "time", style: clampStyle(num(a[0]), 3) };
    }
  }
  return { kind: "custom", keystroke, format };
}

/** The range check of a validate script (undefined: none or not a range check). */
export function parseValidate(script: string | undefined): FieldProps["validate"] | undefined {
  const call = script ? parseCall(script) : null;
  if (!call || call.name !== "AFRange_Validate") return undefined;
  const [bMin, nMin, bMax, nMax] = call.args;
  return { ...(bMin === true ? { min: num(nMin) } : {}), ...(bMax === true ? { max: num(nMax) } : {}) };
}

export function parseCalculate(script: string | undefined): FieldCalculation | null {
  if (!script) return null;
  const call = parseCall(script);
  if (call?.name === "AFSimple_Calculate") {
    const [op, list] = call.args;
    const ops = ["SUM", "PRD", "AVG", "MIN", "MAX"] as const;
    const o = ops.find((x) => x === String(op).toUpperCase());
    // The field list: an array, or one string « a, b » (both are Acrobat's).
    const fields = Array.isArray(list)
      ? list.map(String)
      : typeof list === "string"
        ? list
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
    if (o && fields) return { kind: "simple", op: o, fields };
  }
  return { kind: "custom", script };
}

/** pdf.js' field `actions` (event → scripts) → the three tabs. */
export function parseFieldScripts(actions: Record<string, string[]> | null | undefined): {
  format: FieldFormat;
  validate: FieldProps["validate"] | undefined;
  calculate: FieldCalculation | null;
} {
  const first = (k: string) => actions?.[k]?.join("\n") || undefined;
  return {
    format: parseFormat(first("Keystroke"), first("Format")),
    validate: parseValidate(first("Validate")),
    calculate: parseCalculate(first("Calculate")),
  };
}
