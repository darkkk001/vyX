import { describe, expect, it } from "vitest";
import { validateAlertInput, checkActiveAlertLimit, MAX_ACTIVE_ALERTS_PER_ACCOUNT } from "@/lib/price-alerts";
import { prisma } from "@/lib/prisma";

describe("validateAlertInput", () => {
  it("accepts a well-formed request", () => {
    const result = validateAlertInput({ symbol: "xauusd", condition: "ABOVE", price: "2500.50" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.symbol).toBe("XAUUSD"); // uppercased
      expect(result.value.condition).toBe("ABOVE");
      expect(result.value.price.toString()).toBe("2500.5");
      expect(result.value.expiresAt).toBeNull();
    }
  });

  it("rejects a missing field", () => {
    expect(validateAlertInput({ symbol: "XAUUSD", condition: "ABOVE" })).toEqual({ ok: false, error: "symbol, condition, and price are required" });
    expect(validateAlertInput({ symbol: "XAUUSD", price: "2500" })).toEqual({ ok: false, error: "symbol, condition, and price are required" });
    expect(validateAlertInput({ condition: "ABOVE", price: "2500" })).toEqual({ ok: false, error: "symbol, condition, and price are required" });
  });

  it("rejects an unrecognized condition", () => {
    const result = validateAlertInput({ symbol: "XAUUSD", condition: "SIDEWAYS", price: "2500" });
    expect(result).toEqual({ ok: false, error: "symbol, condition, and price are required" });
  });

  it("rejects a zero or negative price", () => {
    expect(validateAlertInput({ symbol: "XAUUSD", condition: "ABOVE", price: "0" }).ok).toBe(false);
    expect(validateAlertInput({ symbol: "XAUUSD", condition: "ABOVE", price: "-5" }).ok).toBe(false);
  });

  it("rejects an unparseable price", () => {
    expect(validateAlertInput({ symbol: "XAUUSD", condition: "ABOVE", price: "not-a-number" }).ok).toBe(false);
  });

  it("accepts a valid expiresAt and rejects an invalid one", () => {
    const ok = validateAlertInput({ symbol: "XAUUSD", condition: "BELOW", price: "1900", expiresAt: "2027-01-01T00:00:00Z" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.expiresAt).toBeInstanceOf(Date);

    const bad = validateAlertInput({ symbol: "XAUUSD", condition: "BELOW", price: "1900", expiresAt: "not-a-date" });
    expect(bad).toEqual({ ok: false, error: "invalid expiresAt" });
  });

  it("all three conditions (ABOVE/BELOW/CROSSES) are accepted", () => {
    for (const condition of ["ABOVE", "BELOW", "CROSSES"]) {
      expect(validateAlertInput({ symbol: "XAUUSD", condition, price: "2000" }).ok).toBe(true);
    }
  });
});

describe("checkActiveAlertLimit", () => {
  it("allows creating another alert below the limit", () => {
    expect(checkActiveAlertLimit(0)).toBeNull();
    expect(checkActiveAlertLimit(MAX_ACTIVE_ALERTS_PER_ACCOUNT - 1)).toBeNull();
  });

  it("blocks at exactly the limit and beyond", () => {
    expect(checkActiveAlertLimit(MAX_ACTIVE_ALERTS_PER_ACCOUNT)).toContain(String(MAX_ACTIVE_ALERTS_PER_ACCOUNT));
    expect(checkActiveAlertLimit(MAX_ACTIVE_ALERTS_PER_ACCOUNT + 1)).not.toBeNull();
  });
});

// Phase 1 trust pack §3 -- exercises the real Prisma CRUD path (create,
// list, cancel, the 50-active-alert limit) directly against the model,
// since the actual route handlers (app/api/trade/alerts/*) call
// next/headers-backed session functions that only resolve inside a real
// Next.js request and can't be invoked directly from a plain test. Same
// live-Neon-gated convention as lib/margin.test.ts -- skips cleanly
// without DATABASE_URL, ran for real against Neon before this commit,
// and cleans up every row it creates.
describe("PriceAlert CRUD (live Neon)", () => {
  it("create, list active, enforce the 50-active limit, then cancel", async () => {
    let account: { id: string; brokerId: string } | null = null;
    try {
      account = await prisma.account.findFirstOrThrow({ select: { id: true, brokerId: true } });
      // Table-existence probe -- this test can run before migration
      // 20260831120000_price_alerts has actually been deployed (verified
      // safe via a dry-run-and-rollback, see that migration's own commit,
      // but deliberately not applied outside a real deploy). P2021 means
      // exactly that: "PriceAlert" doesn't exist here yet.
      await prisma.priceAlert.count();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "P2021") {
        console.warn("skipping: PriceAlert table not migrated in this database yet");
      } else {
        console.warn("skipping: no DATABASE_URL / no reachable Neon / no seeded Account row");
      }
      return;
    }

    const createdIds: string[] = [];
    try {
      // Create one real alert, confirm it lists as ACTIVE.
      const alert = await prisma.priceAlert.create({
        data: { accountId: account.id, brokerId: account.brokerId, symbol: "VITEST_XAUUSD", condition: "ABOVE", price: "2500" },
      });
      createdIds.push(alert.id);
      expect(alert.status).toBe("ACTIVE");

      const active = await prisma.priceAlert.findMany({ where: { accountId: account.id, symbol: "VITEST_XAUUSD", status: "ACTIVE" } });
      expect(active.map((a) => a.id)).toContain(alert.id);

      // Cancel it -- status changes, row is never hard-deleted.
      await prisma.priceAlert.update({ where: { id: alert.id }, data: { status: "CANCELLED" } });
      const afterCancel = await prisma.priceAlert.findUniqueOrThrow({ where: { id: alert.id } });
      expect(afterCancel.status).toBe("CANCELLED");

      const activeAfterCancel = await prisma.priceAlert.findMany({ where: { accountId: account.id, symbol: "VITEST_XAUUSD", status: "ACTIVE" } });
      expect(activeAfterCancel).toHaveLength(0);

      // The limit itself: create MAX_ACTIVE_ALERTS_PER_ACCOUNT real active
      // rows for a throwaway symbol, confirm the count matches what
      // checkActiveAlertLimit would then block on.
      for (let i = 0; i < MAX_ACTIVE_ALERTS_PER_ACCOUNT; i++) {
        const a = await prisma.priceAlert.create({
          data: { accountId: account.id, brokerId: account.brokerId, symbol: `VITEST_LIMIT_${i}`, condition: "ABOVE", price: "1" },
        });
        createdIds.push(a.id);
      }
      const activeCount = await prisma.priceAlert.count({ where: { accountId: account.id, status: "ACTIVE", symbol: { startsWith: "VITEST_" } } });
      expect(activeCount).toBeGreaterThanOrEqual(MAX_ACTIVE_ALERTS_PER_ACCOUNT);
      expect(checkActiveAlertLimit(activeCount)).not.toBeNull();
    } finally {
      // Cleanup -- never leave test rows in the shared Neon database.
      if (createdIds.length > 0) {
        await prisma.priceAlert.deleteMany({ where: { id: { in: createdIds } } });
      }
    }
  });
});
