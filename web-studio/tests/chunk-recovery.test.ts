import { beforeEach, describe, expect, it, vi } from "vitest";
import { isChunkLoadError, reloadForNewVersion } from "../src/ui/chunk-recovery";

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
});

describe("reprise après mise à jour", () => {
  it("reconnaît les erreurs de chargement de module des navigateurs", () => {
    expect(
      isChunkLoadError(
        new Error("Failed to fetch dynamically imported module: http://127.0.0.1:3001/assets/SheetView-x.js"),
      ),
    ).toBe(true);
    expect(isChunkLoadError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new Error("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
  });
  it("recharge une seule fois dans la minute (pas de boucle)", () => {
    const reload = vi.fn();
    expect(reloadForNewVersion(1_000_000, reload)).toBe(true);
    expect(reloadForNewVersion(1_010_000, reload)).toBe(false);
    expect(reloadForNewVersion(1_070_000, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
