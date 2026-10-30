/** Tickets WebSocket à usage unique (CLIENT-10) : usage unique, expiration, liaison à la cible. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  issueWsTicket,
  consumeWsTicket,
  _resetWsTicketsForTests,
  WS_TICKET_TTL_SECONDS,
} from "../src/lib/ws-tickets.js";

const P = { sub: "u1", fpr: "f", iat: 1, exp: 9999999999 };

beforeEach(() => _resetWsTicketsForTests());
afterEach(() => vi.useRealTimers());

describe("ws-tickets", () => {
  it("est à usage unique", async () => {
    const { ticket } = await issueWsTicket(P);
    expect(await consumeWsTicket(ticket, "collab:x")).toMatchObject({ sub: "u1" });
    expect(await consumeWsTicket(ticket, "collab:x")).toBeNull();
  });
  it("expire après 30 s", async () => {
    vi.useFakeTimers();
    const { ticket } = await issueWsTicket(P);
    vi.advanceTimersByTime((WS_TICKET_TTL_SECONDS + 1) * 1000);
    expect(await consumeWsTicket(ticket, "collab:x")).toBeNull();
  });
  it("lié à sa cible : un ticket collab ne sert pas pour events, et il est brûlé", async () => {
    const { ticket } = await issueWsTicket({ ...P, target: "collab:aaa" });
    expect(await consumeWsTicket(ticket, "events:aaa")).toBeNull();
    expect(await consumeWsTicket(ticket, "collab:aaa")).toBeNull();
    const t2 = await issueWsTicket({ ...P, target: "collab:aaa" });
    expect(await consumeWsTicket(t2.ticket, "collab:aaa")).not.toBeNull();
  });
  it("refuse un ticket inconnu ou vide", async () => {
    expect(await consumeWsTicket("", "collab:x")).toBeNull();
    expect(await consumeWsTicket("nope", "collab:x")).toBeNull();
  });
});
