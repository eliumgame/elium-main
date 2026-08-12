import { describe, it, expect } from "vitest";
import { canonicalJSON } from "../src/format/canonical";

describe("canonicalJSON — garde nombres non finis (parité canonical.py)", () => {
  it("refuse NaN / Infinity / -Infinity au lieu de les transformer silencieusement en null", () => {
    expect(() => canonicalJSON({ x: NaN })).toThrow(/non fini/);
    expect(() => canonicalJSON({ x: Infinity })).toThrow(/non fini/);
    expect(() => canonicalJSON({ x: -Infinity })).toThrow(/non fini/);
    // Non fini imbriqué (objet profond / tableau) attrapé aussi.
    expect(() => canonicalJSON({ a: { b: [1, 2, NaN] } })).toThrow(/non fini/);
    expect(() => canonicalJSON([Infinity])).toThrow(/non fini/);
  });

  it("sérialise normalement les nombres finis : clés triées, séparateurs compacts", () => {
    expect(canonicalJSON({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJSON({ x: 0.3, y: -1, z: 0 })).toBe('{"x":0.3,"y":-1,"z":0}');
  });
});
