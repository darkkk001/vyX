import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { hedgeExposure, hedgeOutcome } from "@/lib/hedge-view";

const D = (v: string) => new Prisma.Decimal(v);
const intent = (status: "PENDING" | "CLAIMED" | "DONE" | "ERROR", volume = "1", side: "BUY" | "SELL" = "BUY", clientPrice: string | null = "2400") => ({
  status,
  volume: D(volume),
  side,
  clientPrice: clientPrice === null ? null : D(clientPrice),
});
const leg = (status: "ROUTED" | "FILLED" | "ESCALATED", filled: string, avg = "0") => ({ status, filledVolume: D(filled), avgPrice: D(avg) });

describe("hedgeOutcome: plain outcomes from the legs", () => {
  it("waiting while unclaimed, claimed, or a leg is still on its way", () => {
    expect(hedgeOutcome(intent("PENDING"), []).outcome).toBe("WAITING");
    expect(hedgeOutcome(intent("CLAIMED"), [leg("ROUTED", "0")]).outcome).toBe("WAITING");
    expect(hedgeOutcome(intent("DONE"), [leg("FILLED", "0.5", "2400"), leg("ROUTED", "0")]).outcome).toBe("WAITING");
  });

  it("hedged, partly hedged, not hedged by filled lots; set aside = needs attention", () => {
    expect(hedgeOutcome(intent("DONE"), [leg("FILLED", "0.6", "2400"), leg("FILLED", "0.4", "2401")]).outcome).toBe("HEDGED");
    expect(hedgeOutcome(intent("DONE"), [leg("ESCALATED", "0.3", "2400")]).outcome).toBe("PART_HEDGED");
    expect(hedgeOutcome(intent("DONE"), [leg("ESCALATED", "0")]).outcome).toBe("NOT_HEDGED");
    expect(hedgeOutcome(intent("ERROR"), []).outcome).toBe("NEEDS_ATTENTION");
  });

  it("LP price is volume weighted across legs; slippage is positive in the broker's favour", () => {
    const buy = hedgeOutcome(intent("DONE", "1", "BUY", "2400.50"), [leg("FILLED", "0.6", "2400"), leg("FILLED", "0.4", "2401")]);
    expect([buy.lpPrice?.toString(), buy.slippage?.toString(), buy.filled.toString()]).toEqual(["2400.4", "0.1", "1"]);
    const sell = hedgeOutcome(intent("DONE", "1", "SELL", "2400"), [leg("FILLED", "1", "2399.7")]);
    expect(sell.slippage?.toString()).toBe("-0.3");
    expect(hedgeOutcome(intent("DONE", "1", "BUY", null), [leg("FILLED", "1", "2400")]).slippage).toBeNull();
    expect(hedgeOutcome(intent("DONE"), [leg("ESCALATED", "0")]).lpPrice).toBeNull();
  });
});

describe("hedgeExposure: clients against LPs, per symbol", () => {
  it("unhedged = client net - LP net; fully hedged symbols show 0; symbols with nothing are left out", () => {
    const e = hedgeExposure(
      [
        { symbol: "XAUUSD", net: D("1.50") },
        { symbol: "EURUSD", net: D("-2") },
        { symbol: "GBPUSD", net: D("0") },
      ],
      [
        { symbol: "XAUUSD", net: D("1.20") },
        { symbol: "EURUSD", net: D("-2") },
      ]
    );
    expect(e).toEqual([
      { symbol: "EURUSD", clientNetLots: "-2", hedgedNetLots: "-2", unhedgedLots: "0" },
      { symbol: "XAUUSD", clientNetLots: "1.5", hedgedNetLots: "1.2", unhedgedLots: "0.3" },
    ]);
  });

  it("an open never hedged and then closed: the clients net to zero, the LP's leftover shows as unhedged", () => {
    // OPEN BUY 1 escalated (LP filled 0), CLOSE SELL 1 hedged (LP filled -1): the LP is short 1 nobody asked for
    expect(hedgeExposure([], [{ symbol: "XAUUSD", net: D("-1") }])).toEqual([{ symbol: "XAUUSD", clientNetLots: "0", hedgedNetLots: "-1", unhedgedLots: "1" }]);
  });
});
