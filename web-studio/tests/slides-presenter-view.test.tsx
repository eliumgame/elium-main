// @vitest-environment jsdom
/**
 * Basic sync coverage for PresenterView: it renders purely from
 * BroadcastChannel messages (see presenter-sync.ts) and posts navigation
 * intents back — this exercises that contract without a real 2nd window.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PresenterView from "../src/slides/PresenterView";
import { PRESENTER_CHANNEL, type PresenterMsg } from "../src/slides/presenter-sync";
import type { Slide } from "../src/slides/model";

afterEach(cleanup);

// jsdom has no ResizeObserver — PresenterView only uses it to scale the
// mirrored slide canvas to its container, irrelevant to the sync behaviour tested here.
beforeEach(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function slide(id: string, notes?: string): Slide {
  return {
    id,
    title: "",
    body: "",
    bodyHtml: "",
    layout: "blank",
    elements: [{ id: `${id}-t`, type: "text", x: 10, y: 10, w: 80, h: 20, html: `<p>${id}</p>`, fontSize: 24 }],
    ...(notes ? { notes } : {}),
  };
}

describe("PresenterView (component)", () => {
  it("shows a waiting placeholder before any deck message arrives", () => {
    render(<PresenterView />);
    expect(screen.getByText(/En attente de la présentation/)).toBeTruthy();
  });

  it("renders the current slide, title and position once synced", async () => {
    render(<PresenterView />);
    const bc = new BroadcastChannel(PRESENTER_CHANNEL);
    bc.postMessage({
      type: "deck",
      slides: [slide("s1", "Notes de la diapo 1"), slide("s2")],
      theme: "light",
      title: "Ma présentation",
    } as PresenterMsg);
    bc.postMessage({ type: "pos", idx: 0, step: 0, startedAt: Date.now(), presenting: true } as PresenterMsg);

    await waitFor(() => expect(screen.getByText("Ma présentation")).toBeTruthy());
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByText("Notes de la diapo 1")).toBeTruthy();
    bc.close();
  });

  it("shows the end banner once the main window reports the presentation over", async () => {
    render(<PresenterView />);
    const bc = new BroadcastChannel(PRESENTER_CHANNEL);
    bc.postMessage({ type: "deck", slides: [slide("s1")], theme: "light", title: "T" } as PresenterMsg);
    bc.postMessage({ type: "pos", idx: 0, step: 0, startedAt: Date.now(), presenting: true } as PresenterMsg);
    await waitFor(() => expect(screen.getByText("T")).toBeTruthy());

    bc.postMessage({ type: "end" } as PresenterMsg);
    await waitFor(() => expect(screen.getByText(/Présentation terminée/)).toBeTruthy());
    bc.close();
  });

  it("posts a 'nav next' intent on ArrowRight and 'nav prev' on ArrowLeft", async () => {
    render(<PresenterView />);
    const bc = new BroadcastChannel(PRESENTER_CHANNEL);
    const received: PresenterMsg[] = [];
    bc.onmessage = (e: MessageEvent) => received.push(e.data as PresenterMsg);
    bc.postMessage({ type: "deck", slides: [slide("s1"), slide("s2")], theme: "light", title: "T" } as PresenterMsg);
    bc.postMessage({ type: "pos", idx: 0, step: 0, startedAt: Date.now(), presenting: true } as PresenterMsg);
    await waitFor(() => expect(screen.getByText("T")).toBeTruthy());

    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(received.filter((m) => m.type === "nav")).toHaveLength(2));
    expect(received.find((m) => m.type === "nav" && m.dir === "next")).toBeTruthy();
    expect(received.find((m) => m.type === "nav" && m.dir === "prev")).toBeTruthy();
    bc.close();
  });

  it("clicking the next-slide button in the controls also posts a nav intent", async () => {
    render(<PresenterView />);
    const bc = new BroadcastChannel(PRESENTER_CHANNEL);
    const received: PresenterMsg[] = [];
    bc.onmessage = (e: MessageEvent) => received.push(e.data as PresenterMsg);
    bc.postMessage({ type: "deck", slides: [slide("s1"), slide("s2")], theme: "light", title: "T" } as PresenterMsg);
    bc.postMessage({ type: "pos", idx: 0, step: 0, startedAt: Date.now(), presenting: true } as PresenterMsg);
    await waitFor(() => expect(screen.getByText("T")).toBeTruthy());

    await userEvent.click(screen.getByTitle("Suivant"));
    await waitFor(() => expect(received.some((m) => m.type === "nav" && m.dir === "next")).toBe(true));
    bc.close();
  });
});
