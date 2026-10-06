// Rust cutover Stage 6: the HANDOFF. The web's prefilter (lib/risk-owner.ts loadRiskOwners / webOwnedAccountIds) is a read
// that can be a moment stale: the owner can flip to RUST between that read and the write. Here the prefilter is made to LIE
// (every account is reported WEB-owned) while the database says the engine owns them, and the web evaluator is run anyway:
// every write re-checks the owner inside its own transaction (assertRiskActorInTx), so the web still acts on nothing.
// Remove the in-transaction check and these tests fail (scripts/stage6/mutation-check.sh, mutation M2).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return { ...real, publishTradingEvent: vi.fn(async () => {}) };
});
// the stale prefilter: it says everyone is the web's
vi.mock("@/lib/risk-owner", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/risk-owner")>();
  return {
    ...real,
    loadRiskOwners: vi.fn(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, "WEB" as const]))),
    webOwnedAccountIds: vi.fn(async (_db: unknown, ids: string[]) => ids),
  };
});

import { prisma } from "@/lib/prisma";
import { evaluateAccountRisk, evaluateAccountsRisk } from "@/lib/risk-monitor";
import { closePositionInTx } from "@/lib/position-close";
import { NotRiskOwnerError } from "@/lib/risk-owner";

const D = (v: number | string) => new Prisma.Decimal(v);
const brokers: string[] = [];
const symbols: string[] = [];
let seq = 0;

async function scenario(kind: "SO" | "SL" | "MC") {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `stale ${sfx}`, subdomain: `zstale-${sfx}`, riskAuthority: "RUST", riskAuthorityDemoOnly: false } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `ZT${sfx.toUpperCase()}`, baseCurrency: "ZST", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "CRYPTO" } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D(90), ask: D(90), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `ZT-${sfx}`, leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50) } });
  seq++;
  const balance = kind === "SO" ? 20 : kind === "MC" ? 80 : 100000;
  const a = await prisma.account.create({
    data: { brokerId: b.id, groupId: g.id, accountNumber: `7${String(Date.now() % 1000000).padStart(6, "0")}${seq}`.slice(0, 12), email: `zt${seq}-${sfx}@x.local`, passwordHash: "x", fullName: kind, accountMode: "LIVE", leverage: 1, balance: D(balance) },
  });
  const order = await prisma.order.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", filledPrice: D(100), filledAt: new Date(), idempotencyKey: `zt-${a.id}` } });
  const p = await prisma.position.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(100), slPrice: kind === "SL" ? D(95) : null } });
  return { brokerId: b.id, accountId: a.id, positionId: p.id, symbol: sym.name };
}

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

describe("a stale prefilter cannot make the web act on an engine-owned account", () => {
  for (const kind of ["SO", "SL"] as const) {
    it(`${kind}: the risk close is refused inside its transaction, nothing is written`, async () => {
      const s = await scenario(kind);
      const r = await evaluateAccountRisk(s.accountId);
      expect(r).toEqual({ evaluated: false, slTpClosed: [], stopOutClosed: [] });
      expect((await prisma.position.findUniqueOrThrow({ where: { id: s.positionId } })).status).toBe("OPEN");
      expect(await prisma.transaction.count({ where: { accountId: s.accountId } })).toBe(0);
      expect(Number((await prisma.account.findUniqueOrThrow({ where: { id: s.accountId } })).balance)).toBe(kind === "SO" ? 20 : 100000);
    }, 30_000);
  }

  it("MC: the margin-call notice is refused inside its transaction: no flag, no notification", async () => {
    const s = await scenario("MC");
    const r = await evaluateAccountRisk(s.accountId);
    expect(r.evaluated).toBe(true); // nothing to close: it got as far as pass 3
    expect((await prisma.account.findUniqueOrThrow({ where: { id: s.accountId } })).marginCallNotifiedAt).toBeNull();
    expect(await prisma.notification.count({ where: { entityId: s.accountId } })).toBe(0);
  }, 30_000);

  it("the batch entry (hook / backstop shape) with the lying prefilter: still nothing", async () => {
    const all = [await scenario("SO"), await scenario("SL"), await scenario("MC")];
    expect(await evaluateAccountsRisk(all.map((s) => s.accountId), "stale test")).toBe(0);
    for (const s of all) expect((await prisma.position.findUniqueOrThrow({ where: { id: s.positionId } })).status).toBe("OPEN");
    expect(await prisma.notification.count({ where: { brokerId: { in: all.map((s) => s.brokerId) } } })).toBe(0);
  }, 60_000);

  it("closePositionInTx with a riskActor of the wrong side throws NotRiskOwnerError and the transaction leaves no trace", async () => {
    const s = await scenario("SL");
    const position = await prisma.position.findUniqueOrThrow({ where: { id: s.positionId }, include: { symbol: true } });
    await expect(
      prisma.$transaction((tx) =>
        closePositionInTx(tx, { position: { id: position.id, accountId: s.accountId, brokerId: s.brokerId, side: "BUY", openPrice: position.openPrice, volume: position.volume, symbol: { contractSize: position.symbol.contractSize } }, closePrice: D(90), riskActor: "WEB" })
      )
    ).rejects.toBeInstanceOf(NotRiskOwnerError);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: s.positionId } })).status).toBe("OPEN");
    expect(await prisma.transaction.count({ where: { accountId: s.accountId } })).toBe(0);
    // the same close as the owner goes through
    const ok = await prisma.$transaction((tx) =>
      closePositionInTx(tx, { position: { id: position.id, accountId: s.accountId, brokerId: s.brokerId, side: "BUY", openPrice: position.openPrice, volume: position.volume, symbol: { contractSize: position.symbol.contractSize } }, closePrice: D(90), riskActor: "RUST" })
    );
    expect(ok.closed).toBe(true);
  }, 30_000);
});
