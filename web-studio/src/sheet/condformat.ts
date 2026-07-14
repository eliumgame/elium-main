/**
 * Conditional formatting — pure logic (no React). Rules compare a cell's value
 * or text against thresholds and apply a fill / text colour / bold, or paint a
 * colour scale across a range. Kept dependency-free and unit-tested.
 */
import { isError, type CellValue } from "./formula";
import type { CondRule } from "./model";

export interface CondStyle { background?: string; color?: string; fontWeight?: number; }

/** Coerce a cell value to a number, or null when it isn't numeric. */
export function toNum(v: CellValue): number | null {
  if (isError(v)) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/** Colour for `value` on a 2- or 3-stop scale, clamped to [min, max]. */
export function colorScaleFill(scale: { min: string; max: string; mid?: string }, value: number, min: number, max: number): string {
  if (max <= min) return scale.mid ?? scale.min;
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  if (scale.mid) return t < 0.5 ? mix(scale.min, scale.mid, t / 0.5) : mix(scale.mid, scale.max, (t - 0.5) / 0.5);
  return mix(scale.min, scale.max, t);
}

export function inRule(rule: CondRule, c: number, r: number): boolean {
  return c >= rule.c0 && c <= rule.c1 && r >= rule.r0 && r <= rule.r1;
}

/** Does a non-scale rule match the given cell value / displayed text? */
export function ruleMatches(rule: CondRule, value: CellValue, text: string): boolean {
  const n = toNum(value);
  const t1 = rule.v1 ?? "";
  const n1 = Number(t1);
  const numeric = n !== null && t1.trim() !== "" && !Number.isNaN(n1);
  switch (rule.op) {
    case "gt": return numeric && n! > n1;
    case "lt": return numeric && n! < n1;
    case "ge": return numeric && n! >= n1;
    case "le": return numeric && n! <= n1;
    case "eq": return numeric ? n! === n1 : text === t1;
    case "ne": return numeric ? n! !== n1 : text !== t1;
    case "between": {
      const n2 = Number(rule.v2 ?? "");
      return n !== null && !Number.isNaN(n1) && !Number.isNaN(n2) && n! >= Math.min(n1, n2) && n! <= Math.max(n1, n2);
    }
    case "contains": return t1 !== "" && text.toLowerCase().includes(t1.toLowerCase());
    case "empty": return text.trim() === "";
    case "notEmpty": return text.trim() !== "";
    default: return false;
  }
}

export const COND_OPS: { value: CondRule["op"]; label: string; needs: 0 | 1 | 2 }[] = [
  { value: "gt", label: "Supérieur à", needs: 1 },
  { value: "lt", label: "Inférieur à", needs: 1 },
  { value: "ge", label: "Supérieur ou égal à", needs: 1 },
  { value: "le", label: "Inférieur ou égal à", needs: 1 },
  { value: "eq", label: "Égal à", needs: 1 },
  { value: "ne", label: "Différent de", needs: 1 },
  { value: "between", label: "Compris entre", needs: 2 },
  { value: "contains", label: "Le texte contient", needs: 1 },
  { value: "empty", label: "Est vide", needs: 0 },
  { value: "notEmpty", label: "N'est pas vide", needs: 0 },
  { value: "colorScale", label: "Échelle de couleurs", needs: 0 },
];

export function describeRule(rule: CondRule): string {
  if (rule.op === "colorScale") return "Échelle de couleurs";
  if (rule.op === "between") return `Compris entre ${rule.v1 ?? ""} et ${rule.v2 ?? ""}`;
  const op = COND_OPS.find((o) => o.value === rule.op);
  if (op?.needs === 0) return op.label;
  return `${op?.label ?? rule.op} « ${rule.v1 ?? ""} »`;
}

/**
 * Build a per-cell styler from a sheet's rules. Colour-scale min/max are
 * precomputed once; later rules override earlier ones on overlap.
 */
export function buildCondFormatter(
  rules: CondRule[] | undefined,
  getValue: (c: number, r: number) => CellValue,
  getText: (c: number, r: number) => string,
): (c: number, r: number) => CondStyle {
  if (!rules || rules.length === 0) return () => ({});
  const stats = new Map<string, { min: number; max: number }>();
  for (const rule of rules) {
    if (rule.op !== "colorScale") continue;
    let min = Infinity, max = -Infinity;
    for (let r = rule.r0; r <= rule.r1; r++) {
      for (let c = rule.c0; c <= rule.c1; c++) {
        const n = toNum(getValue(c, r));
        if (n === null) continue;
        if (n < min) min = n;
        if (n > max) max = n;
      }
    }
    if (min !== Infinity) stats.set(rule.id, { min, max });
  }
  return (c, r) => {
    let out: CondStyle = {};
    for (const rule of rules) {
      if (!inRule(rule, c, r)) continue;
      if (rule.op === "colorScale") {
        const s = stats.get(rule.id);
        if (!s || !rule.scale) continue;
        const n = toNum(getValue(c, r));
        if (n === null) continue;
        out = { ...out, background: colorScaleFill(rule.scale, n, s.min, s.max) };
      } else if (ruleMatches(rule, getValue(c, r), getText(c, r))) {
        if (rule.fill) out = { ...out, background: rule.fill };
        if (rule.color) out = { ...out, color: rule.color };
        if (rule.bold) out = { ...out, fontWeight: 700 };
      }
    }
    return out;
  };
}
