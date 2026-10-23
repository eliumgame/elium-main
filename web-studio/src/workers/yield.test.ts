import { describe, expect, it } from "vitest";
import { createYielder, yieldToMain } from "./yield";

describe("yield", () => {
  it("yieldToMain rend la main à la boucle d'évènements", async () => {
    const order: string[] = [];
    setTimeout(() => order.push("timer"), 0);
    await yieldToMain();
    order.push("after");
    expect(order[0]).toBe("timer");
  });
  it("createYielder ne cède qu'au-delà du budget", async () => {
    const tick = createYielder(10_000);
    let fired = false;
    setTimeout(() => (fired = true), 0);
    await tick();
    expect(fired).toBe(false);
    const eager = createYielder(0);
    await eager();
    await new Promise((r) => setTimeout(r, 1));
    expect(fired).toBe(true);
  });
});
