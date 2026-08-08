/**
 * SCIM group→role mapping : la sélection du rôle « le plus privilégié » est pure
 * et déterministe. `pool` mocké — pas de DB.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTx: vi.fn(),
  pool: {},
  closePool: vi.fn(),
}));

import { mostPrivilegedRole } from "../src/routes/scim.js";

describe("mostPrivilegedRole", () => {
  it("retourne null sans rôle mappé", () => {
    expect(mostPrivilegedRole([])).toBeNull();
  });

  it("choisit le rôle au plus grand nombre de permissions", () => {
    const r = mostPrivilegedRole([
      { key: "viewer", permCount: 3, roleId: "rv" },
      { key: "admin", permCount: 30, roleId: "ra" },
      { key: "editor", permCount: 12, roleId: "re" },
    ]);
    expect(r).toBe("ra");
  });

  it("départage les ex æquo par clé de rôle croissante (déterministe)", () => {
    const r = mostPrivilegedRole([
      { key: "zeta", permCount: 5, roleId: "rz" },
      { key: "alpha", permCount: 5, roleId: "raa" },
    ]);
    expect(r).toBe("raa");
  });
});
