// @vitest-environment jsdom
/**
 * useLocalSheetStore — un classeur neuf (rien d'ouvert, rien de sauvegardé en
 * IndexedDB) doit être dimensionné à la taille de l'écran plutôt qu'au défaut
 * fixe historique (8 colonnes × 20 lignes) : sur un grand écran, ce défaut
 * fixe laissait un vide sans rapport avec l'espace disponible sous la grille
 * (voir computeInitialWorkbook dans useLocalSheetStore.ts).
 *
 * growSheet() est testé séparément : il manquait entièrement du store local
 * (présent seulement côté Tableur collaboratif, useCollabSheetStore.ts), ce
 * qui masquait le bouton « Agrandir » du ruban dans le Tableur local — un vrai
 * écart de parité local/collaboratif, indépendant du dimensionnement initial.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";

const loadWorkbook = vi.fn();
const saveWorkbook = vi.fn();
vi.mock("../src/sheet/sheet-store", () => ({
  loadWorkbook: (...args: unknown[]) => loadWorkbook(...args),
  saveWorkbook: (...args: unknown[]) => saveWorkbook(...args),
}));

import { useLocalSheetStore } from "../src/sheet/useLocalSheetStore";
import { emptyWorkbook } from "../src/sheet/model";

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, writable: true, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, writable: true, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useLocalSheetStore — dimensionnement initial à l'écran", () => {
  it("un grand écran produit un classeur plus grand que le défaut historique 8×20", async () => {
    setViewport(2000, 1200);
    loadWorkbook.mockResolvedValue(undefined); // rien en IndexedDB : cas du tout premier lancement

    const { result } = renderHook(() => useLocalSheetStore());

    await waitFor(() => expect(result.current.wb.sheets[0]!.cols).not.toBe(8));

    const sheet = result.current.wb.sheets[0]!;
    expect(sheet.cols).toBe(20);
    expect(sheet.rows).toBe(33);
    // Le dimensionnement initial ne doit jamais être annulable : ce n'est pas
    // une édition de l'utilisateur, seulement l'état de départ de la page.
    expect(result.current.canUndo).toBe(false);
  });

  it("un très grand écran reste plafonné (pas de grille démesurée)", async () => {
    setViewport(5000, 4000);
    loadWorkbook.mockResolvedValue(undefined);

    const { result } = renderHook(() => useLocalSheetStore());

    await waitFor(() => expect(result.current.wb.sheets[0]!.cols).not.toBe(8));

    const sheet = result.current.wb.sheets[0]!;
    expect(sheet.cols).toBe(40);
    expect(sheet.rows).toBe(100);
  });

  it("un petit écran garde au moins le défaut historique (jamais plus petit)", async () => {
    setViewport(800, 600);
    loadWorkbook.mockResolvedValue(undefined);

    const { result } = renderHook(() => useLocalSheetStore());

    // Rien ne change visiblement dans ce cas (8×20 avant et après), donc pas de
    // valeur à attendre via waitFor : on laisse explicitement le temps à la
    // continuation de `loadWorkbook().then(...)` de s'exécuter avant d'affirmer
    // qu'elle a bien tourné sans rien casser.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadWorkbook).toHaveBeenCalled();

    const sheet = result.current.wb.sheets[0]!;
    expect(sheet.cols).toBe(8);
    expect(sheet.rows).toBe(20);
  });

  it("un classeur sauvegardé (IndexedDB) n'est jamais redimensionné", async () => {
    setViewport(2000, 1200);
    const saved = emptyWorkbook();
    saved.sheets[0]!.cols = 3;
    saved.sheets[0]!.cells = { A1: "vraies données" };
    loadWorkbook.mockResolvedValue(saved);

    const { result } = renderHook(() => useLocalSheetStore());

    await waitFor(() => expect(result.current.wb.sheets[0]!.cells.A1).toBe("vraies données"));
    // La taille réelle du classeur sauvegardé prime toujours sur l'écran courant.
    expect(result.current.wb.sheets[0]!.cols).toBe(3);
  });
});

describe("useLocalSheetStore — growSheet (parité avec le Tableur collaboratif)", () => {
  it("agrandit le nombre de lignes/colonnes de la feuille active", () => {
    const placeholder = emptyWorkbook();
    const { result } = renderHook(() => useLocalSheetStore(placeholder));

    act(() => {
      result.current.growSheet!(0, "rows", 10);
      result.current.growSheet!(0, "cols", 4);
    });

    const sheet = result.current.wb.sheets[0]!;
    expect(sheet.rows).toBe(30);
    expect(sheet.cols).toBe(12);
  });

  it("reste au moins à 1 (jamais négatif ni nul)", () => {
    const placeholder = emptyWorkbook();
    const { result } = renderHook(() => useLocalSheetStore(placeholder));

    act(() => {
      result.current.growSheet!(0, "rows", -100);
    });

    expect(result.current.wb.sheets[0]!.rows).toBe(1);
  });
});
