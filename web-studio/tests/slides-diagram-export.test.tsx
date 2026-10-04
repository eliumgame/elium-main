// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { unzipSync, strFromU8 } from "fflate";
import { type MutableRefObject } from "react";
import * as Y from "yjs";
import SlidesEditor from "../src/slides/SlidesEditor";
import { useLocalDeckStore, type LocalDeckStore } from "../src/slides/useLocalDeckStore";
import { DialogsProvider } from "../src/ui/dialogs";
import { deckToPptx } from "../src/slides/pptx";
import { importPptx } from "../src/slides/pptx-import";
import { emptyDeck, type Deck } from "../src/slides/model";
import { slideToY, yToSlide } from "../src/drive-cloud/collab-slides-crdt";

afterEach(cleanup);
beforeEach(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const deckWith = (kind: "process" | "cycle" | "hierarchy" | "list", outline: string): Deck => ({
  active: 0,
  slides: [{ id: "s", title: "", body: "", layout: "blank", elements: [{ id: "d", type: "diagram", x: 10, y: 10, w: 80, h: 60, diagram: { kind, outline } }] }],
});

describe("diagrammes — export PPTX et CRDT", () => {
  it("processus : une forme par étape et des connecteurs fléchés", () => {
    const xml = strFromU8(unzipSync(deckToPptx(deckWith("process", "A\nB\nC")))["ppt/slides/slide1.xml"]!);
    expect((xml.match(/prst="roundRect"/g) ?? []).length).toBe(3);
    expect((xml.match(/<a:tailEnd/g) ?? []).length).toBe(2);
    expect(xml).toContain("<a:t>B</a:t>");
  });
  it("cycle : formes elliptiques ; hiérarchie : liens en trois segments", () => {
    const cyc = strFromU8(unzipSync(deckToPptx(deckWith("cycle", "A\nB\nC")))["ppt/slides/slide1.xml"]!);
    expect((cyc.match(/prst="ellipse"/g) ?? []).length).toBe(3);
    const hier = strFromU8(unzipSync(deckToPptx(deckWith("hierarchy", "R\n  a\n  b")))["ppt/slides/slide1.xml"]!);
    expect((hier.match(/<p:cxnSp>/g) ?? []).length).toBe(6);
  });
  it("ids de formes uniques dans la diapositive", () => {
    const xml = strFromU8(unzipSync(deckToPptx(deckWith("hierarchy", "R\n  a\n    x\n    y\n  b")))["ppt/slides/slide1.xml"]!);
    const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("le plan survit à l'aller-retour Yjs (élément plat)", () => {
    const sl = deckWith("cycle", "A\nB").slides[0]!;
    expect(yToSlide(slideToY(sl)).elements![0]!.diagram).toEqual({ kind: "cycle", outline: "A\nB" });
  });
  it("PPTX → relecture : le diagramme devient des formes ordinaires (le plan n'est pas dans le fichier)", () => {
    const back = importPptx(deckToPptx(deckWith("process", "A\nB")));
    expect(back.slides[0]!.elements!.some((e) => e.type === "shape" && e.text === "A")).toBe(true);
  });
});

describe("SlidesEditor — diagramme", () => {
  function Harness({ storeRef }: { storeRef: MutableRefObject<LocalDeckStore | null> }) {
    const store = useLocalDeckStore(emptyDeck());
    storeRef.current = store;
    return (
      <DialogsProvider>
        <SlidesEditor store={store} chrome={{ title: "T" }} />
      </DialogsProvider>
    );
  }
  it("insère un diagramme depuis un plan, puis le modifie", async () => {
    const storeRef = { current: null } as MutableRefObject<LocalDeckStore | null>;
    render(<Harness storeRef={storeRef} />);
    await userEvent.click(screen.getByText("Diagramme"));
    const dlg = screen.getByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText("Plan du diagramme"), { target: { value: "Un\nDeux\nTrois\nQuatre" } });
    await userEvent.click(within(dlg).getByText("Insérer"));
    const els = storeRef.current!.deck.slides[0]!.elements!;
    const d = els.find((e) => e.type === "diagram")!;
    expect(d.diagram).toMatchObject({ kind: "process", outline: "Un\nDeux\nTrois\nQuatre" });
    // rendu accessible
    expect(screen.getAllByRole("img", { name: /Diagramme \(4 éléments\)/ }).length).toBeGreaterThan(0);
    // modification : sélectionner puis « Modifier le diagramme »
    await userEvent.click(screen.getAllByRole("img", { name: /Diagramme \(4 éléments\)/ })[0]!.closest(".ce")!);
    await userEvent.click(screen.getByText("Modifier le diagramme"));
    const dlg2 = screen.getByRole("dialog");
    fireEvent.change(within(dlg2).getByLabelText("Plan du diagramme"), { target: { value: "Seul" } });
    await userEvent.click(within(dlg2).getByText("Mettre à jour"));
    expect(storeRef.current!.deck.slides[0]!.elements!.find((e) => e.type === "diagram")!.diagram!.outline).toBe("Seul");
  });
});
