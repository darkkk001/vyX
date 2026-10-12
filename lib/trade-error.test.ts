import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TRADE_TEXT, tradeActionError } from "@/lib/plain-error";

class ApiErr extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("tradeActionError: the three sentences a failed order, close or modify can show", () => {
  it("no or stale price -> Prices unavailable, try again", () => {
    quiet();
    expect(tradeActionError(new ApiErr("NO_LIVE_FEED", 503, { error: "NO_LIVE_FEED" }))).toBe(TRADE_TEXT.prices);
    expect(tradeActionError(new ApiErr("PRICE_STALE", 400, { error: "PRICE_STALE" }))).toBe(TRADE_TEXT.prices);
    expect(tradeActionError(new ApiErr("EURUSD: no live feed", 0))).toBe(TRADE_TEXT.prices);
    expect(tradeActionError(new ApiErr("Live prices unavailable.", 503))).toBe(TRADE_TEXT.prices);
  });
  it("business refusals -> Order rejected: <reason>", () => {
    quiet();
    expect(tradeActionError(new ApiErr("INSUFFICIENT_MARGIN", 400, { error: "INSUFFICIENT_MARGIN", required: "10.00", available: "2.00" }))).toBe(
      "Order rejected: Not enough free margin: this order needs 10.00, 2.00 is free"
    );
    expect(tradeActionError(new ApiErr("MARKET_CLOSED", 400, { error: "MARKET_CLOSED" }))).toBe("Order rejected: The market is closed for this symbol");
    expect(tradeActionError(new ApiErr("SLIPPAGE_EXCEEDED", 400, { error: "SLIPPAGE_EXCEEDED" }))).toBe("Order rejected: The price moved. Order not placed");
    expect(tradeActionError(new ApiErr("Trading is disabled for this account.", 403, { error: "Trading is disabled for this account." }))).toBe(
      "Order rejected: Trading is disabled for this account"
    );
    expect(tradeActionError(new ApiErr("Volume must be between 0.01 and 100.", 400))).toBe("Order rejected: Volume must be between 0.01 and 100");
  });
  it("5xx, network failures and timeouts -> Server error, try again", () => {
    quiet();
    expect(tradeActionError(new ApiErr("Could not complete the request. Try again.", 500))).toBe(TRADE_TEXT.server);
    expect(tradeActionError(new ApiErr("Invalid `prisma.$queryRaw()` invocation: deadlock detected", 500, { error: "x" }))).toBe(TRADE_TEXT.server);
    expect(tradeActionError(new ApiErr("Internal Server Error", 502))).toBe(TRADE_TEXT.server);
    expect(tradeActionError(new TypeError("Failed to fetch"))).toBe(TRADE_TEXT.server);
    expect(tradeActionError("timed out")).toBe(TRADE_TEXT.server);
    expect(tradeActionError(null)).toBe(TRADE_TEXT.server);
  });
  it("a 4xx with nothing showable is still never the generic read fallback", () => {
    quiet();
    expect(tradeActionError(new ApiErr("Could not complete the request. Try again.", 400))).toBe(TRADE_TEXT.server);
    expect(tradeActionError(new ApiErr("Could not load. Try again.", 400))).toBe(TRADE_TEXT.server);
  });
  it("a signed-out session says so instead of 'Order rejected'", () => {
    quiet();
    expect(tradeActionError(new ApiErr("Your session has ended. Sign in again.", 401))).toBe("Your session has ended. Sign in again.");
  });
  it("logs status, code, raw message and request id to the console", () => {
    const spy = quiet();
    tradeActionError(new ApiErr("INSUFFICIENT_MARGIN", 400, { error: "INSUFFICIENT_MARGIN", code: "INSUFFICIENT_MARGIN", requestId: "req-1" }));
    const logged = String(spy.mock.calls.at(-1)?.[1]);
    expect(logged).toContain('"status":400');
    expect(logged).toContain("INSUFFICIENT_MARGIN");
    expect(logged).toContain("req-1");
  });
  it("never returns 'Could not load' for any status / code / message combination", () => {
    quiet();
    const statuses = [0, 400, 401, 403, 404, 409, 429, 500, 502, 503];
    const messages = ["", "Could not load. Try again.", "request failed (500)", "HTTP 502", "request to /api/trade/orders failed (502)", "Internal Server Error", "boom", "PRICE_STALE", "RATE_LIMITED", "Failed to fetch"];
    for (const status of statuses) for (const m of messages) {
      const out = tradeActionError(new ApiErr(m, status, { error: m }));
      expect(out).not.toMatch(/could not load/i);
    }
  });
});

describe("guard: no order, close or modify path in the WebTrader can show 'Could not load'", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const trade = /"(Order not placed|Smart order not placed|Could not (answer the requote|close|reverse|save the change|cancel the order|place))[^"]*"/;
  for (const file of ["components/webtrader/WebTrader.tsx", "components/webtrader/SmartTradeManager.tsx"]) {
    it(`${file}: trade error sites use tradeActionError, not plainError with a read-style fallback`, () => {
      const offenders = read(file).split("\n").filter((l) => /plainError\(/.test(l) && trade.test(l));
      expect(offenders).toEqual([]);
    });
  }
  it("the shared trade error handler goes through tradeActionError and the order cancel button has a catch", () => {
    const src = read("components/webtrader/WebTrader.tsx");
    expect(src).toMatch(/const text = tradeActionError\(err\)/);
    expect(src).toMatch(/tradeApi\.cancelOrder\(o\.id\)\.then\(refreshOrders\)\.catch\(/);
  });
});
