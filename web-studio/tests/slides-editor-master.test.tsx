// @vitest-environment jsdom
import { type MutableRefObject } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SlidesEditor from "../src/slides/SlidesEditor";
import { useLocalDeckStore, type LocalDeckStore } from "../src/slides/useLocalDeckStore";
import { DialogsProvider } from "../src/ui/dialogs";
import { emptyDeck } from "../src/slides/model";
import { defaultMaster } from "../src/slides/master";
import type { Deck } from "../src/slides/model";

afterEach(cleanup);
beforeEach(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function Harness({ initial, storeRef }: { initial: Deck; storeRef: MutableRefObject<LocalDeckStore | null> }) {
  const store = useLocalDeckStore(initial);
  storeRef.current = store;
  return (
    <DialogsProvider>
      <SlidesEditor store={store} chrome={{ title: "Test" }} />
    </DialogsProvider>
  );
}
function mount() {
  const storeRef = { current: null } as MutableRefObject<LocalDeckStore | null>;
  render(<Harness initial={emptyDeck()} storeRef={storeRef} />);
  return storeRef;
}

describe("SlidesEditor — masque et dispositions", () => {
  it("choisir une disposition crée les espaces réservés ; Réinitialiser les remet en place", async () => {
    const store = mount();
    const select = screen.getByLabelText("Disposition de la diapositive");
    fireEvent.change(select, { target: { value: "lay-contenu" } });
    const s = store.current!.deck.slides[0]!;
    expect(s.layoutId).toBe("lay-contenu");
    expect(s.elements!.map((e) => e.ph)).toEqual(expect.arrayContaining(["title", "body"]));
    // on déplace le titre puis on réinitialise
    const title = s.elements!.find((e) => e.ph === "title")!;
    act(() => store.current!.updateEl(title.id, { x: 60, y: 60 }, true));
    expect(store.current!.deck.slides[0]!.elements!.find((e) => e.ph === "title")!.x).toBe(60);
    await userEvent.click(screen.getByText("Réinitialiser"));
    expect(store.current!.deck.slides[0]!.elements!.find((e) => e.ph === "title")!.x).toBe(7);
    // annulable en une étape
    await userEvent.click(screen.getByTitle("Annuler (Ctrl+Z)"));
    expect(store.current!.deck.slides[0]!.elements!.find((e) => e.ph === "title")!.x).toBe(60);
  });

  it("l'éditeur de masque applique les polices et le pied de page à toutes les diapositives liées", async () => {
    const store = mount();
    fireEvent.change(screen.getByLabelText("Disposition de la diapositive"), { target: { value: "lay-contenu" } });
    await userEvent.click(screen.getByText("Masque"));
    const dlg = screen.getByRole("dialog");
    await userEvent.type(within(dlg).getByPlaceholderText("(aucun)"), "Acme");
    await userEvent.click(within(dlg).getByText("Appliquer à toutes les diapositives"));
    const d = store.current!.deck;
    expect(d.master!.footerText).toBe("Acme");
    expect(d.slides[0]!.elements!.some((e) => e.ph === "footer" && (e.html ?? "").includes("Acme"))).toBe(true);
    expect(d.master!.layouts).toHaveLength(defaultMaster().layouts.length);
  });
});
