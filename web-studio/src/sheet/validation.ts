/**
 * Data validation — pure logic (no React). A rule constrains the values allowed
 * in a rectangular range: a dropdown list, a numeric/length/date comparison.
 * Validation is SOFT (non-blocking): invalid entries are flagged in the UI, not
 * refused, so a document never becomes un-editable. Dependency-free + unit-tested.
 */
import type { DataValidation, ValidationOp } from "./model";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/** Is cell (c, r) inside the rule's range? */
export function inValidation(v: DataValidation, c: number, r: number): boolean {
  return c >= v.c0 && c <= v.c1 && r >= v.r0 && r <= v.r1;
}

/** The validation that governs (c, r), later rules overriding earlier on overlap. */
export function validationAt(validations: DataValidation[] | undefined, c: number, r: number): DataValidation | null {
  if (!validations) return null;
  let found: DataValidation | null = null;
  for (const v of validations) if (inValidation(v, c, r)) found = v;
  return found;
}

function compare(op: ValidationOp, n: number, a: number, b: number): boolean {
  switch (op) {
    case "gt": return n > a;
    case "lt": return n < a;
    case "ge": return n >= a;
    case "le": return n <= a;
    case "eq": return n === a;
    case "ne": return n !== a;
    case "between": return n >= Math.min(a, b) && n <= Math.max(a, b);
    case "notBetween": return n < Math.min(a, b) || n > Math.max(a, b);
    default: return true;
  }
}

/** Parse a yyyy-mm-dd (or any Date-parseable) string to a day timestamp, or null. */
function toDate(s: string): number | null {
  const t = Date.parse(s.trim());
  return Number.isNaN(t) ? null : t;
}

/**
 * Validate a raw cell string against its rule. `raw` is the literal content
 * (formulas are not validated — they resolve to values, out of scope here).
 */
export function validateValue(rule: DataValidation, raw: string): ValidationResult {
  const text = raw ?? "";
  const blank = text.trim() === "";
  if (blank) {
    return rule.allowBlank === false ? { valid: false, reason: "La cellule ne peut pas être vide." } : { valid: true };
  }
  // Formulas are evaluated elsewhere; don't flag them here.
  if (text.startsWith("=")) return { valid: true };

  if (rule.type === "list") {
    const ok = (rule.list ?? []).includes(text);
    return ok ? { valid: true } : { valid: false, reason: "Valeur hors de la liste autorisée." };
  }

  if (rule.type === "number") {
    const n = Number(text);
    if (Number.isNaN(n)) return { valid: false, reason: "Un nombre est attendu." };
    const a = Number(rule.v1 ?? ""), b = Number(rule.v2 ?? "");
    const ok = rule.op ? compare(rule.op, n, a, b) : true;
    return ok ? { valid: true } : { valid: false, reason: "Nombre hors des bornes autorisées." };
  }

  if (rule.type === "textLength") {
    const len = text.length;
    const a = Number(rule.v1 ?? ""), b = Number(rule.v2 ?? "");
    const ok = rule.op ? compare(rule.op, len, a, b) : true;
    return ok ? { valid: true } : { valid: false, reason: "Longueur de texte non autorisée." };
  }

  if (rule.type === "date") {
    const d = toDate(text);
    if (d === null) return { valid: false, reason: "Une date valide est attendue." };
    const a = toDate(rule.v1 ?? "") ?? NaN, b = toDate(rule.v2 ?? "") ?? NaN;
    const ok = rule.op ? compare(rule.op, d, a, b) : true;
    return ok ? { valid: true } : { valid: false, reason: "Date hors des bornes autorisées." };
  }

  return { valid: true };
}

/**
 * Build a per-cell validator over a sheet's rules and raw contents. Returns null
 * for cells with no rule or that pass; a reason string for invalid cells.
 */
export function buildValidator(
  validations: DataValidation[] | undefined,
  getRaw: (c: number, r: number) => string,
): (c: number, r: number) => string | null {
  if (!validations || validations.length === 0) return () => null;
  return (c, r) => {
    const rule = validationAt(validations, c, r);
    if (!rule) return null;
    const res = validateValue(rule, getRaw(c, r));
    return res.valid ? null : res.reason ?? "Valeur non autorisée.";
  };
}

export const VALIDATION_OPS: { value: ValidationOp; label: string; needs: 1 | 2 }[] = [
  { value: "between", label: "Compris entre", needs: 2 },
  { value: "notBetween", label: "Non compris entre", needs: 2 },
  { value: "gt", label: "Supérieur à", needs: 1 },
  { value: "lt", label: "Inférieur à", needs: 1 },
  { value: "ge", label: "Supérieur ou égal à", needs: 1 },
  { value: "le", label: "Inférieur ou égal à", needs: 1 },
  { value: "eq", label: "Égal à", needs: 1 },
  { value: "ne", label: "Différent de", needs: 1 },
];

export function describeValidation(v: DataValidation): string {
  if (v.type === "list") return `Liste : ${(v.list ?? []).join(", ")}`;
  const kind = v.type === "number" ? "Nombre" : v.type === "textLength" ? "Longueur" : "Date";
  if (!v.op) return kind;
  const op = VALIDATION_OPS.find((o) => o.value === v.op);
  if (op?.needs === 2) return `${kind} ${op.label.toLowerCase()} ${v.v1 ?? ""} et ${v.v2 ?? ""}`;
  return `${kind} ${op?.label.toLowerCase() ?? v.op} ${v.v1 ?? ""}`;
}
