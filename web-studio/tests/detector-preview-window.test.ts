import { describe, expect, it } from "vitest";
import {
  windowAround,
  expandStart,
  expandEnd,
  ensureCovers,
  MAX_INITIAL_WINDOW,
} from "../src/detector/ui/previewWindow";

describe("detector — fenêtrage de l'aperçu du document", () => {
  it("ne tronque pas un document plus petit que la fenêtre", () => {
    const w = windowAround(50, 10);
    expect(w).toEqual({ start: 0, end: 50, truncated: false });
  });

  it("centre la fenêtre sur l'index demandé pour un document volumineux", () => {
    const total = 5000;
    const w = windowAround(total, 2500, 400);
    expect(w.truncated).toBe(true);
    expect(w.end - w.start).toBe(400);
    expect(2500).toBeGreaterThanOrEqual(w.start);
    expect(2500).toBeLessThan(w.end);
  });

  it("recadre en butée au début/à la fin du document sans dépasser ses bornes", () => {
    const total = 1000;
    expect(windowAround(total, 0, 400)).toEqual({ start: 0, end: 400, truncated: true });
    const end = windowAround(total, 999, 400);
    expect(end.end).toBe(total);
    expect(end.start).toBe(total - 400);
  });

  it("expandStart/expandEnd étendent la fenêtre sans jamais sortir des bornes", () => {
    const total = 3000;
    let w = windowAround(total, 100, 400);
    w = expandStart(w, total);
    expect(w.start).toBe(0);
    w = expandEnd(w, total, 10000);
    expect(w.end).toBe(total);
    expect(w.truncated).toBe(false);
  });

  it("ensureCovers n'étend que si l'index cible tombe hors de la fenêtre actuelle", () => {
    const total = 5000;
    const w = windowAround(total, 100, 400);
    const same = ensureCovers(w, total, 150);
    expect(same).toBe(w);
    const moved = ensureCovers(w, total, 4000);
    expect(4000).toBeGreaterThanOrEqual(moved.start);
    expect(4000).toBeLessThan(moved.end);
  });

  it("la constante par défaut reste raisonnable pour un document de plusieurs centaines de pages", () => {
    expect(MAX_INITIAL_WINDOW).toBeGreaterThan(0);
    expect(MAX_INITIAL_WINDOW).toBeLessThanOrEqual(2000);
  });
});
