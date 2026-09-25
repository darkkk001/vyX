import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// FX age limit (2026-09-25): a conversion quote older than 72 h is NO price (refuse), never a stale rate. The Neon
// fallback on a VPS outage is 10+ days old since the S5 move; a normal weekend (~49 h) must still convert.
const rows = new Map<string, { symbol: string; bid: Prisma.Decimal; ask: Prisma.Decimal; tickAt: Date; updatedAt: Date }>();
vi.mock("@/lib/live-price", () => ({ getLivePriceRows: vi.fn(async () => rows) }));

import { FX_RATE_MAX_AGE_MS, FxRateUnavailableError, quoteToAccountRate } from "@/lib/fx";

const D = (v: string) => new Prisma.Decimal(v);
function quoteAged(symbol: string, bid: string, ask: string, ageMs: number) {
  rows.clear();
  const at = new Date(Date.now() - ageMs);
  rows.set(symbol, { symbol, bid: D(bid), ask: D(ask), tickAt: at, updatedAt: at });
}
const db = {} as never;

describe("FX conversion age limit", () => {
  it("is 72 hours", () => {
    expect(FX_RATE_MAX_AGE_MS).toBe(72 * 3600 * 1000);
  });

  it("converts with a fresh quote and with a weekend-old one (~49 h)", async () => {
    quoteAged("EURUSD", "1.08000", "1.08020", 60_000);
    expect((await quoteToAccountRate(db, "EUR", "USD")).toString()).toBe("1.0801");
    quoteAged("EURUSD", "1.08000", "1.08020", 49 * 3600 * 1000);
    expect((await quoteToAccountRate(db, "EUR", "USD")).toString()).toBe("1.0801");
  });

  it("refuses a quote older than 72 h (the stale Neon fallback): no rate, never a 10-day-old conversion", async () => {
    quoteAged("EURUSD", "1.08000", "1.08020", 10 * 24 * 3600 * 1000);
    await expect(quoteToAccountRate(db, "EUR", "USD")).rejects.toBeInstanceOf(FxRateUnavailableError);
    quoteAged("EURUSD", "1.08000", "1.08020", 72 * 3600 * 1000 + 1000);
    await expect(quoteToAccountRate(db, "EUR", "USD")).rejects.toBeInstanceOf(FxRateUnavailableError);
  });

  it("the same currency needs no quote at all, however old the book is", async () => {
    rows.clear();
    expect((await quoteToAccountRate(db, "USD", "USD")).toString()).toBe("1");
  });
});
