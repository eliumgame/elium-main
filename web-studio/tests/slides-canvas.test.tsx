// @vitest-environment jsdom
/**
 * SlideCanvas is the free-canvas renderer shared by the editor and the
 * presenter/audience views. Covers per-type rendering, presenter reveal state
 * (hidden/entering classes) and the basic click-to-select gesture — not the
 * full drag/resize/rotate machinery, which is exercised indirectly through
 * selection.ts's own unit tests.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import SlideCanvas from "../src/slides/canvas";
import type { Slide, SlideElement } from "../src/slides/model";

afterEach(cleanup);

const baseSlide: Slide = { id: "s1", title: "", body: "", bodyHtml: "", layout: "blank", elements: [] };

function el(patch: Partial<SlideElement> & Pick<SlideElement, "id" | "type">): SlideElement {
  return { x: 10, y: 10, w: 30, h: 20, ...patch } as SlideElement;
}

describe("SlideCanvas (component) — per-type rendering", () => {
  it("renders a text element's html content", () => {
    const els = [el({ id: "t", type: "text", html: "<p>Bonjour</p>" })];
    render(<SlideCanvas slide={baseSlide} elements={els} theme="light" scale={1} />);
    expect(screen.getByText("Bonjour")).toBeTruthy();
  });

  it("renders a shape element as an svg with its label", () => {
    const els = [el({ id: "sh", type: "shape", shape: "star", text: "Étiquette" })];
    const { container } = render(<SlideCanvas slide={baseSlide} elements={els} theme="light" scale={1} />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("Étiquette")).toBeTruthy();
  });

  it("renders an image element's src, or a placeholder without one", () => {
    const withSrc = [el({ id: "im", type: "image", src: "data:image/png;base64,AAA" })];
    const { container, rerender } = render(<SlideCanvas slide={baseSlide} elements={withSrc} theme="light" scale={1} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAA");

    const noSrc = [el({ id: "im2", type: "image" })];
    rerender(<SlideCanvas slide={baseSlide} elements={noSrc} theme="light" scale={1} />);
    expect(screen.getByText("Image")).toBeTruthy();
  });

  it("renders a table element's cells", () => {
    const els = [
      el({
        id: "tb",
        type: "table",
        table: {
          rows: 2,
          cols: 2,
          cells: [
            ["A", "B"],
            ["1", "2"],
          ],
        },
      }),
    ];
    const { container } = render(<SlideCanvas slide={baseSlide} elements={els} theme="light" scale={1} />);
    // TableCell syncs content via `innerText` (an effect, not JSX children) so
    // the real text lands on that DOM property — jsdom doesn't mirror it onto
    // textContent, unlike a real browser.
    const cells = Array.from(container.querySelectorAll("td")).map((td) => (td as HTMLElement).innerText);
    expect(cells).toEqual(["A", "B", "1", "2"]);
  });

  it("renders a chart element via SheetChart, or a placeholder without chart data", () => {
    const withChart = [el({ id: "ch", type: "chart", chart: { kind: "bar", labels: ["X"], values: [3] } })];
    const { container, rerender } = render(<SlideCanvas slide={baseSlide} elements={withChart} theme="light" scale={1} />);
    expect(container.querySelector(".ce-chart")).toBeTruthy();

    const noChart = [el({ id: "ch2", type: "chart" })];
    rerender(<SlideCanvas slide={baseSlide} elements={noChart} theme="light" scale={1} />);
    expect(screen.getByText("Graphique")).toBeTruthy();
  });
});

describe("SlideCanvas (component) — presenter reveal state", () => {
  it("marks a not-yet-revealed element hidden and an entering one animated", () => {
    const els = [
      el({ id: "a", type: "text", html: "<p>A</p>" }),
      el({ id: "b", type: "text", html: "<p>B</p>" }),
    ];
    const reveal = {
      hidden: new Set(["b"]),
      entering: new Map([["a", { elementId: "a", effect: "fade" as const, order: 1, durationMs: 400 }]]),
    };
    const { container } = render(
      <SlideCanvas slide={baseSlide} elements={els} theme="light" scale={1} reveal={reveal} />,
    );
    const a = container.querySelector(".ce--text")!;
    const nodes = container.querySelectorAll(".ce--text");
    expect(nodes[0]!.className).toContain("sv-anim");
    expect(nodes[0]!.className).toContain("sv-anim--fade");
    expect(nodes[1]!.className).toContain("sv-hidden");
    expect(a).toBeTruthy();
  });
});

describe("SlideCanvas (component) — editable selection", () => {
  it("clicking an element in editable mode selects only it", () => {
    const els = [el({ id: "a", type: "text", html: "<p>A</p>" }), el({ id: "b", type: "text", html: "<p>B</p>" })];
    const onSelectionChange = vi.fn();
    const { container } = render(
      <SlideCanvas
        slide={baseSlide}
        elements={els}
        theme="light"
        scale={1}
        editable
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />,
    );
    const nodes = container.querySelectorAll(".ce--text");
    fireEvent.mouseDown(nodes[0]!);
    expect(onSelectionChange).toHaveBeenCalledWith(["a"]);
  });

  it("does not fire a selection change when not editable", () => {
    const els = [el({ id: "a", type: "text", html: "<p>A</p>" })];
    const onSelectionChange = vi.fn();
    const { container } = render(
      <SlideCanvas slide={baseSlide} elements={els} theme="light" scale={1} onSelectionChange={onSelectionChange} />,
    );
    fireEvent.mouseDown(container.querySelector(".ce--text")!);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});
