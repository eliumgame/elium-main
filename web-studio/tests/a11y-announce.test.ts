// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { announce } from "../src/ui/announce";
import { describeCell, installA11yEnhancers } from "../src/ui/a11y-enhancers";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("describeCell", () => {
  it("distingue vide, valeur et formule", () => {
    expect(describeCell("B3", "")).toBe("Cellule B3, vide");
    expect(describeCell("B3", " 42 ")).toBe("Cellule B3 : 42");
    expect(describeCell("B3", "=SUM(A1:A2)")).toBe("Cellule B3, formule =SUM(A1:A2)");
    expect(describeCell("A1", "x".repeat(300)).length).toBeLessThan(160);
  });
});

describe("announce", () => {
  it("écrit dans une région aria-live unique et relit deux messages identiques", () => {
    vi.useFakeTimers();
    announce("Page 2 sur 10");
    vi.advanceTimersByTime(50);
    const region = document.querySelector('[aria-live="polite"]')!;
    expect(region.textContent).toBe("Page 2 sur 10");
    announce("Page 2 sur 10");
    expect(region.textContent).toBe(""); // vidé puis réécrit : relu par le lecteur d'écran
    vi.advanceTimersByTime(50);
    expect(region.textContent).toBe("Page 2 sur 10");
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    announce("Erreur", "assertive");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe("installA11yEnhancers", () => {
  it("annonce la cellule active quand la référence change", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<span class="sheet-formula__ref">A1</span><input class="sheet-formula__input" value="12" />';
    const stop = installA11yEnhancers(document);
    document.querySelector(".sheet-formula__ref")!.textContent = "B2";
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe("Cellule B2 : 12");
    stop();
  });
});
