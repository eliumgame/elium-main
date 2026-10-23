// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import SlideThumb from "../src/slides/SlideThumb";
import type { Slide } from "../src/slides/model";

const slide = (id: string): Slide => ({
  id,
  title: id,
  body: "",
  bodyHtml: "",
  layout: "blank",
  elements: [{ id: "e", type: "text", x: 1, y: 1, w: 50, h: 20, html: "<p>Bonjour</p>", fontSize: 20 }],
});

type IOCb = (entries: { isIntersecting: boolean }[]) => void;
let cbs: IOCb[] = [];
class FakeIO {
  constructor(cb: IOCb) {
    cbs.push(cb);
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  cbs = [];
});

describe("SlideThumb (rendu par fenêtre)", () => {
  it("ne monte le canevas que lorsque la miniature approche de la zone visible, et le démonte en s'éloignant", () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const { container } = render(<SlideThumb slide={slide("a")} theme="light" scale={0.2} slideNumber={1} />);
    expect(container.querySelector(".slide-cv")).toBeNull();
    vi.useFakeTimers();
    act(() => cbs[0]([{ isIntersecting: true }]));
    act(() => void vi.advanceTimersByTime(50)); // le montage passe par la file à tranches
    vi.useRealTimers();
    expect(container.querySelector(".slide-cv")).not.toBeNull();
    act(() => cbs[0]([{ isIntersecting: false }]));
    expect(container.querySelector(".slide-cv")).toBeNull();
  });

  it("sans IntersectionObserver, la miniature est montée directement", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(<SlideThumb slide={slide("a")} theme="light" scale={0.2} slideNumber={1} />);
    expect(container.querySelector(".slide-cv")).not.toBeNull();
  });

  it("ne re-rend pas une miniature dont la diapositive est inchangée (memo)", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const s = slide("a");
    const { container, rerender } = render(<SlideThumb slide={s} theme="light" scale={0.2} slideNumber={1} />);
    const node = container.querySelector(".slide-cv");
    rerender(<SlideThumb slide={s} theme="light" scale={0.2} slideNumber={1} />);
    expect(container.querySelector(".slide-cv")).toBe(node);
    rerender(<SlideThumb slide={{ ...s, title: "b" }} theme="light" scale={0.2} slideNumber={1} />);
    expect(container.querySelector(".slide-cv")).toBe(node); // même DOM réutilisé, simplement mis à jour
  });
});
