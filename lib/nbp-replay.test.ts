import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { closePositionInTx } from "@/lib/position-close";

// Negative-balance protection on the last close only (owner 2026-10-23, docs/NBP-LAST-CLOSE-DESIGN.md): account
// 50005696's 2026-10-22 sequence through the real web close (closePositionInTx), from the fixture the engine's
// book.rs unit test and tests/nbp_replay_db.rs replay too. Production wrote 14 write-offs ($530.71) for it; the rule
// now writes none while positions stay open and exactly one, for the whole deficit, when the last one closes.

type Step =
  | { kind: "close"; ticket: number; pnl: string; reason: "STOP_OUT" | "BULK" }
  | { kind: "open"; ticket: number; side: "BUY" | "SELL"; volume: string; commission: string };
type FixtureFile = {
  account: { balance: string; credit: string; negativeBalanceProtection: boolean };
  openAtStart: { ticket: number }[];
  steps: Step[];
  syntheticFinalCloses: { pnl: string; reason: "STOP_OUT"; tickets: number[] };
  expect: { afterRealStepsNbpRows: number; afterRealStepsBalance: string; finalNbpRows: number; finalWriteOff: string; finalWriteOffTicket: number; finalBalance: string };
};
const FX: FixtureFile = JSON.parse(readFileSync(join(__dirname, "..", "tests", "fixtures", "nbp-50005696-2026-10-22.json"), "utf8"));

const D = (v: string | number) => new Prisma.Decimal(v);
// every replayed position is 1 lot of XAUUSD (contract 100) opened at 4000: the close price that books exactly the
// fixture's P&L is 4000 + pnl / 100 (the money rule does not depend on the symbol)
const OPEN = D("4000");
const closePriceFor = (pnl: string) => OPEN.add(D(pnl).div(100));

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/nbp-replay.test.ts: DB unreachable, skipping");
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});

class RollbackSignal extends Error {}
async function withRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new RollbackSignal();
      },
      { timeout: 60_000 }
    );
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
}

describe("NBP replay: 50005696, 2026-10-22 (shared fixture, live web close, rolled back)", () => {
  it("writes nothing off mid-sequence and exactly one NBP row at the last close", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
      const broker = await tx.broker.create({ data: { name: `NBP Replay ${suffix}`, subdomain: `nbpreplay-${suffix}`, negativeBalanceProtection: FX.account.negativeBalanceProtection } });
      const symbol = await tx.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
      const group = await tx.group.create({ data: { brokerId: broker.id, name: `NBPR-${suffix}`, dealingMode: "AUTO" } });
      const account = await tx.account.create({
        data: { brokerId: broker.id, groupId: group.id, accountNumber: `4${suffix.slice(0, 7)}`, email: `nbpreplay-${suffix}@test.local`, passwordHash: "x", fullName: "NBP Replay", accountMode: "LIVE", balance: D(FX.account.balance), credit: D(FX.account.credit) },
      });

      const byTicket = new Map<number, string>();
      const open = async (ticket: number) => {
        const order = await tx.order.create({
          data: { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", filledPrice: OPEN, filledAt: new Date(), idempotencyKey: `nbpreplay:${randomUUID()}` },
        });
        const pos = await tx.position.create({ data: { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: OPEN, status: "OPEN" } });
        byTicket.set(ticket, pos.id);
        return pos.id;
      };
      const close = async (ticket: number, pnl: string) => {
        const id = byTicket.get(ticket)!;
        const outcome = await closePositionInTx(tx, { deal: { reason: "STOP_OUT" },
          position: { id, accountId: account.id, brokerId: broker.id, side: "BUY", openPrice: OPEN, volume: D(1), symbol: { contractSize: D(100) } },
          closePrice: closePriceFor(pnl),
        });
        expect(outcome.closed).toBe(true);
        if (outcome.closed) expect(outcome.realizedPnl.toFixed(2)).toBe(D(pnl).toFixed(2));
      };
      const balance = async () => (await tx.account.findUniqueOrThrow({ where: { id: account.id } })).balance;
      const nbpRows = () => tx.transaction.findMany({ where: { accountId: account.id, type: "NEGATIVE_BALANCE_PROTECTION" } });

      for (const p of FX.openAtStart) await open(p.ticket);
      let minBalance = D(FX.account.balance);
      for (const s of FX.steps) {
        if (s.kind === "open") {
          const id = await open(s.ticket);
          // the open's COMMISSION row, as the open path writes it (no floor)
          const before = await balance();
          await tx.account.update({ where: { id: account.id }, data: { balance: before.add(D(s.commission)) } });
          await tx.transaction.create({
            data: { brokerId: broker.id, accountId: account.id, type: "COMMISSION", status: "COMPLETED", amount: D(s.commission), balanceBefore: before, balanceAfter: before.add(D(s.commission)), referenceType: "Position", referenceId: id },
          });
        } else {
          await close(s.ticket, s.pnl);
          expect(await nbpRows(), `ticket ${s.ticket}: no write-off while other positions are open`).toHaveLength(0);
        }
        const b = await balance();
        if (b.lt(minBalance)) minBalance = b;
      }
      expect(await nbpRows()).toHaveLength(FX.expect.afterRealStepsNbpRows);
      expect((await balance()).toFixed(2)).toBe(D(FX.expect.afterRealStepsBalance).toFixed(2));
      expect(minBalance.isNegative()).toBe(true);

      for (const t of FX.syntheticFinalCloses.tickets) await close(t, FX.syntheticFinalCloses.pnl);
      const rows = await nbpRows();
      expect(rows).toHaveLength(FX.expect.finalNbpRows);
      expect([rows[0].amount.toFixed(2), rows[0].referenceId]).toEqual([D(FX.expect.finalWriteOff).toFixed(2), byTicket.get(FX.expect.finalWriteOffTicket)]);
      expect((await balance()).toFixed(2)).toBe(D(FX.expect.finalBalance).toFixed(2));
      expect(await tx.auditLog.count({ where: { entityId: account.id, action: "NEGATIVE_BALANCE_PROTECTION_APPLIED" } })).toBe(1);
    });
  }, 120_000);
});
