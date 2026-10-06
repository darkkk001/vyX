// Rust cutover Stage 6: a flip DURING a web pass (the engine's half is engine/order-management/tests/risk_split_db.rs, "flipping to web
// in the middle of an engine evaluation"; the cross-language drill under load is scripts/load/run-split.sh --drill).
//
// An account the WEB owns is being stopped out position by position. Right after the FIRST close committed, the broker is flipped to
// RUST (the engine takes over). The web's next close is refused inside its own transaction, the evaluation stops (no further close,
// no margin-call write), and what is left open is the engine's. The first close stands: it was the owner's when it ran.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return { ...real, publishTradingEvent: vi.fn(async () => {}) };
});

// a post-commit hook: cancelPendingClose runs right after every committed risk close (lib/risk-monitor.ts)
const afterClose = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }));
vi.mock("@/lib/queued-close", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queued-close")>();
  return {
    ...real,
    cancelPendingClose: vi.fn(async (...args: Parameters<typeof real.cancelPendingClose>) => {
      const r = await real.cancelPendingClose(...args);
      const fn = afterClose.fn;
      afterClose.fn = null; // once
      if (fn) await fn();
      return r;
    }),
  };
});

import { prisma } from "@/lib/prisma";
import { setRiskHeartbeat } from "@/tests/support/risk-heartbeat";
import { evaluateAccountRisk } from "@/lib/risk-monitor";

const D = (v: number | string) => new Prisma.Decimal(v);
const brokers: string[] = [];
const symbols: string[] = [];

beforeAll(async () => {
  await setRiskHeartbeat(prisma, 0); // the engine is alive for the split tests (the watchdog has its own: lib/risk-watchdog.test.ts)
});

afterAll(async () => {
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

describe("a flip during a web pass", () => {
  it("WEB -> RUST after the first stop-out close: the next close is refused, nothing more is written, the first close stands", async () => {
    const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
    const b = await prisma.broker.create({ data: { name: `flip ${sfx}`, subdomain: `zflip-${sfx}`, riskAuthority: "WEB", riskAuthorityDemoOnly: false } });
    brokers.push(b.id);
    const sym = await prisma.symbol.create({ data: { name: `ZF${sfx.toUpperCase()}`, baseCurrency: "ZFL", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "CRYPTO" } });
    symbols.push(sym.name);
    await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id } });
    await prisma.livePrice.create({ data: { symbol: sym.name, bid: D(90), ask: D(90), tickAt: new Date() } });
    const g = await prisma.group.create({ data: { brokerId: b.id, name: `ZF-${sfx}`, leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50) } });
    // three positions of 1 lot 100 -> 90 on a balance of 20: equity -10, every position is stopped out in turn
    const a = await prisma.account.create({
      data: { brokerId: b.id, groupId: g.id, accountNumber: `7${String(Date.now() % 1000000).padStart(6, "0")}9`, email: `zf-${sfx}@x.local`, passwordHash: "x", fullName: "flip", accountMode: "LIVE", leverage: 1, balance: D(20) },
    });
    const positions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const order = await prisma.order.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", filledPrice: D(100), filledAt: new Date(), idempotencyKey: `zf-${a.id}-${i}` } });
      const p = await prisma.position.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(100), openedAt: new Date(Date.now() + i) } });
      positions.push(p.id);
    }

    // after the first close has COMMITTED, the owner flips the broker to RUST (the UPDATE runs outside any transaction of ours)
    afterClose.fn = async () => {
      await prisma.broker.update({ where: { id: b.id }, data: { riskAuthority: "RUST" } });
    };
    const r = await evaluateAccountRisk(a.id);

    expect(r.evaluated).toBe(false);
    expect(r.stopOutClosed).toHaveLength(1);
    const open = await prisma.position.count({ where: { accountId: a.id, status: "OPEN" } });
    expect(open, "exactly one close before the flip, none after").toBe(2);
    expect(await prisma.transaction.count({ where: { accountId: a.id, type: "TRADE_PNL" } })).toBe(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).marginCallNotifiedAt).toBeNull();
    // a second web evaluation of that account is now dropped at the prefilter: it is the engine's
    const again = await evaluateAccountRisk(a.id);
    expect(again).toEqual({ evaluated: false, slTpClosed: [], stopOutClosed: [] });
    expect(await prisma.position.count({ where: { accountId: a.id, status: "OPEN" } })).toBe(2);
  }, 60_000);
});
