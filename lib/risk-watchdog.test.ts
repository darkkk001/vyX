// Rust cutover Stage 6: the ENGINE-DOWN WATCHDOG, web side (docs/STAGE6-PLAN.md section 14; the engine side is
// engine/order-management/tests/risk_split_db.rs, both together with the real web and engine walking one database are
// scripts/load/run-split.sh --stall).
//
// The engine writes a heartbeat row ("RiskEngineHeartbeat", name 'risk'). Older than staleAfterSecs by the DATABASE clock (or no row) = the engine
// is DOWN: a RUST-owned account is WEB-owned, in the prefilter (loadRiskOwners) AND inside every acting transaction (assertRiskActorInTx, which
// locks the heartbeat row FOR SHARE so the engine's next beat waits for an action already decided on a stale reading).
// Remove the in-transaction heartbeat check and the "stalled engine" tests fail (scripts/stage6/mutation-check.sh, M10 / M11).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return { ...real, publishTradingEvent: vi.fn(async () => {}) };
});

import { prisma } from "@/lib/prisma";
import { setRiskHeartbeat } from "@/tests/support/risk-heartbeat";
import { evaluateAccountRisk } from "@/lib/risk-monitor";
import { assertRiskActorInTx, loadRiskOwners, NotRiskOwnerError, webOwnedAccountIds } from "@/lib/risk-owner";
import { effectiveRiskOwner } from "@/lib/risk-authority";

const D = (v: number | string) => new Prisma.Decimal(v);
const brokers: string[] = [];
const symbols: string[] = [];
let seq = 0;

/** A RUST-owned (all accounts) broker with one LIVE account in a stop-out (balance 20, one 1-lot BUY 100 -> 90, leverage 1). */
async function stopOutScenario(positions = 1) {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `wd ${sfx}`, subdomain: `zwd-${sfx}`, riskAuthority: "RUST", riskAuthorityDemoOnly: false } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `ZW${sfx.toUpperCase()}`, baseCurrency: "ZWD", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "CRYPTO" } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D(90), ask: D(90), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `ZW-${sfx}`, leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50) } });
  seq++;
  const a = await prisma.account.create({
    data: { brokerId: b.id, groupId: g.id, accountNumber: `7${String(Date.now() % 1000000).padStart(6, "0")}${seq}`.slice(0, 12), email: `zw${seq}-${sfx}@x.local`, passwordHash: "x", fullName: "wd", accountMode: "LIVE", leverage: 1, balance: D(20) },
  });
  const ids: string[] = [];
  for (let i = 0; i < positions; i++) {
    const order = await prisma.order.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", filledPrice: D(100), filledAt: new Date(), idempotencyKey: `zw-${a.id}-${i}` } });
    const p = await prisma.position.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(100) } });
    ids.push(p.id);
  }
  return { brokerId: b.id, accountId: a.id, positionIds: ids };
}

const pnlRows = (accountId: string) => prisma.transaction.count({ where: { accountId, type: "TRADE_PNL" } });
const openCount = (accountId: string) => prisma.position.count({ where: { accountId, status: "OPEN" } });

beforeAll(async () => {
  await setRiskHeartbeat(prisma, 0);
});

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

describe("effectiveRiskOwner: the rule with the engine's liveness counted", () => {
  it("only an engine that is alive (exactly true) keeps its accounts", () => {
    const broker = { riskAuthority: "RUST", riskAuthorityDemoOnly: false };
    expect(effectiveRiskOwner(broker, "LIVE", true)).toBe("RUST");
    for (const alive of [false, null, undefined]) expect(effectiveRiskOwner(broker, "LIVE", alive as boolean)).toBe("WEB");
    expect(effectiveRiskOwner({ riskAuthority: "WEB" }, "DEMO", true)).toBe("WEB");
  });
});

describe("the prefilter and the in-transaction check follow the heartbeat", () => {
  it("fresh: the engine's accounts are skipped by the web; stale or missing: they are the web's", async () => {
    const s = await stopOutScenario();
    await setRiskHeartbeat(prisma, 5, 30);
    expect((await loadRiskOwners(prisma, [s.accountId])).get(s.accountId)).toBe("RUST");
    expect(await webOwnedAccountIds(prisma, [s.accountId])).toEqual([]);
    await setRiskHeartbeat(prisma, 31, 30);
    expect((await loadRiskOwners(prisma, [s.accountId])).get(s.accountId)).toBe("WEB");
    expect(await webOwnedAccountIds(prisma, [s.accountId])).toEqual([s.accountId]);
    await setRiskHeartbeat(prisma, null);
    expect((await loadRiskOwners(prisma, [s.accountId])).get(s.accountId)).toBe("WEB");
    // the threshold is the row's: the same 31 s old beat is fresh when the row says stale after 60 s
    await setRiskHeartbeat(prisma, 31, 60);
    expect((await loadRiskOwners(prisma, [s.accountId])).get(s.accountId)).toBe("RUST");
    await setRiskHeartbeat(prisma, 0);
  }, 30_000);

  it("assertRiskActorInTx: stale lets the WEB act and refuses the engine's actor; fresh is the other way round", async () => {
    const s = await stopOutScenario();
    const check = (actor: "WEB" | "RUST") => prisma.$transaction((tx) => assertRiskActorInTx(tx, s.accountId, actor));
    await setRiskHeartbeat(prisma, 40, 30);
    await check("WEB");
    await expect(check("RUST")).rejects.toBeInstanceOf(NotRiskOwnerError);
    await setRiskHeartbeat(prisma, null);
    await check("WEB");
    await expect(check("RUST")).rejects.toBeInstanceOf(NotRiskOwnerError);
    await setRiskHeartbeat(prisma, 1, 30);
    await check("RUST");
    await expect(check("WEB")).rejects.toBeInstanceOf(NotRiskOwnerError);
    await setRiskHeartbeat(prisma, 0);
  }, 30_000);

  it("a beat WAITS for a web transaction that has read the heartbeat (the share lock), so a stale reading cannot turn fresh under its action", async () => {
    const s = await stopOutScenario();
    await setRiskHeartbeat(prisma, 40, 30);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let checked!: () => void;
    const hasChecked = new Promise<void>((r) => (checked = r));
    const acting = prisma.$transaction(
      async (tx) => {
        await assertRiskActorInTx(tx, s.accountId, "WEB");
        checked();
        await gate;
        return "acted";
      },
      { timeout: 30_000 }
    );
    await hasChecked;
    let beat = false;
    const beating = prisma.$executeRaw`UPDATE "RiskEngineHeartbeat" SET "beatAt" = clock_timestamp() WHERE name = 'risk'`.then(() => (beat = true));
    let waiting = false;
    for (let i = 0; i < 200 && !waiting; i++) {
      const r = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE%RiskEngineHeartbeat%' AND query NOT ILIKE '%pg_stat_activity%'`;
      waiting = Number(r[0].n) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 25));
    }
    expect(waiting, "the beat is blocked on the web's FOR SHARE lock").toBe(true);
    expect(beat).toBe(false);
    release();
    expect(await acting).toBe("acted");
    await beating;
    await setRiskHeartbeat(prisma, 0);
  }, 60_000);
});

describe("the engine stalls, the web handles the stop-out exactly once, the engine returns: nothing is duplicated", () => {
  it("fresh heartbeat: the web leaves the engine's account alone", async () => {
    const s = await stopOutScenario();
    await setRiskHeartbeat(prisma, 2, 30);
    expect(await evaluateAccountRisk(s.accountId)).toEqual({ evaluated: false, slTpClosed: [], stopOutClosed: [] });
    expect(await openCount(s.accountId)).toBe(1);
    expect(await pnlRows(s.accountId)).toBe(0);
  }, 30_000);

  it("stale: the web stops the account out (every position once), and the returning engine's side finds nothing to do or duplicate", async () => {
    const s = await stopOutScenario(2);
    await setRiskHeartbeat(prisma, 45, 30); // the engine stalled 45 s ago
    const r = await evaluateAccountRisk(s.accountId);
    expect(r.evaluated).toBe(true);
    expect(r.stopOutClosed.length).toBeGreaterThan(0);
    expect(await openCount(s.accountId)).toBe(0);
    expect(await pnlRows(s.accountId)).toBe(2);
    // the engine returns (its first beat): the web skips the account again, and a second web evaluation (a late hook call) does nothing
    await setRiskHeartbeat(prisma, 0, 30);
    expect(await evaluateAccountRisk(s.accountId)).toEqual({ evaluated: false, slTpClosed: [], stopOutClosed: [] });
    expect(await pnlRows(s.accountId)).toBe(2);
    // each position was closed exactly once
    const dup = await prisma.$queryRaw<{ ref: string; n: number }[]>`SELECT "referenceId" AS ref, count(*)::int AS n FROM "Transaction" WHERE "accountId" = ${s.accountId} AND type = 'TRADE_PNL' GROUP BY 1 HAVING count(*) > 1`;
    expect(dup).toEqual([]);
    // a web close leaves no engine follow-up row
    expect(await prisma.postCloseEffect.count({ where: { brokerId: s.brokerId } })).toBe(0);
  }, 60_000);
});
