import { describe, it, expect } from "vitest";
import {
  describePortState,
  inAutoRange,
  isKnownBusy,
  validatePortInput,
  type PortInfo,
} from "../src/settings/launcher";

const info = (over: Partial<PortInfo> = {}): PortInfo => ({
  current: 3000,
  configured: null,
  fallbackUsed: false,
  ports: [
    { port: 3000, free: false },
    { port: 3001, free: true },
    { port: 3002, free: false },
  ],
  ...over,
});

describe("validation du port", () => {
  it("accepte un entier entre 1024 et 65535, espaces tolérés", () => {
    expect(validatePortInput("3050")).toEqual({ ok: true, port: 3050 });
    expect(validatePortInput("  8080 ")).toEqual({ ok: true, port: 8080 });
    expect(validatePortInput("1024")).toEqual({ ok: true, port: 1024 });
    expect(validatePortInput("65535")).toEqual({ ok: true, port: 65535 });
  });

  it("refuse hors plage, non numérique et vide", () => {
    expect(validatePortInput("1023")).toEqual({ ok: false, reason: "out_of_range" });
    expect(validatePortInput("65536")).toEqual({ ok: false, reason: "out_of_range" });
    expect(validatePortInput("80")).toEqual({ ok: false, reason: "out_of_range" });
    expect(validatePortInput("30a0")).toEqual({ ok: false, reason: "not_a_number" });
    expect(validatePortInput("-3000")).toEqual({ ok: false, reason: "not_a_number" });
    expect(validatePortInput("3000.5")).toEqual({ ok: false, reason: "not_a_number" });
    expect(validatePortInput("   ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("état du port", () => {
  it("automatique, épinglé, ou repli quand le port épinglé était occupé", () => {
    expect(describePortState(info())).toEqual({ kind: "auto", current: 3000 });
    expect(describePortState(info({ configured: 3000 }))).toEqual({ kind: "pinned", current: 3000, configured: 3000 });
    expect(describePortState(info({ configured: 3050, current: 3001, fallbackUsed: true }))).toEqual({
      kind: "fallback",
      current: 3001,
      configured: 3050,
    });
    // incohérence défensive : configuré ≠ courant même sans drapeau
    expect(describePortState(info({ configured: 4000 })).kind).toBe("fallback");
  });

  it("plage automatique et ports signalés occupés (hors celui d'Elium lui-même)", () => {
    expect(inAutoRange(3000) && inAutoRange(3100)).toBe(true);
    expect(inAutoRange(2999) || inAutoRange(3101)).toBe(false);
    expect(isKnownBusy(info(), 3002)).toBe(true);
    expect(isKnownBusy(info(), 3001)).toBe(false);
    expect(isKnownBusy(info(), 3000)).toBe(false); // c'est le port courant d'Elium : pas « occupé par un autre »
    expect(isKnownBusy(info(), 9999)).toBe(false); // inconnu : le lanceur tranchera
  });
});
