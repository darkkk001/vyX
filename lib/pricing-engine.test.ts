import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolvePricingV2, resolveEffectiveSpreadMarkup, resolveSymbolPricingV2, resolveFillPricing, type SymbolConfigLevel, type AccountTypeFlatLevel } from "@/lib/pricing-engine";

// Phase 2 pricing engine (docs/pricing-engine.md) -- exhaustive precedence
// coverage for resolvePricingV2 (pure, no DB) plus a handful of DB-backed
// tests proving resolveSymbolPricingV2's queries actually wire up to real
// Prisma models. Real numbers throughout, not placeholders, so a wrong
// fallthrough shows up as a wrong number, not just a wrong branch taken.

const D = (v: string | number) => new Prisma.Decimal(v);

// Base params with every override level empty (null) -- every test starts
// here and fills in only the levels it cares about, so each test's
// intent (which level is being exercised) stays visible at a glance.
const BROKER_BASE = {
  brokerSpreadMarkup: D("3"),
  brokerCommissionPerLot: D("7"),
  brokerSwapLong: D("-2.5"),
  brokerSwapShort: D("-1.5"),
};

const EMPTY_SYMBOL_LEVEL: SymbolConfigLevel = null;
const EMPTY_TYPE_LEVEL: AccountTypeFlatLevel = null;

function baseParams(overrides: Partial<Parameters<typeof resolvePricingV2>[0]> = {}) {
  return {
    accountSymbolConfig: EMPTY_SYMBOL_LEVEL,
    accountTypeSymbolConfig: EMPTY_SYMBOL_LEVEL,
    accountType: EMPTY_TYPE_LEVEL,
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

function typeLevel(fields: Partial<NonNullable<AccountTypeFlatLevel>>): NonNullable<AccountTypeFlatLevel> {
  return {
    spreadMarkup: null,
    commissionPerLot: null,
    swapLong: null,
    swapShort: null,
    swapFree: null,
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

describe("resolvePricingV2 -- account override wins over every other level", () => {
  it("account symbol config beats type, group, and base for all 4 numeric fields at once", () => {
    const r = resolvePricingV2(
      baseParams({
        accountSymbolConfig: symbolLevel({ spreadMarkup: D("0.1"), commissionPerLot: D("0"), swapLong: D("1"), swapShort: D("1") }),
        accountTypeSymbolConfig: symbolLevel({ spreadMarkup: D("1"), commissionPerLot: D("5"), swapLong: D("-9"), swapShort: D("-9") }),
        accountType: typeLevel({ spreadMarkup: D("2"), commissionPerLot: D("6"), swapLong: D("-8"), swapShort: D("-8") }),
        groupSymbolConfig: symbolLevel({ spreadMarkup: D("0.5"), commissionPerLot: D("2"), swapLong: D("-7"), swapShort: D("-7") }),
      })
    );
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("0.1") });
    expect(r.commissionPerLot.toString()).toBe("0"); // a VIP zero-commission deal, distinct from "unset"
    expect(r.swapLong.toString()).toBe("1");
    expect(r.swapShort.toString()).toBe("1");
  });
});

describe("resolvePricingV2 -- falls through one level at a time", () => {
  it("no account override -> uses AccountTypeSymbolConfig (per-symbol type pricing)", () => {
    const r = resolvePricingV2(
      baseParams({
        accountTypeSymbolConfig: symbolLevel({ spreadMarkup: D("1.2"), commissionPerLot: D("4") }),
        accountType: typeLevel({ spreadMarkup: D("9"), commissionPerLot: D("9") }), // must be ignored -- per-symbol type config outranks flat type default
        groupSymbolConfig: symbolLevel({ spreadMarkup: D("0.5"), commissionPerLot: D("2") }),
      })
    );
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("1.2") });
    expect(r.commissionPerLot.toString()).toBe("4");
  });

  it("no account or per-symbol-type override -> uses AccountType's flat type-wide default", () => {
    const r = resolvePricingV2(
      baseParams({
        accountType: typeLevel({ spreadMarkup: D("1.75"), commissionPerLot: D("5") }),
        groupSymbolConfig: symbolLevel({ spreadMarkup: D("0.5"), commissionPerLot: D("2") }),
      })
    );
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("1.75") });
    expect(r.commissionPerLot.toString()).toBe("5");
  });

  it("no account or type override at all -> uses GroupSymbolConfig", () => {
    const r = resolvePricingV2(baseParams({ groupSymbolConfig: symbolLevel({ spreadMarkup: D("0.5"), commissionPerLot: D("2") }) }));
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("0.5") });
    expect(r.commissionPerLot.toString()).toBe("2");
  });

  it("nothing set anywhere -> uses the broker/symbol base", () => {
    const r = resolvePricingV2(baseParams());
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("3") });
    expect(r.commissionPerLot.toString()).toBe("7");
  });
});

describe("resolvePricingV2 -- per-field independence (the bug this migration fixed)", () => {
  it("account sets spread only -> commission/swap fall through independently to type/group, not forced to 0", () => {
    const r = resolvePricingV2(
      baseParams({
        accountSymbolConfig: symbolLevel({ spreadMarkup: D("0.2") }), // commissionPerLot/swapLong/swapShort left null
        accountType: typeLevel({ commissionPerLot: D("4") }), // type sets commission only
        groupSymbolConfig: symbolLevel({ swapLong: D("-3"), swapShort: D("-3") }), // group sets swap only
      })
    );
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("0.2") }); // from account
    expect(r.commissionPerLot.toString()).toBe("4"); // from type, NOT clobbered to 0 by the account row existing
    expect(r.swapLong.toString()).toBe("-3"); // from group, NOT clobbered to 0 by account or type rows existing
    expect(r.swapShort.toString()).toBe("-3");
  });

  it("a GroupSymbolConfig row overriding only spread no longer clobbers commission to 0 (the pre-migration bug)", () => {
    const r = resolvePricingV2(baseParams({ groupSymbolConfig: symbolLevel({ spreadMarkup: D("1") }) }));
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("1") });
    expect(r.commissionPerLot.toString()).toBe("7"); // broker base, not 0
  });

  it("commission set to a real zero (not null) is honored as an explicit zero, not treated as unset", () => {
    const r = resolvePricingV2(baseParams({ accountSymbolConfig: symbolLevel({ commissionPerLot: D("0") }) }));
    expect(r.commissionPerLot.toString()).toBe("0");
  });
});

describe("resolvePricingV2 -- swapFree resolution (account > type > group > false)", () => {
  it("account explicit true wins even when type and group are both false", () => {
    const r = resolvePricingV2(baseParams({ accountSwapFree: true, accountType: typeLevel({ swapFree: false }), groupSwapFree: false }));
    expect(r.swapFree).toBe(true);
  });

  it("account explicit false wins even when type and group are both true (the one-off exception case)", () => {
    const r = resolvePricingV2(baseParams({ accountSwapFree: false, accountType: typeLevel({ swapFree: true }), groupSwapFree: true }));
    expect(r.swapFree).toBe(false);
  });

  it("account unset -> type wins over group", () => {
    const r = resolvePricingV2(baseParams({ accountSwapFree: null, accountType: typeLevel({ swapFree: true }), groupSwapFree: false }));
    expect(r.swapFree).toBe(true);
  });

  it("account and type unset -> group wins", () => {
    const r = resolvePricingV2(baseParams({ accountSwapFree: null, accountType: typeLevel({ swapFree: null }), groupSwapFree: true }));
    expect(r.swapFree).toBe(true);
  });

  it("nothing set anywhere -> defaults to false (swap charged normally)", () => {
    const r = resolvePricingV2(baseParams());
    expect(r.swapFree).toBe(false);
  });

  it("no accountType at all (null) is treated the same as an unset accountType.swapFree", () => {
    const r = resolvePricingV2(baseParams({ accountType: null, groupSwapFree: true }));
    expect(r.swapFree).toBe(true);
  });
});

describe("resolvePricingV2 -- target-total-spread mode", () => {
  it("account-level target beats a type/group markup", () => {
    const r = resolvePricingV2(
      baseParams({
        accountSymbolConfig: symbolLevel({ targetTotalSpreadPips: D("2") }),
        groupSymbolConfig: symbolLevel({ spreadMarkup: D("5") }),
      })
    );
    expect(r.spread).toEqual({ mode: "target", targetTotalSpreadPips: D("2"), fallbackSpreadMarkup: null });
  });

  it("type-level (per-symbol) target is honored when account sets nothing", () => {
    const r = resolvePricingV2(baseParams({ accountTypeSymbolConfig: symbolLevel({ targetTotalSpreadPips: D("1.5") }) }));
    expect(r.spread).toEqual({ mode: "target", targetTotalSpreadPips: D("1.5"), fallbackSpreadMarkup: null });
  });

  it("group-level target is honored when neither account nor type set anything", () => {
    const r = resolvePricingV2(baseParams({ groupSymbolConfig: symbolLevel({ targetTotalSpreadPips: D("0.8") }) }));
    expect(r.spread).toEqual({ mode: "target", targetTotalSpreadPips: D("0.8"), fallbackSpreadMarkup: null });
  });

  // 2026-09-07 Q2: spreadMarkup and targetTotalSpreadPips are no longer
  // mutually exclusive per level -- a level with BOTH set wins the whole
  // spread decision (same "first level with either field set" rule as
  // before) and target is the primary mode, with that level's own
  // spreadMarkup riding along as the no-live-base fallback (Q1).
  it("a level with both set: target is primary, its own spreadMarkup becomes the fallback, not a competing value", () => {
    const r = resolvePricingV2(baseParams({ accountSymbolConfig: symbolLevel({ spreadMarkup: D("0.3"), targetTotalSpreadPips: D("9") }) }));
    expect(r.spread).toEqual({ mode: "target", targetTotalSpreadPips: D("9"), fallbackSpreadMarkup: D("0.3") });
  });

  it("account-level plain markup beats a type-level target (precedence is by level, not by mode)", () => {
    const r = resolvePricingV2(
      baseParams({
        accountSymbolConfig: symbolLevel({ spreadMarkup: D("0.4") }),
        accountTypeSymbolConfig: symbolLevel({ targetTotalSpreadPips: D("2") }),
      })
    );
    expect(r.spread).toEqual({ mode: "markup", spreadMarkup: D("0.4") });
  });

  it("type-level target beats a group-level markup", () => {
    const r = resolvePricingV2(
      baseParams({
        accountTypeSymbolConfig: symbolLevel({ targetTotalSpreadPips: D("1.5") }),
        groupSymbolConfig: symbolLevel({ spreadMarkup: D("5") }),
      })
    );
    expect(r.spread).toEqual({ mode: "target", targetTotalSpreadPips: D("1.5"), fallbackSpreadMarkup: null });
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
        accountTypeId: accountType.id,
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
        accountTypeId: accountType.id,
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

  it("Account.swapFree=true overrides an explicit AccountType.swapFree=false", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const { symbol, account, accountType } = await makeFixture(tx);
      await tx.accountType.update({ where: { id: accountType.id }, data: { swapFree: false } });
      await tx.account.update({ where: { id: account.id }, data: { swapFree: true } });

      const result = await resolveSymbolPricingV2(tx, {
        accountId: account.id,
        accountTypeId: accountType.id,
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
        accountTypeId: accountType.id,
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

  it("flag ON picks up the same AccountType override and collapses target mode against the passed live base", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const { symbol, account, accountType } = await makeFixture(tx);
      await tx.accountTypeSymbolConfig.create({
        data: { accountTypeId: accountType.id, symbolId: symbol.id, targetTotalSpreadPips: D("2") },
      });

      const result = await resolveFillPricing(tx, {
        pricingEngineEnabled: true,
        accountId: account.id,
        accountTypeId: accountType.id,
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
      const { symbol, account, accountType } = await makeFixture(tx);
      await tx.accountTypeSymbolConfig.create({
        data: { accountTypeId: accountType.id, symbolId: symbol.id, targetTotalSpreadPips: D("2") },
      });

      const result = await resolveFillPricing(tx, {
        pricingEngineEnabled: true,
        accountId: account.id,
        accountTypeId: accountType.id,
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
