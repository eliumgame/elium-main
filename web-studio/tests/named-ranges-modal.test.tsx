// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NamedRangesModal from "../src/sheet/NamedRangesModal";

afterEach(cleanup);

const noop = () => {};

describe("NamedRangesModal (component)", () => {
  it("rejects an address-like name: shows a hint and disables Add", async () => {
    render(<NamedRangesModal rangeLabel="'F'!A1:A3" names={[]} onAdd={noop} onRemove={noop} onClose={noop} />);
    await userEvent.type(screen.getByPlaceholderText(/Nom/), "A1");
    expect(screen.getByText(/Nom invalide/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Ajouter|Redéfinir/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds a valid name via the button", async () => {
    const onAdd = vi.fn();
    render(<NamedRangesModal rangeLabel="'F'!A1:A3" names={[]} onAdd={onAdd} onRemove={noop} onClose={noop} />);
    await userEvent.type(screen.getByPlaceholderText(/Nom/), "SALAIRES");
    await userEvent.click(screen.getByRole("button", { name: /Ajouter/ }));
    expect(onAdd).toHaveBeenCalledWith("SALAIRES");
  });

  it("lists existing names and removes one", async () => {
    const onRemove = vi.fn();
    render(<NamedRangesModal rangeLabel="'F'!A1" names={[{ name: "TVA", ref: "'F'!$B$1" }]} onAdd={noop} onRemove={onRemove} onClose={noop} />);
    expect(screen.getByText("TVA")).toBeTruthy();
    expect(screen.getByText(/'F'!\$B\$1/)).toBeTruthy();
    await userEvent.click(screen.getByTitle("Supprimer le nom"));
    expect(onRemove).toHaveBeenCalledWith("TVA");
  });

  it("shows 'Redéfinir' when the typed name already exists", async () => {
    render(<NamedRangesModal rangeLabel="'F'!A1" names={[{ name: "TVA", ref: "'F'!$B$1" }]} onAdd={noop} onRemove={noop} onClose={noop} />);
    await userEvent.type(screen.getByPlaceholderText(/Nom/), "tva");
    expect(screen.getByRole("button", { name: /Redéfinir/ })).toBeTruthy();
  });
});
