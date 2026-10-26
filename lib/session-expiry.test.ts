import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSessionExpiry, isUnauthorized } from "@/lib/session-expiry";
import { ApiError } from "@/lib/trade-api";

// Owner 2026-10-26: an expired demo.qoretrader.com WebTrader tab kept polling /api/trade/orders and /positions every
// 4 s, each answer a 401, because the polls swallowed every error. The first 401 now ends the polling and shows login.
describe("createSessionExpiry", () => {
  it("the first 401 expires the session once; later 401s change nothing", () => {
    const onExpire = vi.fn();
    const s = createSessionExpiry(onExpire);
    expect(s.expired()).toBe(false);
    expect(s.onPollError([])(new ApiError("not authenticated", 401))).toEqual([]);
    expect(s.onPollError([])(new ApiError("not authenticated", 401))).toEqual([]);
    expect(s.expired()).toBe(true);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
  it("any other failure is a blip: the poll keeps its fallback and the session stays", () => {
    const onExpire = vi.fn();
    const s = createSessionExpiry(onExpire);
    for (const err of [new ApiError("x", 500), new ApiError("x", 503), new ApiError("x", 403), new TypeError("Failed to fetch"), undefined]) {
      expect(s.onPollError(["kept"])(err)).toEqual(["kept"]);
    }
    expect(s.expired()).toBe(false);
    expect(onExpire).not.toHaveBeenCalled();
  });
  it("isUnauthorized reads the status of any error that carries one", () => {
    expect(isUnauthorized(new ApiError("x", 401))).toBe(true);
    expect(isUnauthorized({ status: 401 })).toBe(true);
    expect(isUnauthorized(new ApiError("x", 400))).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
  });
});

// WebTrader has no DOM test harness: its polls are pinned by source, like lib/trade-error.test.ts does.
describe("WebTrader polls stop on a 401", () => {
  const src = readFileSync(path.join(__dirname, "..", "components", "webtrader", "WebTrader.tsx"), "utf8");
  it("the order and position polls never swallow a 401", () => {
    expect(src).not.toMatch(/tradeApi\.(orders|allOrders|positions)\(\)\.catch\(\(\) =>/);
    for (const call of ["tradeApi.positions()", "tradeApi.orders()", "tradeApi.allOrders()"]) {
      expect(src).toContain(`${call}.catch(onPollError`);
    }
  });
  it("the poll loop sends nothing once the session expired, and a prices 401 expires it", () => {
    expect(src).toMatch(/async function poll\(\) \{\s*if \(pollSession\.expired\(\)\) return;/);
    expect(src).toMatch(/catch \(err\) \{\s*if \(err instanceof ApiError && err\.status === 401\) \{ expireSession\(\); return; \}/);
  });
});
