// lib/ask-markup.ts: the vectors file matches the server, and the batched resolver equals the FILL path's own resolver
// (lib/pricing-engine.ts resolveFillPricing) for every precedence case, on the scratch DB.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeAskMarkupVectors, RESOLUTION_INPUTS, type ResolutionInput } from "@/lib/ask-markup-contract";
import { loadAskRules, markedUpAsk, accountClosePrice, RAW_ASK } from "@/lib/ask-markup";
import { resolveFillPricing } from "@/lib/pricing-engine";
import { applySpreadMarkup, pipSize } from "@/lib/group-pricing";

const D = (v: string | number) => new Prisma.Decimal(v);

describe("ask-markup vectors", () => {
  it("docs/contracts/ask-markup-vectors.json is exactly what the server computes", () => {
    const file = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "docs", "contracts", "ask-markup-vectors.json"), "utf8"));
    expect(file).toEqual(JSON.parse(JSON.stringify(computeAskMarkupVectors())));
  });

  it("the account's ask is the BUY fill price: applySpreadMarkup on the same markup", () => {
    for (const p of computeAskMarkupVectors().prices) {
      const fill = applySpreadMarkup({ side: "BUY", price: p.ask, spreadMarkup: p.expected.markupPips, digits: p.digits });
      expect(p.expected.accountAsk).toBe(fill.toString());
      expect(p.expected.sellClose).toBe(p.expected.accountAsk);
      expect(p.expected.buyClose).toBe(D(p.bid).toString());
    }
  });

  it("no rule = raw ask; a raw rule = raw ask", () => {
    expect(accountClosePrice("SELL", "1", "1.5", null).toString()).toBe("1.5");
    expect(markedUpAsk(RAW_ASK(2), "1", "1.5").toString()).toBe("1.5");
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
    let accountTypeId: string | null = null;
    if (input.accountType || input.accountTypeSymbol) {
      const t = await prisma.accountType.create({ data: { brokerId: broker.id, name: `t${n}`, spreadMarkup: input.accountType?.spreadMarkup == null ? null : D(input.accountType.spreadMarkup) } });
      accountTypeId = t.id;
      if (input.accountTypeSymbol) await prisma.accountTypeSymbolConfig.create({ data: { accountTypeId: t.id, symbolId: sym.id, ...lvl(input.accountTypeSymbol) } });
    }
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
        pricingEngineEnabled: m.input.pricingEngineEnabled, accountId: m.accountId, accountTypeId: m.accountTypeId, groupId: m.groupId, symbolId: m.symbolId,
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
