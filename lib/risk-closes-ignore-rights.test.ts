// Stage 6 merge check (2026-10-07): the credit / trading-rights batch (migration 20261006120000: Account.tradingRights, the account status gates) and the
// group minimum volume gate sit on the OPEN paths only. A risk close (stop-out, SL / TP) is the platform's own action and must never be blocked by
// them, whichever side owns the account: the web on a WEB broker, the web taking over a dead engine's RUST account (stale heartbeat). The engine side
// of the same claim is engine/order-management/tests/risk_split_db.rs (risk_closes_ignore_trading_rights_status_and_the_group_minimum_volume).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return { ...real, publishTradingEvent: vi.fn(async () => {}) };
});

import { prisma } from "@/lib/prisma";
import { setRiskHeartbeat } from "@/tests/support/risk-heartbeat";
import { evaluateAccountRisk } from "@/lib/risk-monitor";
import { checkAccountTradingRights, checkGroupMinLot } from "@/lib/risk";
import { readFileSync } from "node:fs";

const D = (v: number | string) => new Prisma.Decimal(v);
const brokers: string[] = [];
const symbols: string[] = [];

async function scenario(authority: "RUST" | "WEB", rights: "FULL" | "CLOSE_ONLY" | "READ_ONLY", status: "ACTIVE" | "SUSPENDED" | "CLOSED") {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `rr ${sfx}`, subdomain: `zrr-${sfx}`, riskAuthority: authority, riskAuthorityDemoOnly: false } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `ZR${sfx.toUpperCase()}`, baseCurrency: "ZRR", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "CRYPTO" } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D(90), ask: D(90), tickAt: new Date() } });
  // a group minimum volume far above the position's 1 lot: it must not stop a CLOSE of a position that is below it
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `ZR-${sfx}`, leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50), minLotSize: D(5) } });
  const a = await prisma.account.create({
    data: { brokerId: b.id, groupId: g.id, accountNumber: `5${String(Date.now() % 1000000).padStart(6, "0")}${Math.floor(Math.random() * 90 + 10)}`.slice(0, 12), email: `zr-${sfx}@x.local`, passwordHash: "x", fullName: "rr", accountMode: "LIVE", leverage: 1, balance: D(20), tradingRights: rights, status },
  });
  const order = await prisma.order.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", filledPrice: D(100), filledAt: new Date(), idempotencyKey: `zr-${a.id}` } });
  const p = await prisma.position.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(100) } });
  return { accountId: a.id, positionId: p.id };
}

afterAll(async () => {
  await setRiskHeartbeat(prisma, 0);
  if (brokers.length) {
    const where = { brokerId: { in: brokers } };
    await prisma.postCloseEffect.deleteMany({ where }).catch(() => {});
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.group.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60_000);

describe("risk closes are never blocked by trading rights, account status or the group minimum volume", () => {
  const cases: Array<["RUST" | "WEB", "FULL" | "CLOSE_ONLY" | "READ_ONLY", "ACTIVE" | "SUSPENDED" | "CLOSED"]> = [
    ["WEB", "READ_ONLY", "SUSPENDED"],
    ["WEB", "CLOSE_ONLY", "ACTIVE"],
    ["RUST", "READ_ONLY", "CLOSED"], // the engine's account, its heartbeat stale: the web takes the stop-out
    ["RUST", "READ_ONLY", "SUSPENDED"],
  ];
  for (const [authority, rights, status] of cases) {
    it(`${authority} broker, ${rights}, ${status}: the stop-out still closes the position (below the group minimum volume too)`, async () => {
      const s = await scenario(authority, rights, status);
      await setRiskHeartbeat(prisma, authority === "RUST" ? 120 : 0, 30); // a RUST broker with a dead engine = the web acts
      await evaluateAccountRisk(s.accountId);
      expect((await prisma.position.findUniqueOrThrow({ where: { id: s.positionId } })).status).toBe("CLOSED");
      expect(await prisma.transaction.count({ where: { accountId: s.accountId, type: "TRADE_PNL" } })).toBe(1);
    }, 30_000);
  }

  it("the same account IS refused on the open paths (the gates are real, this is not a vacuous pass)", () => {
    expect(checkAccountTradingRights({ status: "ACTIVE", tradingRights: "READ_ONLY" }, "open")).not.toBeNull();
    expect(checkAccountTradingRights({ status: "SUSPENDED", tradingRights: "FULL" }, "open")).not.toBeNull();
    expect(checkGroupMinLot(D(1), D(5), D(0.01))).not.toBeNull();
  });

  it("the risk close path never calls the open gates (source guard: lib/risk-monitor.ts and lib/position-close.ts)", () => {
    for (const file of ["lib/risk-monitor.ts", "lib/position-close.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/checkAccountTradingRights|checkAccountStatusForOpen|checkGroupMinLot|checkGroupMaxLot|tradingRights/);
    }
  });
});
