import { describe, it, expect } from "vitest";
import {
  calculateScript,
  formatScripts,
  parseCall,
  parseCalculate,
  parseFieldScripts,
  parseFormat,
  parseValidate,
  validateScript,
} from "../src/pdf/core/forms/afscripts";
import type { FieldFormat } from "../src/pdf/model/types";

describe("afscripts — Acrobat's form JavaScript both ways", () => {
  it("reads back every Format choice it writes", () => {
    const formats: FieldFormat[] = [
      { kind: "number", decimals: 2, sepStyle: 2, negStyle: 1, currency: " €", currencyPrepend: false },
      { kind: "number", decimals: 0, sepStyle: 0, negStyle: 0, currency: "$", currencyPrepend: true },
      { kind: "percent", decimals: 1, sepStyle: 3 },
      { kind: "date", pattern: "dd/mm/yyyy" },
      { kind: "time", style: 2 },
    ];
    for (const f of formats) {
      const s = formatScripts(f)!;
      expect(parseFormat(s.K, s.F)).toEqual(f);
    }
    expect(parseFormat(undefined, undefined)).toEqual({ kind: "none" });
  });

  it("maps Acrobat's legacy AFDate_Format(n) to its mask", () => {
    expect(parseFormat("AFDate_Keystroke(2);", "AFDate_Format(2);")).toEqual({ kind: "date", pattern: "mm/dd/yy" });
  });

  it("keeps anything else as a custom script", () => {
    expect(parseFormat("event.rc = true;", "event.value = 'x';")).toEqual({
      kind: "custom",
      keystroke: "event.rc = true;",
      format: "event.value = 'x';",
    });
    expect(parseCalculate("event.value = this.getField('a').value * 2;")).toEqual({
      kind: "custom",
      script: "event.value = this.getField('a').value * 2;",
    });
  });

  it("round-trips range checks and simple calculations, both field-list forms", () => {
    expect(parseValidate(validateScript({ min: 0, max: 100 })!)).toEqual({ min: 0, max: 100 });
    expect(parseValidate(validateScript({ max: -2.5 })!)).toEqual({ max: -2.5 });
    const c = { kind: "simple" as const, op: "SUM" as const, fields: ['a"b', "c.d"] };
    expect(parseCalculate(calculateScript(c)!)).toEqual(c);
    expect(parseCalculate('AFSimple_Calculate("AVG", "qte, prix");')).toEqual({
      kind: "simple",
      op: "AVG",
      fields: ["qte", "prix"],
    });
  });

  it("parses call arguments of every literal kind, and refuses what is not one call", () => {
    expect(parseCall(`F(1, -2.5, true, "a\\"b", 'c', new Array("x", 2), [])`)).toEqual({
      name: "F",
      args: [1, -2.5, true, 'a"b', "c", ["x", 2], []],
    });
    expect(parseCall("a(); b();")).toBeNull();
    expect(parseCall("F(x)")).toBeNull();
  });

  it("reads pdf.js' actions map", () => {
    const got = parseFieldScripts({
      Keystroke: ['AFNumber_Keystroke(2, 0, 0, 0, "", true);'],
      Format: ['AFNumber_Format(2, 0, 0, 0, "", true);'],
      Validate: ["AFRange_Validate(true, 1, false, 0);"],
      Calculate: ['AFSimple_Calculate("PRD", new Array("qte", "prix"));'],
    });
    expect(got.format.kind).toBe("number");
    expect(got.validate).toEqual({ min: 1 });
    expect(got.calculate).toEqual({ kind: "simple", op: "PRD", fields: ["qte", "prix"] });
  });
});
