import { describe, it, expect, vi, beforeEach } from "vitest";
import { plainError, plainReason, isPlainText, GENERIC_ERROR, PLAIN } from "@/lib/plain-error";
import { ApiError } from "@/lib/desktop-api";
import { LP_NOT_CONNECTED, SYSTEM_ACCOUNT_ORDER } from "@/lib/dealing-routing";

// Step 2 "foundations": the 13 server strings of the infra-leak sweep (report section 4), the step 1 codes, unknown
// errors, and the rule that nothing shown carries an infrastructure word.

const INFRA_WORDS = /engine|gateway|nats|neon|database|\bDB\b|caddy|mt5|prisma|redis|vercel|timeout|\d+\s?ms\b|HTTP|\/api\/|\(\d{3}\)|[A-Z]{2,}_[A-Z_]+/i;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the 13 server strings", () => {
  const cases: [string, unknown, string][] = [
    ["1 timeout after N ms", "timeout after 2000 ms", PLAIN.pricesUnavailable],
    ["2a HTTP status", "HTTP 502", PLAIN.couldNotLoad],
    ["2b request failed (status)", "request failed (502)", PLAIN.couldNotLoad],
    ["3 request to path failed", "request to /api/trade/orders failed (502)", PLAIN.couldNotLoad],
    ["4 request timed out", "request timed out", PLAIN.noAnswer],
    ["5 network error", "network error: connect ECONNREFUSED 10.0.0.4:3001", PLAIN.unreachable],
    ["6a stream dropped", "connection dropped after 10023 ms: reset", PLAIN.pricesInterrupted],
    ["6b stream closed", "server closed the stream (1011: overload)", PLAIN.pricesInterrupted],
    ["7a ops: url / secret", "market data URL / read secret not configured", PLAIN.pricesUnavailable],
    ["7b ops: malformed", "malformed answer (not a list)", PLAIN.pricesUnavailable],
    ["7c ops: engine unreadable", "engine unreadable", PLAIN.pricesUnavailable],
    ["7d ops: not on the VPS", "not on the VPS price source", PLAIN.pricesUnavailable],
    ["7e ops: book gate", "engine book gate: closed", PLAIN.pricesUnavailable],
    ["8 database being updated", "trading is temporarily unavailable (the database is being updated); please try again shortly", PLAIN.tradingBrief],
    ["9 price feed not configured", "price feed not configured", PLAIN.pricesUnavailable],
    ["10 internal error", "internal error", PLAIN.notProcessed],
    ["11a LP_NOT_CONNECTED", "LP_NOT_CONNECTED", "Orders can't be placed on this account right now. Contact your broker."],
    ["11b SYSTEM_ACCOUNT", { error: SYSTEM_ACCOUNT_ORDER.error, code: SYSTEM_ACCOUNT_ORDER.code }, "Orders can't be placed on this account."],
    ["11c INSUFFICIENT_MARGIN", "INSUFFICIENT_MARGIN", "Not enough free margin for this order."],
    ["11d NO_LIVE_FEED", "NO_LIVE_FEED", "No live price for this symbol right now. Try again shortly."],
    ["11e PRICE_STALE", "PRICE_STALE", "The price is out of date. Order not placed, try again."],
    ["11f BUILD_*", "BUILD_RETIRED: this installation has been retired by your broker. Install the latest version.", "This installation has been retired. Install the latest version."],
    ["11g FORBIDDEN", "FORBIDDEN", "You don't have access to this."],
    ["12 Resend", "Resend send failed (422): {\"message\":\"domain not verified\"}", PLAIN.emailNotSent],
    ["13 endpoint path + HTTP", "Could not load /api/manage/positions · HTTP 502: bad gateway", GENERIC_ERROR],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => {
      const out = plainError(input);
      expect(out).toBe(want);
      expect(out).not.toMatch(INFRA_WORDS);
    });
  }
});

describe("step 1 codes", () => {
  it("GROUP_MIN_VOLUME: client and staff wording with the minimum", () => {
    const body = { error: "The smallest trade allowed for this account is 0.10 lots.", code: "GROUP_MIN_VOLUME" };
    expect(plainError(body)).toBe("The smallest trade allowed for this account is 0.10 lots.");
    expect(plainError(body, undefined, { audience: "staff" })).toBe("Below this group's minimum volume (0.10 lots).");
    expect(plainError(new ApiError(body.error, 400, body), undefined, { audience: "staff" })).toBe("Below this group's minimum volume (0.10 lots).");
  });
  it("MIN_VOLUME_STEP lists the symbols", () => {
    const body = { error: "A minimum of 0.15 lots does not fit the volume steps of XAUUSD, EURUSD. Pick...", code: "MIN_VOLUME_STEP", symbols: ["XAUUSD", "EURUSD"] };
    expect(plainError(body, undefined, { audience: "staff" })).toBe("This minimum does not fit the volume steps of XAUUSD, EURUSD.");
  });
});

describe("codes with amounts and staff audience", () => {
  it("INSUFFICIENT_MARGIN with required / available from the body", () => {
    const err = new ApiError("INSUFFICIENT_MARGIN", 400, { error: "INSUFFICIENT_MARGIN", required: "120.00", available: "80.00" });
    expect(plainError(err)).toBe("Not enough free margin: this order needs 120.00, 80.00 is free.");
  });
  it("LP_NOT_CONNECTED for staff is the one allowed plain LP line", () => {
    expect(plainError({ error: LP_NOT_CONNECTED.error, code: LP_NOT_CONNECTED.code }, undefined, { audience: "staff" })).toBe("Not filled: the liquidity provider is disconnected.");
  });
});

describe("unknown errors", () => {
  it("raw exception text becomes the fallback, and is logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = "Invalid `prisma.position.update()` invocation: Transaction API error: P2028";
    expect(plainError(new Error(raw))).toBe(GENERIC_ERROR);
    expect(plainError(new Error(raw), "Could not close the position. Try again.")).toBe("Could not close the position. Try again.");
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c).includes("P2028"))).toBe(true);
  });
  it("an unknown machine code, a cuid, JSON, a stack line and nothing at all all become the fallback", () => {
    for (const raw of ["SOME_NEW_CODE", "Rule cm1x2y3z4a5b6c7d8e9f0g1h2: broken", '{"error":"x"}', "TypeError: x is undefined", "", null, undefined]) {
      expect(plainError(raw, "Fallback.")).toBe("Fallback.");
    }
  });
  it("status-only failures: 401 / 403 / 429 get their own sentence", () => {
    expect(plainError(new ApiError("request to /api/x failed (401)", 401))).toBe("Your session has ended. Sign in again.");
    expect(plainError(new ApiError("", 429))).toBe("Too many requests. Wait a moment and try again.");
  });
  it("an app-written sentence passes, first letter capitalised", () => {
    expect(plainError("volume must be 0.01 plus a multiple of 0.01")).toBe("Volume must be 0.01 plus a multiple of 0.01");
    expect(plainError(new ApiError("Trading is halted for this group", 400))).toBe("Trading is halted for this group");
    expect(isPlainText("Market is closed")).toBe(true);
    expect(isPlainText("timeout after 2000 ms")).toBe(false);
  });
  it("plainReason (server side) defaults to 'Could not be processed.'", () => {
    expect(plainReason(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(PLAIN.unreachable);
    expect(plainReason(new Error("Unique constraint failed on the fields: (`id`)"))).toBe(PLAIN.notProcessed);
    expect(plainReason(new Error("{\"x\":1}"))).toBe(PLAIN.notProcessed);
  });
});
