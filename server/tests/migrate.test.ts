/**
 * Runner de migrations versionnées : la logique de décision (quelles migrations
 * restent à appliquer, dans l'ordre, + détection de dérive de checksum) est pure
 * et testable sans base. `pool` est mocké pour que l'import du module ne tire pas
 * la vraie config/pg.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  withTx: vi.fn(),
  closePool: vi.fn(),
}));

import { planMigrations, readMigrations, type Migration } from "../src/db/migrate.js";

const mk = (version: string, checksum: string): Migration => ({ version, sql: "", checksum });

describe("planMigrations", () => {
  it("applique tout quand rien n'est enregistré", () => {
    const all = [mk("0001_a", "c1"), mk("0002_b", "c2")];
    const { pending, drift } = planMigrations(all, new Map());
    expect(pending.map((m) => m.version)).toEqual(["0001_a", "0002_b"]);
    expect(drift).toEqual([]);
  });

  it("saute les migrations déjà appliquées et garde l'ordre des restantes", () => {
    const all = [mk("0001_a", "c1"), mk("0002_b", "c2"), mk("0003_c", "c3")];
    const applied = new Map([
      ["0001_a", "c1"],
      ["0002_b", "c2"],
    ]);
    expect(planMigrations(all, applied).pending.map((m) => m.version)).toEqual(["0003_c"]);
  });

  it("adopte une base existante : baseline idempotente appliquée une fois, puis skippée", () => {
    const all = [mk("0001_baseline", "cb")];
    // Première exécution (base pré-existante, aucun marqueur de version) : on
    // exécute la baseline idempotente une fois.
    expect(planMigrations(all, new Map()).pending.map((m) => m.version)).toEqual(["0001_baseline"]);
    // Ré-exécution (marqueur enregistré) : plus rien à faire.
    expect(planMigrations(all, new Map([["0001_baseline", "cb"]])).pending).toEqual([]);
  });

  it("signale une dérive de checksum sur une migration déjà appliquée, sans la ré-exécuter", () => {
    const all = [mk("0001_a", "NEW")];
    const { pending, drift } = planMigrations(all, new Map([["0001_a", "OLD"]]));
    expect(pending).toEqual([]);
    expect(drift).toEqual([{ version: "0001_a", expected: "OLD", actual: "NEW" }]);
  });
});

describe("readMigrations", () => {
  it("lit le vrai dossier de migrations, trié, baseline en tête, checksums 64-hex", () => {
    const ms = readMigrations();
    expect(ms.length).toBeGreaterThanOrEqual(1);
    expect(ms[0].version).toBe("0001_baseline");
    const versions = ms.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a.localeCompare(b, "en")));
    for (const m of ms) expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
