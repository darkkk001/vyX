import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolvePricingV2, resolveEffectiveSpreadMarkup, resolveSymbolPricingV2, resolveFillPricing, type SymbolConfigLevel } from "@/lib/pricing-engine";

// Phase 2 pricing engine (docs/pricing-engine.md) -- exhaustive precedence
// coverage for resolvePricingV2 (pure, no DB) plus a handful of DB-backed
// tests proving resolveSymbolPricingV2's queries actually wire up to real
// Prisma models. Real numbers throughout, not placeholders, so a wrong
// fallthrough shows up as a wrong number, not just a wrong branch taken.
// D4 (owner: the group is the pricing tier): the account-type levels are gone -- Account > Group > broker.

const D = (v: string | number) => new Prisma.Decimal(v);

const BROKER_BASE = {
  brokerSpreadMarkup: D("3"),
  brokerCommissionPerLot: D("7"),
  brokerSwapLong: D("-2.5"),
  brokerSwapShort: D("-1.5"),
};

const EMPTY_SYMBOL_LEVEL: SymbolConfigLevel = null;

function baseParams(overrides: Partial<Parameters<typeof resolvePricingV2>[0]> = {}) {
  return {
    accountSymbolConfig: EMPTY_SYMBOL_LEVEL,
    groupSymbolConfig: EMPTY_SYMBOL_LEVEL,
    accountSwapFree: null,
    groupSwapFree: null,
    ...BROKER_BASE,
    ...overrides,
  };
}

function symbolLevel(fields: Partial<NonNullable<SymbolConfigLevel>>): NonNullable<SymbolConfigLevel> {
  return {
    spreadMarkup: null,
    targetTotalSpreadPips: null,
    commissionPerLot: null,
    swapLong: null,
    swapShort: null,
    ...fields,
  };
}

describe("resolvePricingV2 -- no overrides anywhere", () => {
  it("falls all the way through to the broker/symbol base for every field", () => {
    const r = resolvePricingV2(baseParams());
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("3") });
    expect(r.commissionPerLot.toString()).toBe("7");
    expect(r.swapLong.toString()).toBe("-2.5");
    expect(r.swapShort.toString()).toBe("-1.5");
    expect(r.swapFree).toBe(false);
  });
});

describe("resolvePricingV2 -- account > group > broker", () => {
  it("account symbol config beats group and base for all 4 numeric fields at once", () => {
    const r = resolvePricingV2(
      baseParams({
        accountSymbolConfig: symbolLevel({ spreadMarkup: D("0.1"), commissionPerLot: D("0"), swapLong: D("1"), swapShort: D("1") }),
        groupSymbolConfig: symbolLevel({ spreadMarkup: D("0.5"), commissionPerLot: D("2"), swapLong: D("-7"), swapShort: D("-7") }),
      })
    );
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("0.1") });
    expect(r.commissionPerLot.toString()).toBe("0"); // a VIP zero-commission deal, distinct from "unset"
    expect(r.swapLong.toString()).toBe("1");
    expect(r.swapShort.toString()).toBe("1");
  });

  it("no account override -> uses GroupSymbolConfig", () => {
    const r = resolvePricingV2(baseParams({ groupSymbolConfig: symbolLevel({ spreadMarkup: D("0.5"), commissionPerLot: D("2") }) }));
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("0.5") });
    expect(r.commissionPerLot.toString()).toBe("2");
  });

  it("nothing set anywhere -> uses the broker/symbol base", () => {
    const r = resolvePricingV2(baseParams());
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("3") });
    expect(r.commissionPerLot.toString()).toBe("7");
  });

  it("D4: the resolver has no account-type input at all (an old caller passing one is ignored)", () => {
    const withStray = { ...baseParams({ groupSymbolConfig: symbolLevel({ spreadMarkup: D("0.5") }) }), accountType: { spreadMarkup: D("9"), commissionPerLot: D("9"), swapLong: D("9"), swapShort: D("9"), swapFree: true } };
    const r = resolvePricingV2(withStray as Parameters<typeof resolvePricingV2>[0]);
    expect({ spread: r.spread, commission: r.commissionPerLot.toString(), swapFree: r.swapFree }).toEqual({ spread: { mode: "markup", spreadMarkup: D("0.5") }, commission: "7", swapFree: false });
  });
});

describe("resolvePricingV2 -- per-field independence (the bug this migration fixed)", () => {
  it("account sets spread only -> commission/swap fall through independently to group/base, not forced to 0", () => {
    const r = resolvePricingV2(
      baseParams({
        accountSymbolConfig: symbolLevel({ spreadMarkup: D("0.2") }),
        groupSymbolConfig: symbolLevel({ swapLong: D("-3"), swapShort: D("-3") }),
      })
    );
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("0.2") });
    expect(r.commissionPerLot.toString()).toBe("7");
    expect(r.swapLong.toString()).toBe("-3");
    expect(r.swapShort.toString()).toBe("-3");
  });

  it("a GroupSymbolConfig row overriding only spread no longer clobbers commission to 0 (the pre-migration bug)", () => {
    const r = resolvePricingV2(baseParams({ groupSymbolConfig: symbolLevel({ spreadMarkup: D("1") }) }));
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("1") });
    expect(r.commissionPerLot.toString()).toBe("7");
  });

  it("commission set to a real zero (not null) is honored as an explicit zero, not treated as unset", () => {
    const r = resolvePricingV2(baseParams({ accountSymbolConfig: symbolLevel({ commissionPerLot: D("0") }) }));
    expect(r.commissionPerLot.toString()).toBe("0");
  });
});

describe("resolvePricingV2 -- swapFree resolution (account > group > false)", () => {
  it("account explicit true wins when the group is false", () => {
    expect(resolvePricingV2(baseParams({ accountSwapFree: true, groupSwapFree: false })).swapFree).toBe(true);
  });
  it("account explicit false wins when the group is true (the one-off exception case)", () => {
    expect(resolvePricingV2(baseParams({ accountSwapFree: false, groupSwapFree: true })).swapFree).toBe(false);
  });
  it("account unset -> the group decides", () => {
    expect(resolvePricingV2(baseParams({ accountSwapFree: null, groupSwapFree: true })).swapFree).toBe(true);
    expect(resolvePricingV2(baseParams({ accountSwapFree: null, groupSwapFree: false })).swapFree).toBe(false);
  });
  it("nothing set anywhere -> defaults to false (swap charged normally)", () => {
    expect(resolvePricingV2(baseParams()).swapFree).toBe(false);
  });
});

describe("resolvePricingV2 -- target-total-spread mode", () => {
  it("account-level target beats a group markup", () => {
    const r = resolvePricingV2(
      baseParams({
        accountSymbolConfig: symbolLevel({ targetTotalSpreadPips: D("2") }),
        groupSymbolConfig: symbolLevel({ spreadMarkup: D("5") }),
      })
    );
    expect(r.spread).toEqual({ mode: "target", targetTotalSpreadPips: D("2"), fallbackSpreadMarkup: null });
  });

  it("group-level target is honored when the account sets nothing", () => {
    const r = resolvePricingV2(baseParams({ groupSymbolConfig: symbolLevel({ targetTotalSpreadPips: D("0.8") }) }));
    expect(r.spread).toEqual({ mode: "target", targetTotalSpreadPips: D("0.8"), fallbackSpreadMarkup: null });
  });

  // 2026-09-07 Q2: spreadMarkup and targetTotalSpreadPips are no longer
  // mutually exclusive per level -- a level with BOTH set wins the whole
  // spread decision and target is the primary mode, with that level's own
  // spreadMarkup riding along as the no-live-base fallback (Q1).
  it("a level with both set: target is primary, its own spreadMarkup becomes the fallback, not a competing value", () => {
    const r = resolvePricingV2(baseParams({ accountSymbolConfig: symbolLevel({ spreadMarkup: D("0.3"), targetTotalSpreadPips: D("9") }) }));
    expect(r.spread).toEqual({ mode: "target", targetTotalSpreadPips: D("9"), fallbackSpreadMarkup: D("0.3") });
  });

  it("account-level plain markup beats a group-level target (precedence is by level, not by mode)", () => {
    const r = resolvePricingV2(
      baseParams({
        accountSymbolConfig: symbolLevel({ spreadMarkup: D("0.4") }),
        groupSymbolConfig: symbolLevel({ targetTotalSpreadPips: D("2") }),
      })
    );
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("0.4") });
  });
});

describe("resolveEffectiveSpreadMarkup -- collapses target mode against a live tick", () => {
  it("markup mode passes the stored value straight through, ignoring the live spread entirely, no warning", () => {
    const { markup, warning } = resolveEffectiveSpreadMarkup({ mode: "markup", spreadMarkup: D("2") }, "0.4");
    expect(markup.toString()).toBe("2");
    expect(warning).toBeNull();
  });

  it("target mode computes target minus live base when target is wider, no warning", () => {
    const { markup, warning } = resolveEffectiveSpreadMarkup({ mode: "target", targetTotalSpreadPips: D("3"), fallbackSpreadMarkup: null }, "1.2");
    expect(markup.toString()).toBe("1.8"); // 3 - 1.2
    expect(warning).toBeNull();
  });

  it("target mode lands at exactly 0 (base == target) with NO warning -- an exact match is achieved, not a shortfall", () => {
    const { markup, warning } = resolveEffectiveSpreadMarkup({ mode: "target", targetTotalSpreadPips: D("2"), fallbackSpreadMarkup: null }, "2");
    expect(markup.toString()).toBe("0");
    expect(warning).toBeNull();
  });

  // Q3: floor at 0 stays, but a genuine shortfall (base wider than target,
  // effective markup would have gone negative) is now surfaced as a
  // warning rather than silently absorbed.
  it("target mode floors at 0 when the live base is wider than the target, AND emits a target_below_base warning", () => {
    const { markup, warning } = resolveEffectiveSpreadMarkup({ mode: "target", targetTotalSpreadPips: D("2"), fallbackSpreadMarkup: null }, "2.5");
    expect(markup.toString()).toBe("0");
    expect(warning).toEqual({ reason: "target_below_base", targetTotalSpreadPips: D("2"), liveBaseSpreadPips: D("2.5") });
  });

  it("target mode floors at 0 (never a discount) when the live base is wider than target, with the same warning", () => {
    const { markup, warning } = resolveEffectiveSpreadMarkup({ mode: "target", targetTotalSpreadPips: D("2"), fallbackSpreadMarkup: null }, "5");
    expect(markup.toString()).toBe("0"); // broker eats the difference, never a discount to the client
    expect(warning).toEqual({ reason: "target_below_base", targetTotalSpreadPips: D("2"), liveBaseSpreadPips: D("5") });
  });

  // Q1: base unavailable -> never block the trade, fall back to this
  // level's own spreadMarkup if it set one, else 0.
  it("live base unavailable (null) with a fallback markup configured -> uses the fallback, flags base_unavailable", () => {
    const { markup, warning } = resolveEffectiveSpreadMarkup(
      { mode: "target", targetTotalSpreadPips: D("2"), fallbackSpreadMarkup: D("1.1") },
      null
    );
    expect(markup.toString()).toBe("1.1");
    expect(warning).toEqual({ reason: "base_unavailable", targetTotalSpreadPips: D("2"), fallbackMarkupUsed: D("1.1") });
  });

  it("live base unavailable (undefined) with NO fallback markup configured -> falls back to 0, never blocks the trade", () => {
    const { markup, warning } = resolveEffectiveSpreadMarkup({ mode: "target", targetTotalSpreadPips: D("2"), fallbackSpreadMarkup: null }, undefined);
    expect(markup.toString()).toBe("0");
    expect(warning).toEqual({ reason: "base_unavailable", targetTotalSpreadPips: D("2"), fallbackMarkupUsed: D("0") });
  });

  it("accepts number/Decimal live-spread inputs identically to string", () => {
    const fromString = resolveEffectiveSpreadMarkup({ mode: "target", targetTotalSpreadPips: D("3"), fallbackSpreadMarkup: null }, "1.2");
    const fromNumber = resolveEffectiveSpreadMarkup({ mode: "target", targetTotalSpreadPips: D("3"), fallbackSpreadMarkup: null }, 1.2);
    expect(fromString.markup.toString()).toBe(fromNumber.markup.toString());
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DB-backed: proves resolveSymbolPricingV2's queries actually wire up to
// the real AccountSymbolConfig/AccountTypeSymbolConfig/Account/AccountType/
// Group/GroupSymbolConfig models -- resolvePricingV2 above already covers
// every precedence/fallthrough path in isolation, so this only needs to
// prove the DB wrapper assembles the right inputs, not re-prove precedence.
// ─────────────────────────────────────────────────────────────────────────

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("lib/pricing-engine.test.ts: DB unreachable, skipping DB-backed tests");
  }
});

class RollbackSignal extends Error {}
async function withRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("resolveSymbolPricingV2 (live DB, rolled back)", () => {
  async function makeFixture(tx: Prisma.TransactionClient) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const broker = await tx.broker.create({ data: { name: `PricingV2 Test ${suffix}`, subdomain: `pv2test-${suffix}` } });
    const group = await tx.group.create({ data: { brokerId: broker.id, name: "PV2 Group", leverage: 100 } });
    const accountType = await tx.accountType.create({ data: { brokerId: broker.id, name: "PV2 Type" } });
    const symbol = await tx.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
    const account = await tx.account.create({
      data: {
        brokerId: broker.id,
        accountNumber: `9${suffix.slice(0, 7)}`,
        email: `pv2-${suffix}@test.local`,
        passwordHash: "x",
        fullName: "PV2 Test",
        accountMode: "LIVE",
        groupId: group.id,
        accountTypeId: accountType.id,
      },
    });
    return { broker, group, accountType, symbol, account };
  }

  it("with nothing configured anywhere, resolves to the broker/symbol base passed in", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const { symbol, account, accountType } = await makeFixture(tx);
      const result = await resolveSymbolPricingV2(tx, {
        accountId: account.id,
        groupId: account.groupId,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
        brokerSwapLong: D("-2"),
        brokerSwapShort: D("-2"),
      });
      expect(result.spread).toEqual({ mode: "markup", spreadMarkup: D("3") });
      expect(result.commissionPerLot.toString()).toBe("7");
      expect(result.swapFree).toBe(false);
    });
  });

  it("an AccountSymbolConfig row overrides just spread; commission still falls through to the group", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const { symbol, account, accountType, group } = await makeFixture(tx);
      await tx.accountSymbolConfig.create({ data: { accountId: account.id, symbolId: symbol.id, spreadMarkup: D("0.1") } });
      await tx.groupSymbolConfig.create({ data: { groupId: group.id, symbolId: symbol.id, commissionPerLot: D("2.5") } });

      const result = await resolveSymbolPricingV2(tx, {
        accountId: account.id,
        groupId: account.groupId,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
        brokerSwapLong: D("-2"),
        brokerSwapShort: D("-2"),
      });
      expect(result.spread).toEqual({ mode: "markup", spreadMarkup: D("0.1") });
      expect(result.commissionPerLot.toString()).toBe("2.5"); // from group, not clobbered by the account row's existence
    });
  });

  it("D4: the account's type is never read -- a type swapFree=true does not make the account swap-free (group false)", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const { symbol, account, accountType } = await makeFixture(tx);
      await tx.accountType.update({ where: { id: accountType.id }, data: { swapFree: true, spreadMarkup: D("0.05"), commissionPerLot: D("0") } });
      await tx.group.update({ where: { id: account.groupId! }, data: { swapFree: false } });

      const result = await resolveSymbolPricingV2(tx, {
        accountId: account.id,
        groupId: account.groupId,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
        brokerSwapLong: D("-2"),
        brokerSwapShort: D("-2"),
      });
      expect({ swapFree: result.swapFree, spread: result.spread, commission: result.commissionPerLot.toString() }).toEqual({ swapFree: false, spread: { mode: "markup", spreadMarkup: D("3") }, commission: "7" });
    });
  });

  it("Account.swapFree=true wins over the group", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const { symbol, account } = await makeFixture(tx);
      await tx.account.update({ where: { id: account.id }, data: { swapFree: true } });

      const result = await resolveSymbolPricingV2(tx, {
        accountId: account.id,
        groupId: account.groupId,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
        brokerSwapLong: D("-2"),
        brokerSwapShort: D("-2"),
      });
      expect(result.swapFree).toBe(true);
    });
  });
});

describe("resolveFillPricing -- the Stage 4 flag-gated shim (live DB, rolled back)", () => {
  async function makeFixture(tx: Prisma.TransactionClient) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const broker = await tx.broker.create({ data: { name: `FillPricing Test ${suffix}`, subdomain: `fptest-${suffix}` } });
    const group = await tx.group.create({ data: { brokerId: broker.id, name: "FP Group", leverage: 100 } });
    const accountType = await tx.accountType.create({ data: { brokerId: broker.id, name: "FP Type" } });
    const symbol = await tx.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
    const account = await tx.account.create({
      data: {
        brokerId: broker.id,
        accountNumber: `7${suffix.slice(0, 7)}`,
        email: `fp-${suffix}@test.local`,
        passwordHash: "x",
        fullName: "FP Test",
        accountMode: "LIVE",
        groupId: group.id,
        accountTypeId: accountType.id,
      },
    });
    return { broker, group, accountType, symbol, account };
  }

  it("flag OFF ignores every v2-only override and matches the old group-only resolution exactly", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const { symbol, account, accountType } = await makeFixture(tx);
      // Set an AccountType override that v2 would definitely pick up --
      // proves flag-off truly never looks at it.
      await tx.accountType.update({ where: { id: accountType.id }, data: { spreadMarkup: D("0.05") } });

      const result = await resolveFillPricing(tx, {
        pricingEngineEnabled: false,
        accountId: account.id,
        groupId: account.groupId,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
        brokerSwapLong: D("-2"),
        brokerSwapShort: D("-2"),
        liveBaseSpreadPips: "1",
      });
      expect(result.spreadMarkup.toString()).toBe("3"); // broker base, NOT the type's 0.05 override
      expect(result.commissionPerLot.toString()).toBe("7");
      expect(result.warning).toBeNull();
    });
  });

  it("D4: flag ON ignores an AccountType / AccountTypeSymbolConfig override entirely (broker base wins)", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const { symbol, account, accountType } = await makeFixture(tx);
      await tx.accountType.update({ where: { id: accountType.id }, data: { spreadMarkup: D("0.05"), commissionPerLot: D("0") } });
      await tx.accountTypeSymbolConfig.create({ data: { accountTypeId: accountType.id, symbolId: symbol.id, targetTotalSpreadPips: D("2") } });
      const result = await resolveFillPricing(tx, {
        pricingEngineEnabled: true,
        accountId: account.id,
        groupId: account.groupId,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
        brokerSwapLong: D("-2"),
        brokerSwapShort: D("-2"),
        liveBaseSpreadPips: "1.2",
      });
      expect({ spread: result.spreadMarkup.toString(), commission: result.commissionPerLot.toString() }).toEqual({ spread: "3", commission: "7" });
    });
  });

  it("flag ON picks up a GROUP per-symbol target and collapses it against the passed live base", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const { symbol, account, group } = await makeFixture(tx);
      await tx.groupSymbolConfig.create({ data: { groupId: group.id, symbolId: symbol.id, targetTotalSpreadPips: D("2") } });

      const result = await resolveFillPricing(tx, {
        pricingEngineEnabled: true,
        accountId: account.id,
        groupId: account.groupId,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
        brokerSwapLong: D("-2"),
        brokerSwapShort: D("-2"),
        liveBaseSpreadPips: "1.2",
      });
      expect(result.spreadMarkup.toString()).toBe("0.8"); // target 2 - live base 1.2
      expect(result.warning).toBeNull();
    });
  });

  it("flag ON with no live base available still fills (Q1) -- falls back to 0 with no fallback markup configured", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const { symbol, account, group } = await makeFixture(tx);
      await tx.groupSymbolConfig.create({ data: { groupId: group.id, symbolId: symbol.id, targetTotalSpreadPips: D("2") } });

      const result = await resolveFillPricing(tx, {
        pricingEngineEnabled: true,
        accountId: account.id,
        groupId: account.groupId,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
        brokerSwapLong: D("-2"),
        brokerSwapShort: D("-2"),
        liveBaseSpreadPips: null,
      });
      expect(result.spreadMarkup.toString()).toBe("0");
      expect(result.warning).toEqual({ reason: "base_unavailable", targetTotalSpreadPips: D("2"), fallbackMarkupUsed: D("0") });
    });
  });
});
