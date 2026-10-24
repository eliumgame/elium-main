import { describe, expect, it } from "vitest";
import { backupOverdue } from "../src/routes/site.js";

describe("sauvegarde imposée : retard signalé au propriétaire", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  it("aucune sauvegarde signalée = en retard", () => {
    expect(backupOverdue(null, now)).toBe(true);
  });
  it("moins de 48 h = à jour, au-delà = en retard", () => {
    expect(backupOverdue("2026-10-23T12:00:00Z", now)).toBe(false);
    expect(backupOverdue(new Date("2026-10-22T11:59:00Z"), now)).toBe(true);
  });
});
