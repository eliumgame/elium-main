import { describe, it, expect } from "vitest";
import {
  coerceValue,
  normalizeValue,
  storageEntries,
  valueFromStorage,
  type FormField,
} from "../src/pdf/core/forms/values";

function field(type: FormField["type"], over: Partial<FormField> = {}): FormField {
  return {
    name: "f",
    type,
    widgets: [{ id: "1R", page: 0, rect: null, exportValue: null, hidden: false }],
    fileValue: "",
    defaultValue: "",
    multiSelect: false,
    options: [
      { value: "C", label: "Cuba" },
      { value: "CH", label: "Suisse" },
    ],
    readOnly: false,
    charLimit: 0,
    hasActions: false,
    ...over,
  };
}

describe("form values ⇄ pdf.js annotationStorage", () => {
  it("writes list values as arrays, which pdf.js' choice widget matches exactly", () => {
    // pdf.js renders a <select> with `storedData.value.includes(exportValue)`:
    // null throws (empty form layer), a string « CH » would also select « C ».
    for (const type of ["combobox", "listbox"] as const) {
      const f = field(type);
      expect(storageEntries(f, "CH")).toEqual([["1R", { value: ["CH"] }]]);
      expect(storageEntries(f, "")).toEqual([["1R", { value: [] }]]);
      const [[, entry]] = storageEntries(f, "CH");
      expect((entry.value as string[]).includes("C")).toBe(false);
    }
  });

  it("reads back what it wrote and what pdf.js writes itself (a string)", () => {
    const f = field("combobox");
    const store = new Map(storageEntries(f, "CH"));
    expect(valueFromStorage(f, (id) => store.get(id))).toBe("CH");
    expect(valueFromStorage(f, () => ({ value: "C" }))).toBe("C");
    expect(valueFromStorage(f, () => ({ value: [] }))).toBe("");
    expect(valueFromStorage(f, () => undefined)).toBeUndefined();
  });

  it("keeps multi-select lists as arrays", () => {
    const f = field("listbox", { multiSelect: true });
    expect(storageEntries(f, ["C", "CH"])).toEqual([["1R", { value: ["C", "CH"] }]]);
    expect(normalizeValue(f, "C")).toEqual(["C"]);
    expect(coerceValue(f, "C")).toEqual(["C"]);
  });

  it("maps a box to its widget's export value", () => {
    const f = field("checkbox", {
      widgets: [
        { id: "a", page: 0, rect: null, exportValue: "Oui", hidden: false },
        { id: "b", page: 0, rect: null, exportValue: "Non", hidden: false },
      ],
      fileValue: "Off",
    });
    expect(storageEntries(f, "Non")).toEqual([
      ["a", { value: false }],
      ["b", { value: true }],
    ]);
    const store = new Map(storageEntries(f, "Non"));
    expect(valueFromStorage(f, (id) => store.get(id))).toBe("Non");
    expect(coerceValue(f, true)).toBe("Oui");
  });
});
