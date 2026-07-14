import { describe, it, expect } from "vitest";
import { formatValue } from "../src/sheet/format";

describe("number formats", () => {
  it("formats a serial as a date (no time)", () => {
    const out = formatValue(45000, "date", "45000");
    expect(out).not.toContain(":");
    expect(out).toMatch(/\d/);
  });

  it("formats a serial with a fractional day as date+time", () => {
    const out = formatValue(45000.5, "datetime", "45000.5"); // .5 day = midday
    expect(out).toMatch(/\d{1,2}:\d{2}/); // carries a HH:MM time component
  });

  it("currency and percent still render", () => {
    expect(formatValue(0.25, "percent", "0.25")).toContain("%");
    expect(formatValue(10, "currency", "10")).toMatch(/€|EUR/);
  });

  it("passes non-numeric values through to the fallback", () => {
    expect(formatValue("texte", "datetime", "texte")).toBe("texte");
  });
});
