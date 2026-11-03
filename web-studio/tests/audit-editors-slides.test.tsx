import { useLocalSheetStore } from "../src/sheet/useLocalSheetStore";
import SlideCanvas from "../src/slides/canvas";
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook, cleanup, render, fireEvent } from "@testing-library/react";
import { useLocalDeckStore } from "../src/slides/useLocalDeckStore";
import { emptyDeck, emptySlide, type Deck } from "../src/slides/model";
import { sanitizeSlideHtml } from "../src/slides/sanitize";
import { deckToPptx } from "../src/slides/pptx";
import { importPptx } from "../src/slides/pptx-import";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn().mockResolvedValue(1) }));
vi.mock("../src/slides/deck-store", () => ({ loadDeck: mocks.load, saveDeck: mocks.save }));
const sheetMocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn().mockResolvedValue(1) }));
vi.mock("../src/sheet/sheet-store", () => ({ loadWorkbook: sheetMocks.load, saveWorkbook: sheetMocks.save }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("audit F présentations", () => {
  it("also protects the sheet autosave while a workbook is loading", async () => {
    vi.useFakeTimers();
    sheetMocks.load.mockReturnValue(new Promise(() => {}));
    const { result, unmount } = renderHook(() => useLocalSheetStore(undefined, { id: "existing" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
      await result.current.flush();
    });
    unmount();
    expect(sheetMocks.save).not.toHaveBeenCalled();
  });
  it("does not save before slow hydration, including flush and unmount", async () => {
    vi.useFakeTimers();
    let resolve!: (d: Deck) => void;
    mocks.load.mockReturnValue(
      new Promise<Deck>((r) => {
        resolve = r;
      }),
    );
    const { result, unmount } = renderHook(() => useLocalDeckStore(undefined, undefined, { id: "existing" }));
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
      await result.current.flush();
    });
    expect(mocks.save).not.toHaveBeenCalled();
    unmount();
    await act(async () => {
      resolve(emptyDeck());
      await Promise.resolve();
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("saves the hydrated deck after a slow successful read", async () => {
    vi.useFakeTimers();
    let resolve!: (d: Deck) => void;
    mocks.load.mockReturnValue(
      new Promise<Deck>((r) => {
        resolve = r;
      }),
    );
    const { result } = renderHook(() => useLocalDeckStore());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    const deck = { ...emptyDeck(), slides: [emptySlide(), emptySlide()] };
    await act(async () => {
      resolve(deck);
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocks.save.mock.calls[0][0].slides).toHaveLength(2);
  });
  it("navigation cannot evict edits from undo history", () => {
    const { result } = renderHook(() => useLocalDeckStore({ ...emptyDeck(), slides: [emptySlide(), emptySlide()] }));
    act(() => result.current.addEl({ id: "text", type: "text", html: "before", x: 0, y: 0, w: 10, h: 10 }));
    act(() => result.current.beginChange());
    act(() => result.current.updateEl("text", { html: "after" }, false));
    act(() => {
      for (let i = 0; i < 120; i++) result.current.setActive(i % 2);
    });
    act(() => result.current.undo?.());
    expect(result.current.deck.slides[0].elements?.find((e) => e.id === "text")?.html).toBe("before");
  });
  it("creates a text-edit checkpoint on double click and keyboard entry", () => {
    const begin = vi.fn();
    const slide = {
      ...emptySlide(),
      elements: [{ id: "text", type: "text" as const, html: "before", x: 0, y: 0, w: 10, h: 10 }],
    };
    const { container, unmount } = render(
      <SlideCanvas
        slide={slide}
        elements={slide.elements}
        theme="light"
        scale={1}
        editable
        selectedIds={["text"]}
        onBeginChange={begin}
      />,
    );
    fireEvent.doubleClick(container.querySelector(".ce--text")!);
    expect(begin).toHaveBeenCalledTimes(1);
    unmount();
    const second = render(
      <SlideCanvas
        slide={slide}
        elements={slide.elements}
        theme="light"
        scale={1}
        editable
        selectedIds={["text"]}
        onBeginChange={begin}
      />,
    );
    fireEvent.keyDown(second.container.querySelector(".slide-cv")!, { key: "F2" });
    expect(begin).toHaveBeenCalledTimes(2);
  });
  it("removes forms, controls, application classes and active URLs", () => {
    const html = sanitizeSlideHtml(
      '<form action="https://example.org"><input type=password><button class="elx-btn">OK</button></form><p><b>safe</b><a href="javascript:alert(1)">link</a></p>',
    );
    expect(html).not.toMatch(/<(form|input|button)|action=|class=|javascript:/);
    expect(html).toContain("<b>safe</b>");
  });
  it("warns when a PPTX chart loses additional series", () => {
    const deck = {
      ...emptyDeck(),
      slides: [
        {
          ...emptySlide(),
          elements: [
            {
              id: "chart",
              type: "chart" as const,
              x: 0,
              y: 0,
              w: 50,
              h: 50,
              chart: { kind: "bar" as const, labels: ["A"], values: [2] },
            },
          ],
        },
      ],
    };
    const zip = unzipSync(deckToPptx(deck));
    const path = Object.keys(zip).find((p) => p.startsWith("ppt/charts/") && p.endsWith(".xml"))!;
    const xml = strFromU8(zip[path]);
    const ser = xml.match(/<c:ser\b[\s\S]*?<\/c:ser>/)![0];
    zip[path] = strToU8(xml.replace(ser, ser + ser));
    const warn = vi.fn();
    importPptx(zipSync(zip), warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("multi-séries"));
  });
});
