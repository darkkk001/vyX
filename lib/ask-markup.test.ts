// lib/ask-markup.ts: the vectors file matches the server, and the batched resolver equals the FILL path's own resolver
// (lib/pricing-engine.ts resolveFillPricing) for every precedence case, on the scratch DB.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeAskMarkupVectors, RESOLUTION_INPUTS, type ResolutionInput } from "@/lib/ask-markup-contract";
import { accountClosePrice, accountQuote, loadAskRules, markedDownBid, markedUpAsk, RAW_RULE, type AskRule } from "@/lib/ask-markup";
import { askRuleCacheStats, askRulesCached, invalidateAskRules } from "@/lib/ask-markup-cache";
import { resolveFillPricing } from "@/lib/pricing-engine";
import { applySpreadMarkup, pipSize } from "@/lib/group-pricing";

const D = (v: string | number) => new Prisma.Decimal(v);

describe("ask-markup vectors", () => {
  it("docs/contracts/ask-markup-vectors.json is exactly what the server computes", () => {
    const file = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "docs", "contracts", "ask-markup-vectors.json"), "utf8"));
    expect(file).toEqual(JSON.parse(JSON.stringify(computeAskMarkupVectors())));
  });

  it("both account prices are the fill prices: applySpreadMarkup on the same markup, each side", () => {
    for (const p of computeAskMarkupVectors().prices) {
      // symmetric markup (2026-10-29): applySpreadMarkup halves the markup itself, so the SAME full markup in pips
      // produces the ask-side fill from the raw ask and the bid-side fill from the raw bid
      const buyFill = applySpreadMarkup({ side: "BUY", price: p.ask, spreadMarkup: p.expected.markupPips, digits: p.digits });
      const sellFill = applySpreadMarkup({ side: "SELL", price: p.bid, spreadMarkup: p.expected.markupPips, digits: p.digits });
      expect(p.expected.accountAsk).toBe(buyFill.toString());
      expect(p.expected.accountBid).toBe(sellFill.toString());
      // a BUY opens at the account's ask and CLOSES at its bid; a SELL the other way round
      expect(p.expected.sellClose).toBe(p.expected.accountAsk);
      expect(p.expected.buyClose).toBe(p.expected.accountBid);
      // never tighter than raw, never crossed
      expect(D(p.expected.accountAsk).gte(D(p.ask))).toBe(true);
      expect(D(p.expected.accountBid).lte(D(p.bid))).toBe(true);
      expect(D(p.expected.accountBid).lt(D(p.expected.accountAsk))).toBe(true);
    }
  });

  it("a zero markup leaves BOTH sides raw, and the half is rounded away from the client", () => {
    expect(markedUpAsk(RAW_RULE(2), "1", "1.5").toString()).toBe("1.5");
    expect(markedDownBid(RAW_RULE(2), "1", "1.5").toString()).toBe("1");
    expect(accountClosePrice("SELL", "1", "1.5", RAW_RULE(2)).toString()).toBe("1.5");
    expect(accountClosePrice("BUY", "1", "1.5", RAW_RULE(2)).toString()).toBe("1");

    // XAUUSD, digits 2 (pip 0.1), 1.5 pips = 0.15 -> half 0.075, not representable at 2 digits:
    // the ask must round UP and the bid DOWN, so the client never gains the half point.
    const rule = { mode: "markup" as const, markupPips: D("1.5"), digits: 2 };
    expect(markedUpAsk(rule, "4298.96", "4299.13").toString()).toBe("4299.21");
    expect(markedDownBid(rule, "4298.96", "4299.13").toString()).toBe("4298.88");

    // a markup wider than the price itself degrades to the smallest quotable price, never zero or negative
    const huge = { mode: "markup" as const, markupPips: D("600"), digits: 2 };
    expect(markedDownBid(huge, "1.00", "1.02").gt(0)).toBe(true);
    expect(() => accountQuote(huge, "1.00", "1.02")).not.toThrow();
  });
});

// One broker per engine-flag state, one account per resolution case, the case's levels written as real rows.
const SUB = { off: "zz-askm-off", on: "zz-askm-on" };
const made: { input: ResolutionInput; accountId: string; symbolId: string; brokerId: string; groupId: string; accountTypeId: string | null }[] = [];

async function wipe() {
  for (const sub of Object.values(SUB)) {
    const b = await prisma.broker.findUnique({ where: { subdomain: sub } });
    if (!b) continue;
    await prisma.broker.update({ where: { id: b.id }, data: { coverageAccountId: null } });
    await prisma.accountSymbolConfig.deleteMany({ where: { account: { brokerId: b.id } } });
    await prisma.account.deleteMany({ where: { brokerId: b.id } });
    await prisma.accountTypeSymbolConfig.deleteMany({ where: { accountType: { brokerId: b.id } } });
    await prisma.accountType.deleteMany({ where: { brokerId: b.id } });
    await prisma.groupSymbolConfig.deleteMany({ where: { group: { brokerId: b.id } } });
    await prisma.group.deleteMany({ where: { brokerId: b.id } });
    await prisma.brokerSymbol.deleteMany({ where: { brokerId: b.id } });
    await prisma.broker.delete({ where: { id: b.id } });
  }
}

beforeAll(async () => {
  await wipe();
  const brokers = {
    off: await prisma.broker.create({ data: { name: "askm off", subdomain: SUB.off, pricingEngineEnabled: false } }),
    on: await prisma.broker.create({ data: { name: "askm on", subdomain: SUB.on, pricingEngineEnabled: true } }),
  };
  let n = 0;
  for (const input of RESOLUTION_INPUTS) {
    n++;
    const broker = input.pricingEngineEnabled ? brokers.on : brokers.off;
    const sym = await prisma.symbol.upsert({ where: { name: `ZASKM${n}` }, update: {}, create: { name: `ZASKM${n}`, baseCurrency: "ZZZ", quoteCurrency: "USD", digits: input.digits, contractSize: D(1), category: "CRYPTO" } });
    await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: sym.id, spreadMarkup: D(input.broker) } });
    const group = await prisma.group.create({ data: { brokerId: broker.id, name: `g${n}`, category: input.coverage ? "COVERAGE" : "B_BOOK" } });
    const lvl = (l: ResolutionInput["group"]) => ({ spreadMarkup: l?.spreadMarkup == null ? null : D(l.spreadMarkup), targetTotalSpreadPips: l?.targetTotalSpreadPips == null ? null : D(l.targetTotalSpreadPips) });
    if (input.group) await prisma.groupSymbolConfig.create({ data: { groupId: group.id, symbolId: sym.id, ...lvl(input.group) } });
    const accountTypeId: string | null = null; // D4: the resolution vectors carry no account-type level
    const account = await prisma.account.create({ data: { brokerId: broker.id, accountNumber: `4666${String(Date.now() % 10000).padStart(4, "0")}${n}`, email: `a${n}@x.local`, passwordHash: "x", fullName: "a", accountMode: "LIVE", groupId: group.id, accountTypeId } });
    if (input.accountSymbol) await prisma.accountSymbolConfig.create({ data: { accountId: account.id, symbolId: sym.id, ...lvl(input.accountSymbol) } });
    made.push({ input, accountId: account.id, symbolId: sym.id, brokerId: broker.id, groupId: group.id, accountTypeId });
  }
}, 120_000);
afterAll(async () => {
  await wipe();
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "ZASKM" } } });
}, 60_000);

describe("loadAskRules (scratch DB)", () => {
  it("resolves every case in a handful of queries, and each case to its vector", async () => {
    const rules = await loadAskRules(prisma, made.map((m) => ({ accountId: m.accountId, symbolId: m.symbolId })));
    const vectors = computeAskMarkupVectors().resolution;
    for (const m of made) {
      const r = rules.get(m.accountId, m.symbolId)!;
      const v = vectors.find((x) => x.name === m.input.name)!.expected;
      const got = r.mode === "markup" ? { mode: "markup", markupPips: r.markupPips.toString() } : { mode: "target", targetPips: r.targetPips.toString(), fallbackPips: r.fallbackPips?.toString() ?? null };
      expect(got, m.input.name).toEqual(v);
    }
  });

  it("equals the fill path (resolveFillPricing) at a live tick, for every non-coverage case", async () => {
    const rules = await loadAskRules(prisma, made.map((m) => ({ accountId: m.accountId, symbolId: m.symbolId })));
    const bid = D("4298.96"), ask = D("4299.13");
    for (const m of made.filter((x) => !x.input.coverage)) {
      const bs = await prisma.brokerSymbol.findFirstOrThrow({ where: { brokerId: m.brokerId, symbolId: m.symbolId } });
      const digits = m.input.digits;
      const fill = await resolveFillPricing(prisma, {
        pricingEngineEnabled: m.input.pricingEngineEnabled, accountId: m.accountId, groupId: m.groupId, symbolId: m.symbolId,
        brokerSpreadMarkup: bs.spreadMarkup, brokerCommissionPerLot: bs.commissionPerLot, brokerSwapLong: bs.swapLong, brokerSwapShort: bs.swapShort,
        liveBaseSpreadPips: ask.sub(bid).div(pipSize(digits)),
      });
      const buyOpen = applySpreadMarkup({ side: "BUY", price: ask, spreadMarkup: fill.spreadMarkup, digits });
      expect(markedUpAsk(rules.get(m.accountId, m.symbolId)!, bid, ask).toString(), m.input.name).toBe(buyOpen.toString());
    }
  });

  it("a coverage account is raw even with markups configured above it", async () => {
    const c = made.find((m) => m.input.coverage)!;
    const rules = await loadAskRules(prisma, [{ accountId: c.accountId, symbolId: c.symbolId }]);
    expect(markedUpAsk(rules.get(c.accountId, c.symbolId)!, "1", "1.5").toString()).toBe("1.5");
  });

  it("an unknown account or symbol resolves to null (callers use the raw ask)", async () => {
    const rules = await loadAskRules(prisma, [{ accountId: "nope", symbolId: made[0].symbolId }]);
    expect(rules.get("nope", made[0].symbolId)).toBeNull();
  });
});

// The per-cycle cache (lib/ask-markup-cache.ts, owner decision 2026-10-30) resolves the SAME precedence in memory
// from cached config tables instead of querying per (account, symbol). It is a second implementation of the rule, so
// it has to be pinned to the first one -- on exactly the fixtures above, which cover every resolution vector.
describe("askRulesCached vs loadAskRules (scratch DB): the two resolvers must agree", () => {
  const shape = (r: AskRule | null) =>
    r == null
      ? null
      : r.mode === "markup"
        ? { mode: "markup", markupPips: r.markupPips.toString(), digits: r.digits }
        : { mode: "target", targetPips: r.targetPips.toString(), fallbackPips: r.fallbackPips?.toString() ?? null, digits: r.digits };

  it("agrees on every resolution case (account > group > broker, coverage, engine on/off)", async () => {
    invalidateAskRules();
    const pairs = made.map((m) => ({ accountId: m.accountId, symbolId: m.symbolId }));
    const loader = await loadAskRules(prisma, pairs);
    const cached = await askRulesCached(prisma, pairs);
    for (const m of made) {
      expect(shape(cached.get(m.accountId, m.symbolId)), `${m.input.name}: cache vs loader`).toEqual(shape(loader.get(m.accountId, m.symbolId)));
    }
  });

  it("agrees on the account's bid AND ask at a live tick, for every case", async () => {
    invalidateAskRules();
    const pairs = made.map((m) => ({ accountId: m.accountId, symbolId: m.symbolId }));
    const loader = await loadAskRules(prisma, pairs);
    const cached = await askRulesCached(prisma, pairs);
    const bid = D("4298.96"), ask = D("4299.13");
    for (const m of made) {
      const l = loader.get(m.accountId, m.symbolId)!;
      const c = cached.get(m.accountId, m.symbolId)!;
      expect(markedUpAsk(c, bid, ask).toString(), `${m.input.name}: ask`).toBe(markedUpAsk(l, bid, ask).toString());
      expect(markedDownBid(c, bid, ask).toString(), `${m.input.name}: bid`).toBe(markedDownBid(l, bid, ask).toString());
    }
  });

  it("an unknown pair answers NO_MARKUP (raw both sides), where the loader answers null", async () => {
    invalidateAskRules();
    const cached = await askRulesCached(prisma, [{ accountId: "nope", symbolId: made[0].symbolId }]);
    const r = cached.get("nope", made[0].symbolId)!;
    expect(r).not.toBeNull();
    expect(markedUpAsk(r, "1", "1.5").toString()).toBe("1.5");
    expect(markedDownBid(r, "1", "1.5").toString()).toBe("1");
  });

  it("is warm after the first call: the second resolve issues no further config read", async () => {
    invalidateAskRules();
    expect(askRuleCacheStats().rows).toBe(0);
    const pairs = made.map((m) => ({ accountId: m.accountId, symbolId: m.symbolId }));
    await askRulesCached(prisma, pairs);
    const afterFirst = askRuleCacheStats();
    expect(afterFirst.rows).toBeGreaterThan(0);
    // a pair NOT asked for the first time must still resolve from the warm config, with no new read
    await askRulesCached(prisma, [{ accountId: made[0].accountId, symbolId: made[made.length - 1].symbolId }]);
    expect(askRuleCacheStats().at).toBe(afterFirst.at);
    expect(askRuleCacheStats().rows).toBe(afterFirst.rows);
  });
});
