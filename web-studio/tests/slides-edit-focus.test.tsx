// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { useState } from "react";
import SlideCanvas from "../src/slides/canvas";
import type { Slide, SlideElement } from "../src/slides/model";

const el = (id: string, x: number): SlideElement => ({
  id,
  type: "text",
  x,
  y: 10,
  w: 40,
  h: 20,
  html: `<p>${id}</p>`,
  fontSize: 20,
});
const slide: Slide = {
  id: "s",
  title: "",
  body: "",
  bodyHtml: "",
  layout: "blank",
  elements: [el("a", 5), el("b", 50)],
};

function Harness() {
  const [sel, setSel] = useState<string[]>([]);
  return (
    <SlideCanvas
      slide={slide}
      elements={slide.elements!}
      theme="light"
      scale={1}
      editable
      selectedIds={sel}
      onSelectionChange={setSel}
    />
  );
}

afterEach(cleanup);

describe("édition de texte du canevas", () => {
  it("le double-clic donne le focus au champ (Ctrl+A et la frappe y arrivent)", () => {
    const { container } = render(<Harness />);
    const first = container.querySelector(".ce--text") as HTMLElement;
    fireEvent.doubleClick(first);
    const edit = container.querySelector(".ce-text--edit") as HTMLElement;
    expect(edit).not.toBeNull();
    expect(document.activeElement).toBe(edit);
  });

  it("Échap termine l'édition et rend le focus à la diapositive", () => {
    const { container } = render(<Harness />);
    fireEvent.doubleClick(container.querySelector(".ce--text") as HTMLElement);
    const edit = container.querySelector(".ce-text--edit") as HTMLElement;
    fireEvent.keyDown(edit, { key: "Escape" });
    expect(container.querySelector(".ce-text--edit")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".slide-cv"));
  });
});
