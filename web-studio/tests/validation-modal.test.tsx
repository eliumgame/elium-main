// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ValidationModal from "../src/sheet/ValidationModal";

afterEach(cleanup);

const noop = () => {};

describe("ValidationModal (component)", () => {
  it("defaults to a list rule and adds the parsed values", async () => {
    const onAdd = vi.fn();
    render(<ValidationModal rangeLabel="A1:A5" validations={[]} onAdd={onAdd} onRemove={noop} onClose={noop} />);
    await userEvent.type(screen.getByPlaceholderText(/Valeurs autorisées/), "Oui, Non; Peut-être");
    await userEvent.click(screen.getByRole("button", { name: /Ajouter la règle/ }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "list", list: ["Oui", "Non", "Peut-être"] }));
  });

  it("switches to a numeric rule (operator + bounds) and adds it", async () => {
    const onAdd = vi.fn();
    render(<ValidationModal rangeLabel="B1:B9" validations={[]} onAdd={onAdd} onRemove={noop} onClose={noop} />);
    // first select = type; choose "Nombre"
    await userEvent.selectOptions(screen.getAllByRole("combobox")[0], "number");
    // op select now present; choose "gt" (Supérieur à)
    await userEvent.selectOptions(screen.getAllByRole("combobox")[1], "gt");
    await userEvent.type(screen.getByPlaceholderText("valeur"), "0");
    await userEvent.click(screen.getByRole("button", { name: /Ajouter la règle/ }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "number", op: "gt", v1: "0" }));
  });

  it("lists an existing rule and removes it", async () => {
    const onRemove = vi.fn();
    render(
      <ValidationModal
        rangeLabel="A1:A5"
        validations={[{ id: "v1", c0: 0, r0: 0, c1: 0, r1: 4, type: "list", list: ["A", "B"] }]}
        onAdd={noop} onRemove={onRemove} onClose={noop}
      />,
    );
    expect(screen.getByText(/Liste : A, B/)).toBeTruthy();
    await userEvent.click(screen.getByTitle("Supprimer la règle"));
    expect(onRemove).toHaveBeenCalledWith("v1");
  });
});
