// @vitest-environment jsdom
/**
 * Bug réel (audit externe, reproduit en navigateur) : taper =SUM(2,3) caractère
 * par caractère DANS LA BARRE DE FORMULE sur une cellule vide perdait le "="
 * (la cellule gardait "SUM(2,3)" comme texte). Cause : le premier caractère
 * montait l'éditeur de cellule en autoFocus, qui SÉLECTIONNAIT son contenu
 * (le brouillon déjà saisi) — le caractère suivant le remplaçait. startEdit()
 * (saisie directe en grille) évitait déjà ce piège via seededEditRef ; la barre
 * de formule ne le faisait pas. Voir SheetEditor.tsx (onChange de la barre de
 * formule) et le commentaire sur seededEditRef / startEdit.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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

const EMPTY: Workbook = { active: 0, sheets: [{ name: "F", rows: 10, cols: 4, cells: {} }] };

function Harness() {
  const store = useLocalSheetStore(EMPTY);
  return (
    <DialogsProvider>
      <SheetEditor store={store} chrome={{ title: "Test" }} />
    </DialogsProvider>
  );
}

describe("Barre de formule — amorçage de l'édition sur cellule vide", () => {
  it("le premier caractère tapé dans la barre de formule ne se fait pas écraser par le suivant", () => {
    render(<Harness />);
    const bar = document.querySelector(".sheet-formula__input") as HTMLInputElement;
    expect(bar).toBeTruthy();

    // Premier caractère : sur la barre de formule (c'est elle qui a le focus avant toute frappe).
    fireEvent.change(bar, { target: { value: "=" } });
    // Caractères suivants : l'éditeur de cellule (monté en autoFocus) a maintenant le vrai focus
    // navigateur — exactement ce que montrait le bug (la frappe continue là, pas dans la barre).
    for (const ch of "SUM(2,3)") {
      const cellInput = document.querySelector(".sheet-cell-input") as HTMLInputElement;
      fireEvent.change(cellInput, { target: { value: cellInput.value + ch } });
    }
    fireEvent.keyDown(document.querySelector(".sheet-cell-input")!, { key: "Enter" });
    // Entrée commite PUIS déplace la sélection (A1 -> A2) : revenir sur A1 pour lire ce qui a
    // vraiment été enregistré, plutôt que la cellule désormais active.
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowUp" });

    expect((document.querySelector(".sheet-formula__input") as HTMLInputElement).value).toBe("=SUM(2,3)");
  });

  it("le focus bascule vers l'éditeur de cellule sans jamais sélectionner le brouillon déjà saisi", () => {
    render(<Harness />);
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, "select");
    const bar = document.querySelector(".sheet-formula__input") as HTMLInputElement;

    fireEvent.change(bar, { target: { value: "=" } });

    const cellInput = document.querySelector(".sheet-cell-input") as HTMLInputElement | null;
    expect(cellInput).toBeTruthy();
    expect(cellInput!.value).toBe("="); // le brouillon amorcé par la barre est bien repris
    expect(selectSpy).not.toHaveBeenCalled(); // jamais sélectionné -> rien à écraser à la frappe suivante

    selectSpy.mockRestore();
  });
});
