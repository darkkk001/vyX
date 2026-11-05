import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkSymbolTradingMode } from "@/lib/risk";
import { clientReasonFor } from "@/lib/client-reason";

// Symbols tab (2026-11-04): TradingMode CLOSE_ONLY. No new positions on the symbol, closes stay allowed.
describe("CLOSE_ONLY", () => {
  it("refuses opening on either side, with a reason the client maps to trading disabled", () => {
    for (const side of ["BUY", "SELL"] as const) {
      const reason = checkSymbolTradingMode("CLOSE_ONLY", side);
      expect(reason).toContain("close-only");
      expect(clientReasonFor({ error: reason })).toBe("TRADING_DISABLED");
    }
  });

  it("the other modes behave as before", () => {
    expect(checkSymbolTradingMode("BOTH", "BUY")).toBeNull();
    expect(checkSymbolTradingMode("BUY_ONLY", "SELL")).not.toBeNull();
    expect(checkSymbolTradingMode("SELL_ONLY", "SELL")).toBeNull();
  });

  it("closes never call the mode check: only order paths that open a position do", () => {
    const root = process.cwd();
    const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
    // the close paths: trader close, manager close, close-by, bulk close, partial close, stop-out
    for (const rel of [
      "app/api/trade/positions/[id]/close/route.ts",
      "app/api/manage/positions/[id]/close/route.ts",
      "lib/position-actions.ts",
      "lib/close-by.ts",
      "lib/bulk-close.ts",
    ]) {
      expect(read(rel), rel).not.toContain("checkSymbolTradingMode");
    }
    // the open paths all refuse through it
    for (const rel of ["app/api/trade/orders/route.ts", "lib/staff-order.ts", "lib/pending-trigger.ts", "lib/mirror.ts"]) {
      expect(read(rel), rel).toContain("checkSymbolTradingMode");
    }
  });
});
