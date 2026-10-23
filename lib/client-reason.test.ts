import { describe, expect, it } from "vitest";
import { CLIENT_REASONS, clientReasonFor, clientRefusal, withClientRefusals } from "@/lib/client-reason";

// Two reasons (owner 2026-10-23): the internal one stays on the server, the client gets one of nine.
describe("clientReasonFor", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ error: "MARKET_CLOSED", nextOpenAt: "2026-10-25T21:00:00Z" }, "MARKET_CLOSED"],
    [{ error: "MARKET_CLOSED", reason: "NOT_QUOTING" }, "OFF_QUOTES"], // open by schedule, not quoting: never "closed"
    [{ error: "NOT_QUOTING" }, "OFF_QUOTES"],
    [{ error: "PRICE_STALE" }, "OFF_QUOTES"],
    [{ error: "NO_LIVE_FEED" }, "OFF_QUOTES"],
    [{ error: "LP_NOT_CONNECTED" }, "OFF_QUOTES"],
    [{ error: "INSUFFICIENT_MARGIN", required: "10", available: "1" }, "NOT_ENOUGH_MARGIN"],
    [{ error: "NO_CONVERSION_RATE" }, "NOT_ENOUGH_MARGIN"],
    [{ error: "SLIPPAGE_EXCEEDED" }, "INVALID_PRICE"],
    [{ error: "PRICE_CHANGED", reason: "Price changed, try again" }, "INVALID_PRICE"],
    [{ error: "price is too far from the current market price for XAUUSD" }, "INVALID_PRICE"],
    [{ error: "invalid volume", code: "INVALID_VOLUME" }, "INVALID_VOLUME"],
    [{ error: "partial close amount must be a multiple of 0.01" }, "INVALID_VOLUME"],
    [{ error: "SL must be below the reference price for a BUY" }, "INVALID_SLTP"],
    [{ error: "TP must be a positive price" }, "INVALID_SLTP"],
    [{ error: "symbol not available for this broker" }, "SYMBOL_NOT_AVAILABLE"],
    [{ error: "Trading is read-only for this account.", code: "TRADING_RIGHTS", tradingRights: "READ_ONLY" }, "TRADING_DISABLED"],
    [{ error: "TRADING_HALTED" }, "TRADING_DISABLED"],
    [{ error: "account is not active" }, "TRADING_DISABLED"],
    [{ error: "DEMO_B_BOOK_ONLY" }, "TRADING_DISABLED"],
    [{ error: "Too many orders in a short time. Wait a moment and try again.", code: "ORDER_RATE_LIMITED" }, "REJECTED"],
    [{ error: "something nobody planned for" }, "REJECTED"],
  ];
  for (const [internal, want] of cases) {
    it(`${JSON.stringify(internal)} -> ${want}`, () => expect(clientReasonFor(internal)).toBe(want));
  }
  it("always one of the nine", () => {
    for (const [internal] of cases) expect(CLIENT_REASONS).toContain(clientReasonFor(internal));
  });
});

describe("clientRefusal: what the client may see", () => {
  it("drops the internal code, sub-reason and feed timing; keeps the client's own numbers", () => {
    const out = clientRefusal({ error: "PRICE_STALE", reason: "NOT_QUOTING", symbol: "USDX", lastTickAt: "2026-10-23T10:00:00Z", lastTickAgeMs: 31000, code: "X" });
    expect(out).toEqual({ error: "Off quotes - try again", clientReason: "OFF_QUOTES", message: "Off quotes - try again" });
    const margin = clientRefusal({ error: "INSUFFICIENT_MARGIN", required: "120.00", available: "80.00", balance: "100.00" });
    expect(margin).toMatchObject({ clientReason: "NOT_ENOUGH_MARGIN", required: "120.00", available: "80.00", balance: "100.00" });
  });
  it("a schedule close keeps the MARKET_CLOSED code and its reopen time (installed terminals render both)", () => {
    expect(clientRefusal({ error: "MARKET_CLOSED", nextOpenAt: "x" })).toEqual({ error: "MARKET_CLOSED", clientReason: "MARKET_CLOSED", message: "Market closed", nextOpenAt: "x" });
    expect(clientRefusal({ error: "PRICE_STALE", nextOpenAt: "x" })).not.toHaveProperty("nextOpenAt");
  });
  it("the rate limit keeps its own plain sentence and when to retry", () => {
    expect(clientRefusal({ error: "Too many orders in a short time. Wait a moment and try again.", code: "ORDER_RATE_LIMITED", retryAfterSeconds: 2 })).toEqual({
      error: "Too many orders in a short time. Wait a moment and try again.", clientReason: "REJECTED", message: "Too many orders in a short time. Wait a moment and try again.", retryAfterSeconds: 2,
    });
  });
  it("CLOSE_PENDING is a state the client acts on: code and order id kept", () => {
    expect(clientRefusal({ error: "CLOSE_PENDING", orderId: "o1" })).toMatchObject({ error: "CLOSE_PENDING", orderId: "o1" });
  });
});

describe("withClientRefusals", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  it("rewrites a refusal and every refused row of a bulk answer; a success passes through", async () => {
    const one = await (await withClientRefusals(json(400, { error: "NOT_QUOTING", symbol: "USDX" }))).json();
    expect(one).toEqual({ error: "Off quotes - try again", clientReason: "OFF_QUOTES", message: "Off quotes - try again" });
    const bulk = await (await withClientRefusals(json(200, { requested: 2, results: [{ positionId: "a", ok: true, error: null }, { positionId: "b", ok: false, error: "MARKET_CLOSED", nextOpenAt: "t", reason: "x" }] }))).json();
    expect(bulk.results[0]).toEqual({ positionId: "a", ok: true, error: null });
    expect(bulk.results[1]).toEqual({ positionId: "b", ok: false, error: "MARKET_CLOSED", clientReason: "MARKET_CLOSED", message: "Market closed", nextOpenAt: "t" });
    const ok = json(201, { order: { id: "o" } });
    expect(await withClientRefusals(ok)).toBe(ok);
  });
  it("401 / 404 / 500 are not refusals and pass through", async () => {
    for (const s of [401, 404, 500]) {
      const r = json(s, { error: "x" });
      expect(await withClientRefusals(r)).toBe(r);
    }
  });
});
