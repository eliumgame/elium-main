// @vitest-environment jsdom
/**
 * ToolbarPopover (ActionMenu.tsx) is what the toolbar galleries (Forme,
 * Graphique, Couleurs, Animations, Modèles in SlidesEditor.tsx) were migrated
 * onto so they close on Échap and via a real ARIA role, not just onMouseLeave
 * (a keyboard/touch user could never trigger that). Covers the popover in
 * isolation rather than mounting the whole editor.
 */
import { useRef, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolbarPopover } from "../src/slides/ActionMenu";

afterEach(cleanup);

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    onClose();
  };
  return (
    <div>
      <button ref={triggerRef}>Ouvrir</button>
      {open && (
        <ToolbarPopover ariaLabel="Formes" onClose={close} triggerRef={triggerRef}>
          <button>Rectangle</button>
          <button>Cercle</button>
        </ToolbarPopover>
      )}
    </div>
  );
}

describe("ToolbarPopover (component)", () => {
  it("renders with an ARIA menu role and label", () => {
    render(<Harness onClose={() => {}} />);
    const menu = screen.getByRole("menu", { name: "Formes" });
    expect(menu).toBeTruthy();
  });

  it("moves initial focus onto the first control inside the popover", () => {
    render(<Harness onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByText("Rectangle"));
  });

  it("closes on Échap and returns focus to the trigger button", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("Ouvrir"));
  });

  it("closes on an outside click", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT close on a click on the trigger button itself (avoids reopen-then-immediately-close)", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText("Ouvrir"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does NOT close on a click inside the popover itself", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText("Cercle"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("uses a dialog role when told to host form controls instead of a plain action list", () => {
    function DialogHarness() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button ref={triggerRef}>Réglages</button>
          <ToolbarPopover role="dialog" ariaLabel="Réglages" onClose={() => {}} triggerRef={triggerRef}>
            <input aria-label="Angle" />
          </ToolbarPopover>
        </div>
      );
    }
    render(<DialogHarness />);
    expect(screen.getByRole("dialog", { name: "Réglages" })).toBeTruthy();
  });
});
