import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";

// Interim daily swap (overnight holding fee) rollover for every broker
// still on the legacy Prisma trading path -- which is every broker today,
// see docs/architecture.md's Phase 5 status re-check: Broker.executionEngine
// exists but no app/api/trade/* route reads it yet, so the Rust engine's
// own equivalent (engine/order-management/src/swap.rs) never actually
// charges a real position. This job exists so open positions accrue real
// swap before that cutover happens, not after.
//
// Mirrors swap.rs's calculation and idempotency semantics deliberately
// exactly (Wednesday 3x, rate * volume * multiplier, claim-before-charge
// via a lastSwapAt date guard, weekday read from Postgres's own
// CURRENT_DATE rather than this process's clock) so the numbers this job
// has already produced line up with what the engine would have produced,
// once a broker cuts over.
//
// One deliberate divergence, flagged rather than silently matched: this
// job resolves a GroupSymbolConfig override before falling back to
// BrokerSymbol's broker-wide rate -- the same resolution order
// lib/group-pricing.ts's resolveSymbolPricing already uses for
// spreadMarkup/commissionPerLot. swap.rs has no such step; it only ever
// reads BrokerSymbol. If a broker sets a group-level swap override, this
// job and the engine will disagree once that broker cuts over, until the
// engine gains the same group-resolution step. Worth fixing on the
// engine side before any broker with a group swap override actually cuts
// over -- not fixed here, since matching the engine's own current
// (incomplete) behavior would mean silently ignoring config a broker
// admin can see and has set.
type Db = PrismaClient | Prisma.TransactionClient;

// Same withTx shape as lib/bulk-close.ts/lib/close-by.ts's own (see
// either file's comment) -- runs `fn` in a real new transaction when `db`
// is the top-level client (every real caller), or directly against `db`
// when it's already a transaction client (a test that wraps its own
// fixture setup + this call in one outer transaction it rolls back at
// the end).
async function withTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return (db as PrismaClient).$transaction(fn);
  }
  return fn(db as Prisma.TransactionClient);
}

// Mirrors swap.rs's swap_multiplier exactly: 3x on Wednesday (ISO
// weekday 3, Monday=1) rolls Fri/Sat/Sun's holding into one charge, the
// common MT5-broker convention; any other value -- including an
// out-of-range one, a schema-level surprise rather than something to
// throw over -- falls back to the safe 1x, same as the Rust version.
// Not broker-configurable, matching swap.rs's own deliberate
// simplification.
export function swapMultiplier(isoWeekday: number): Prisma.Decimal {
  return isoWeekday === 3 ? new Prisma.Decimal(3) : new Prisma.Decimal(1);
}

// `rate` is whichever of swapLong/swapShort resolveSwapRate below picked
// -- account currency per lot per day. Sign comes straight from `rate`,
// same as compute_swap in swap.rs: a broker can configure a credit, not
// just a cost, this never forces one.
export function computeSwapAmount(rate: Prisma.Decimal, volume: Prisma.Decimal, multiplier: Prisma.Decimal): Prisma.Decimal {
  return rate.mul(volume).mul(multiplier);
}

export type SwapOverride = { swapLong: Prisma.Decimal; swapShort: Prisma.Decimal } | null;

// Group override beats the broker-wide default -- see this module's own
// comment above for why that's a deliberate divergence from swap.rs.
export function resolveSwapRate(params: {
  side: "BUY" | "SELL";
  groupOverride: SwapOverride;
  brokerSwapLong: Prisma.Decimal;
  brokerSwapShort: Prisma.Decimal;
}): Prisma.Decimal {
  const source = params.groupOverride ?? { swapLong: params.brokerSwapLong, swapShort: params.brokerSwapShort };
  return params.side === "BUY" ? source.swapLong : source.swapShort;
}

// ISO weekday (Monday=1..Sunday=7) for CURRENT_DATE, from Postgres's own
// clock -- same one-clock reasoning as lib/live-price.ts's staleness
// filter and swap.rs's own get_current_weekday: no dependency on
// whatever machine happens to run this code.
export async function getCurrentIsoWeekday(db: Db): Promise<number> {
  const rows = await db.$queryRaw<{ dow: number }[]>`SELECT EXTRACT(ISODOW FROM CURRENT_DATE)::int AS dow`;
  return rows[0].dow;
}

type DueRow = {
  id: string;
  brokerId: string;
  accountId: string;
  symbolId: string;
  side: "BUY" | "SELL";
  volume: Prisma.Decimal;
  groupId: string | null;
};

export type SwapRolloverBrokerSummary = {
  brokerId: string;
  positionsClaimed: number;
  positionsCharged: number;
  totalAmount: string;
};

export type SwapRolloverSummary = {
  isoWeekday: number;
  multiplier: string;
  brokers: SwapRolloverBrokerSummary[];
};

// One full pass: every OPEN position not yet charged today gets claimed
// and priced. `isoWeekdayOverride` exists only so tests can force a
// specific weekday (Wednesday-3x, a normal day) deterministically instead
// of waiting for a real one to roll around -- production always omits it
// and reads Postgres's own CURRENT_DATE, same "one clock" rule as
// everything else here. `accountIdsOverride` exists only so a test
// running against the live DB (this repo has no separate test database --
// see every other *.test.ts here) can scope a run to its own rolled-back
// fixture instead of claiming (and row-locking, for the outer
// transaction's whole duration) every real OPEN position on the
// platform, which both pollutes that test's own assertions with
// unrelated brokers' data and contends with whatever other test file
// happens to be running concurrently against the same rows. Production
// always omits it -- a real run has no reason to skip any broker.
export async function runSwapRollover(
  db: Db,
  opts?: { isoWeekdayOverride?: number; accountIdsOverride?: string[] }
): Promise<SwapRolloverSummary> {
  const isoWeekday = opts?.isoWeekdayOverride ?? (await getCurrentIsoWeekday(db));
  const multiplier = swapMultiplier(isoWeekday);

  const due = await db.$queryRaw<DueRow[]>`
    SELECT p.id, p."brokerId", p."accountId", p."symbolId", p.side::text as side, p.volume, a."groupId"
    FROM "Position" p
    JOIN "Account" a ON a.id = p."accountId"
    WHERE p.status = 'OPEN' AND (p."lastSwapAt" IS NULL OR p."lastSwapAt"::date < CURRENT_DATE)
      AND (${opts?.accountIdsOverride ?? null}::text[] IS NULL OR p."accountId" = ANY(${opts?.accountIdsOverride ?? null}::text[]))
  `;

  if (due.length === 0) return { isoWeekday, multiplier: multiplier.toString(), brokers: [] };

  // Batch-fetch every group override and broker default this run's
  // positions could possibly need -- one query each, not one per
  // position, same "fetch once, reuse via a Map" shape as
  // lib/bulk-close.ts's own fresh-price fetch.
  const groupIds = [...new Set(due.map((p) => p.groupId).filter((g): g is string => g != null))];
  const symbolIds = [...new Set(due.map((p) => p.symbolId))];
  const brokerIds = [...new Set(due.map((p) => p.brokerId))];

  const [groupOverrides, brokerSymbols] = await Promise.all([
    groupIds.length > 0
      ? db.groupSymbolConfig.findMany({ where: { groupId: { in: groupIds }, symbolId: { in: symbolIds } } })
      : Promise.resolve([]),
    db.brokerSymbol.findMany({ where: { brokerId: { in: brokerIds }, symbolId: { in: symbolIds } } }),
  ]);

  const groupOverrideMap = new Map(groupOverrides.map((g) => [`${g.groupId}:${g.symbolId}`, g]));
  const brokerSymbolMap = new Map(brokerSymbols.map((b) => [`${b.brokerId}:${b.symbolId}`, b]));

  const byAccount = new Map<string, DueRow[]>();
  for (const p of due) {
    const list = byAccount.get(p.accountId) ?? [];
    list.push(p);
    byAccount.set(p.accountId, list);
  }

  const brokerTotals = new Map<string, { positionsClaimed: number; positionsCharged: number; totalAmount: Prisma.Decimal }>();

  for (const [accountId, positions] of byAccount) {
    await withTx(db, async (tx) => {
      let accountTotal = new Prisma.Decimal(0);
      let claimedCount = 0;
      let chargedCount = 0;
      const brokerId = positions[0].brokerId;

      for (const p of positions) {
        // Claim first: another concurrent pass (shouldn't happen with a
        // single cron invocation, but matches the idempotent-claim
        // pattern swap.rs itself uses) may have already charged this
        // position for today between the list read above and this
        // transaction starting.
        const claimed = await tx.$executeRaw`
          UPDATE "Position" SET "lastSwapAt" = now()
          WHERE id = ${p.id} AND status = 'OPEN'
            AND ("lastSwapAt" IS NULL OR "lastSwapAt"::date < CURRENT_DATE)
        `;
        if (claimed === 0) continue;
        claimedCount++;

        const brokerSymbol = brokerSymbolMap.get(`${p.brokerId}:${p.symbolId}`);
        const groupOverride = p.groupId ? (groupOverrideMap.get(`${p.groupId}:${p.symbolId}`) ?? null) : null;
        const rate = resolveSwapRate({
          side: p.side,
          groupOverride,
          brokerSwapLong: brokerSymbol?.swapLong ?? new Prisma.Decimal(0),
          brokerSwapShort: brokerSymbol?.swapShort ?? new Prisma.Decimal(0),
        });
        const amount = computeSwapAmount(rate, p.volume, multiplier);
        // Zero-swap symbol/config: position is still claimed (so it's not
        // re-attempted today) but nothing to charge -- same "skip the
        // no-op write" convention lib/group-pricing.ts's chargeCommission
        // already uses.
        if (amount.isZero()) continue;

        chargedCount++;
        accountTotal = accountTotal.add(amount);
        await tx.position.update({ where: { id: p.id }, data: { swap: { increment: amount } } });
      }

      if (claimedCount === 0) return;

      if (!accountTotal.isZero()) {
        const account = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
        const balanceBefore = account.balance;
        const balanceAfter = balanceBefore.add(accountTotal);
        await tx.account.update({ where: { id: accountId }, data: { balance: balanceAfter } });
        await tx.transaction.create({
          data: {
            brokerId,
            accountId,
            type: "SWAP",
            status: "COMPLETED",
            amount: accountTotal,
            balanceBefore,
            balanceAfter,
            note: `Swap rollover: ${chargedCount} position${chargedCount === 1 ? "" : "s"}${multiplier.equals(3) ? " (Wednesday 3x)" : ""}`,
          },
        });
      }

      const running = brokerTotals.get(brokerId) ?? { positionsClaimed: 0, positionsCharged: 0, totalAmount: new Prisma.Decimal(0) };
      running.positionsClaimed += claimedCount;
      running.positionsCharged += chargedCount;
      running.totalAmount = running.totalAmount.add(accountTotal);
      brokerTotals.set(brokerId, running);
    });
  }

  // One AuditLog summary row per broker that had at least one position
  // claimed this run -- confirms the job actually ran even on a day
  // every position happened to price at zero swap, distinct from "this
  // broker's job silently never runs." Best-effort, outside any single
  // account's own transaction above (it summarizes across all of them) --
  // a failure here never unwinds a charge that already committed.
  for (const [brokerId, totals] of brokerTotals) {
    if (totals.positionsClaimed === 0) continue;
    await db.auditLog.create({
      data: {
        brokerId,
        action: "SWAP_ROLLOVER_RUN",
        entityType: "Broker",
        entityId: brokerId,
        newValue: {
          isoWeekday,
          multiplier: multiplier.toString(),
          positionsClaimed: totals.positionsClaimed,
          positionsCharged: totals.positionsCharged,
          totalAmount: totals.totalAmount.toString(),
        },
      },
    });
  }

  return {
    isoWeekday,
    multiplier: multiplier.toString(),
    brokers: [...brokerTotals.entries()].map(([brokerId, t]) => ({
      brokerId,
      positionsClaimed: t.positionsClaimed,
      positionsCharged: t.positionsCharged,
      totalAmount: t.totalAmount.toString(),
    })),
  };
}
