/**
 * Structural equality for model values (plain JSON-like data): the test that
 * an annotation or an outline restored from a draft / an .elium — a different
 * object, deserialised — is still exactly what was read from the file, so the
 * save leaves the file's own copy untouched instead of rewriting it.
 *
 * Keys holding `undefined` count as absent (JSON drops them); `ignore` names
 * keys left out at every depth (e.g. generated ids).
 */
export function sameValue(a: unknown, b: unknown, ignore?: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => sameValue(v, bb[i], ignore));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined && !ignore?.has(k));
  const ka = keys(ao);
  const kb = keys(bo);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in bo && sameValue(ao[k], bo[k], ignore));
}
