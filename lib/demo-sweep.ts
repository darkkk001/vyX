import "server-only";
import { prisma } from "@/lib/prisma";
import { closePositionInTx } from "@/lib/position-close";
import { loadHedgedMarginPct, DEFAULT_HEDGED_MARGIN_PCT } from "@/lib/margin";
import { isDemoSymbolName } from "@/lib/demo-prices";
import { acquireSweepLock, getDemoBrokerId, isGuestAccountNumber, readDemoState, releaseSweepLock, writeDemoState } from "@/lib/demo";
import { simulateSweep, type SimOrder, type SimPos, type SweepEvent, type SweepLimits, type SweepPorts } from "@/lib/demo-sweep-core";
import { resolveBookType } from "@/lib/group-pricing";

// Database side of the demo's lazy risk replay (the walk itself is lib/demo-sweep-core.ts). One guest account at a time:
// load its open positions and resting orders, replay the price path from the account's cursor (Redis, see lib/demo.ts) to
// now through the REAL close writer (closePositionInTx, so the ledger rows are exactly the live ones, with the close
// time and price of the moment the path crossed the level), and move the cursor.
//
// Cursor: Redis key demo:acct:<accountId> = { t: last replayed ms, w: 1 when the account may hold positions or resting
// orders }. No schema change. A lost key is harmless: the replay then starts from each item's own opening time.

export type SweepSummary = { events: SweepEvent[]; complete: boolean; openLeft: number; pendingLeft: number; reachedMs: number };

/** The guards every sweep and every delete share: the account must belong to the demo broker AND sit in the guest range. */
export async function isGuestOfDemoBroker(account: { brokerId: string; accountNumber: string }): Promise<boolean> {
  if (!isGuestAccountNumber(account.accountNumber)) return false;
  const demo = await getDemoBrokerId();
  return demo != null && demo === account.brokerId;
}

export async function sweepDemoAccount(accountId: string, nowMs: number = Date.now(), limits?: SweepLimits): Promise<SweepSummary | null> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true, brokerId: true, accountNumber: true, balance: true, credit: true, leverage: true, currency: true, status: true,
      group: { select: { stopOutLevel: true, marginCallLevel: true, category: true } },
      broker: { select: { hedgingAllowed: true, maxOpenPositionsPerAccount: true } },
    },
  });
  if (!account || !(await isGuestOfDemoBroker(account)) || !account.group) return null;
  if (account.currency !== "USD") return null; // the demo's accounts are USD (the FX leg of USDJPY assumes it)
  if (resolveBookType(account.group.category) !== "B_BOOK") return null; // the demo is B-book only

  const [posRows, orderRows, hedgedPct] = await Promise.all([
    prisma.position.findMany({
      where: { accountId, status: "OPEN" },
      select: { id: true, side: true, volume: true, openPrice: true, slPrice: true, tpPrice: true, openedAt: true, symbolId: true, symbol: { select: { name: true, contractSize: true, quoteCurrency: true } } },
    }),
    prisma.order.findMany({
      where: { accountId, status: "PENDING", type: { in: ["LIMIT", "STOP"] }, requestedPrice: { not: null }, closesPositionId: null },
      select: { id: true, side: true, type: true, volume: true, requestedPrice: true, slPrice: true, tpPrice: true, createdAt: true, symbolId: true, symbol: { select: { name: true } } },
    }),
    loadHedgedMarginPct(prisma, account.brokerId),
  ]);
  const symbolIdByName = new Map<string, string>();
  const positions: SimPos[] = [];
  for (const p of posRows) {
    if (!isDemoSymbolName(p.symbol.name)) continue;
    symbolIdByName.set(p.symbol.name, p.symbolId);
    positions.push({
      id: p.id, side: p.side, volume: p.volume, openPrice: p.openPrice, slPrice: p.slPrice, tpPrice: p.tpPrice, symbol: p.symbol.name,
      contractSize: p.symbol.contractSize, quoteCurrency: p.symbol.quoteCurrency, openedMs: p.openedAt.getTime(), hedgedMarginPct: hedgedPct.get(p.symbolId) ?? DEFAULT_HEDGED_MARGIN_PCT,
    });
  }
  const orders: SimOrder[] = [];
  for (const o of orderRows) {
    if (!isDemoSymbolName(o.symbol.name) || (o.type !== "LIMIT" && o.type !== "STOP")) continue;
    symbolIdByName.set(o.symbol.name, o.symbolId);
    orders.push({ id: o.id, side: o.side, type: o.type, volume: o.volume, entry: o.requestedPrice!, slPrice: o.slPrice, tpPrice: o.tpPrice, symbol: o.symbol.name, createdMs: o.createdAt.getTime() });
  }

  const state = await readDemoState(accountId);
  const fromMs = state?.t ?? 0;
  const accountRow = { id: account.id, brokerId: account.brokerId };

  const ports: SweepPorts = {
    async closePosition(p, closePrice, atMs, note) {
      const outcome = await prisma.$transaction((tx) =>
        closePositionInTx(tx, {
          position: { id: p.id, accountId, brokerId: accountRow.brokerId, side: p.side, openPrice: p.openPrice, volume: p.volume, symbol: { contractSize: p.contractSize } },
          closePrice,
          note,
          at: new Date(atMs),
        })
      );
      const fresh = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { balance: true, credit: true } });
      return { closed: outcome.closed, balance: fresh.balance, credit: fresh.credit };
    },
    async fillPending(o, fillPrice, atMs) {
      const symbolId = symbolIdByName.get(o.symbol)!;
      return prisma.$transaction(async (tx) => {
        const claimed = await tx.order.updateMany({ where: { id: o.id, status: "PENDING" }, data: { status: "FILLED", filledPrice: fillPrice, filledAt: new Date(atMs) } });
        if (claimed.count === 0) return null;
        const created = await tx.position.create({
          data: {
            brokerId: accountRow.brokerId, accountId, symbolId, originOrderId: o.id, side: o.side, volume: o.volume, openPrice: fillPrice,
            slPrice: o.slPrice, tpPrice: o.tpPrice, bookType: "B_BOOK", openedAt: new Date(atMs),
          },
          include: { symbol: { select: { name: true, contractSize: true, quoteCurrency: true } } },
        });
        await tx.auditLog.create({
          data: {
            brokerId: accountRow.brokerId, action: "ORDER_TRIGGERED_AND_FILLED", entityType: "Position", entityId: created.id,
            oldValue: { status: "PENDING", requestedPrice: o.entry.toString() }, newValue: { filledPrice: fillPrice.toString(), status: "FILLED", origin: "demo_sweep" },
          },
        });
        const sim: SimPos = {
          id: created.id, side: created.side, volume: created.volume, openPrice: created.openPrice, slPrice: created.slPrice, tpPrice: created.tpPrice, symbol: created.symbol.name,
          contractSize: created.symbol.contractSize, quoteCurrency: created.symbol.quoteCurrency, openedMs: atMs, hedgedMarginPct: hedgedPct.get(symbolId) ?? DEFAULT_HEDGED_MARGIN_PCT,
        };
        return sim;
      });
    },
    async rejectPending(o, reason, atMs) {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.order.updateMany({ where: { id: o.id, status: "PENDING" }, data: { status: "REJECTED", rejectionReason: reason } });
        if (claimed.count === 0) return;
        await tx.auditLog.create({
          data: {
            brokerId: accountRow.brokerId, action: "PENDING_ORDER_REJECTED_AT_TRIGGER", entityType: "Order", entityId: o.id,
            oldValue: { status: "PENDING", requestedPrice: o.entry.toString() }, newValue: { status: "REJECTED", reason, origin: "demo_sweep", at: new Date(atMs).toISOString() },
          },
        });
      });
    },
  };

  const result = await simulateSweep({
    account: { balance: account.balance, credit: account.credit, leverage: account.leverage, stopOutLevel: account.group.stopOutLevel, marginCallLevel: account.group.marginCallLevel },
    positions,
    orders,
    rules: { hedgingAllowed: account.broker.hedgingAllowed, maxOpenPositions: account.broker.maxOpenPositionsPerAccount },
    fromMs,
    toMs: nowMs,
    ports,
    limits,
  });
  await writeDemoState(accountId, { t: result.reachedMs, w: result.positions.length + result.orders.length > 0 ? 1 : 0 });
  return { events: result.events, complete: result.complete, openLeft: result.positions.length, pendingLeft: result.orders.length, reachedMs: result.reachedMs };
}

/** Sweep one guest if it may have something to replay. Serialised per account; a second caller waits briefly for the first. */
export async function sweepDemoAccountLocked(accountId: string, nowMs: number = Date.now()): Promise<SweepSummary | null> {
  if (await acquireSweepLock(accountId)) {
    try {
      return await sweepDemoAccount(accountId, nowMs);
    } finally {
      await releaseSweepLock(accountId);
    }
  }
  // somebody else is replaying this account right now: give them a moment, then carry on with whatever they wrote
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (await acquireSweepLock(accountId)) {
      await releaseSweepLock(accountId);
      return null;
    }
  }
  return null;
}

/** Guest accounts of the demo broker that hold an open position or a resting LIMIT/STOP order. */
export async function guestsWithWork(limit = 500): Promise<string[]> {
  const brokerId = await getDemoBrokerId();
  if (!brokerId) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT a.id FROM "Account" a
    WHERE a."brokerId" = ${brokerId} AND a."accountNumber" ~ '^48[0-9]{6}$'
      AND (EXISTS (SELECT 1 FROM "Position" p WHERE p."accountId" = a.id AND p.status = 'OPEN')
        OR EXISTS (SELECT 1 FROM "Order" o WHERE o."accountId" = a.id AND o.status = 'PENDING' AND o.type IN ('LIMIT', 'STOP')))
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/** For the cron: replay every guest with work. Returns how many were swept and how many events they produced. */
export async function sweepAllGuests(nowMs: number = Date.now(), limit = 500): Promise<{ accounts: number; events: number; incomplete: number }> {
  const ids = await guestsWithWork(limit);
  let events = 0;
  let incomplete = 0;
  for (const id of ids) {
    try {
      const r = await sweepDemoAccountLocked(id, nowMs);
      if (r) {
        events += r.events.length;
        if (!r.complete) incomplete++;
      }
    } catch (err) {
      console.error("demo-sweep: account failed", id, err);
    }
  }
  return { accounts: ids.length, events, incomplete };
}

