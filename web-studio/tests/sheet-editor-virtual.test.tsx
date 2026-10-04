// @vitest-environment jsdom
// SheetEditor virtualisé : un classeur de 100 000 lignes ne rend qu'une fenêtre de lignes,
// expose role="grid" avec les compteurs ARIA, et la navigation clavier suit la sélection.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import SheetEditor from "../src/sheet/SheetEditor";
import { useLocalSheetStore } from "../src/sheet/useLocalSheetStore";
import { DialogsProvider } from "../src/ui/dialogs";
import type { Workbook } from "../src/sheet/model";

afterEach(cleanup);
beforeEach(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const BIG: Workbook = {
  active: 0,
  sheets: [{ name: "F", rows: 100_000, cols: 6, cells: { A1: "x", A50000: "milieu" } }],
};

function Harness() {
  const store = useLocalSheetStore(BIG);
  return (
    <DialogsProvider>
      <SheetEditor store={store} chrome={{ title: "Test" }} />
    </DialogsProvider>
  );
}

describe("SheetEditor — virtualisation et ARIA", () => {
  it("100 000 lignes : seule une fenêtre est rendue, avec les compteurs ARIA complets", () => {
    render(<Harness />);
    const grid = screen.getByRole("grid", { name: "Grille de la feuille de calcul" });
    expect(grid.getAttribute("aria-rowcount")).toBe("100001");
    expect(grid.getAttribute("aria-colcount")).toBe("7");
    const rows = grid.querySelectorAll("tbody tr[role=row]");
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(80);
    expect(grid.querySelectorAll("tbody tr.sheet-vspacer").length).toBeGreaterThan(0);
    // première ligne et colonne : rowheader / gridcell indexés
    expect(rows[0]!.getAttribute("aria-rowindex")).toBe("2");
    expect(rows[0]!.querySelector("td[role=gridcell]")!.getAttribute("aria-colindex")).toBe("2");
  });
  it("la cellule active est désignée par aria-activedescendant et se déplace au clavier", () => {
    render(<Harness />);
    const grid = screen.getByRole("grid");
    const active = () => document.getElementById(grid.getAttribute("aria-activedescendant")!)!;
    expect(active().getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(active().getAttribute("aria-colindex")).toBe("3");
    expect(active().closest("tr")!.getAttribute("aria-rowindex")).toBe("3");
  });
  it("Ctrl+Fin rejoint la dernière ligne (rendue grâce au défilement automatique) ; Ctrl+Début revient", () => {
    render(<Harness />);
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "End", ctrlKey: true });
    // jsdom ne fait pas de mise en page : on vérifie l'état logique via l'identifiant de la cellule active
    expect(grid.getAttribute("aria-activedescendant")).toMatch(/-5-99999$/);
    fireEvent.keyDown(grid, { key: "Home", ctrlKey: true });
    expect(grid.getAttribute("aria-activedescendant")).toMatch(/-0-0$/);
  });
});
