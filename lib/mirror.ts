import "server-only";
import { Prisma, PrismaClient, MirrorRule, OrderSide } from "@prisma/client";
import { openPositionFromOrder } from "@/lib/dealing";
import { resolveSymbolPricing, applySpreadMarkup, resolveBookType } from "@/lib/group-pricing";
import { checkAccountPreTradeMargin } from "@/lib/margin";
import { checkSymbolTradingMode, checkTradingSession } from "@/lib/risk";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";
import { closePositionInTx } from "@/lib/position-close";
import { createNotification } from "@/lib/notifications";

// docs/briefs/VYX-MIRROR-V0-BRIEF.md -- v0 hooks the legacy order-fill and
// position-close paths directly (see the two call sites: app/api/trade/
// orders/route.ts's MARKET branch, app/api/trade/positions/[id]/close/
// route.ts). Both hooks are called AFTER that route's own transaction has
// committed, with THEIR OWN separate transaction for the mirror's write --
// never the same one as the client's trade, so a mirror failure can never
// roll back or block the client's own fill/close. Phase 3 rewires the
// call sites to the Rust engine's fill events instead; everything in this
// file (matching, rounding, caps, the DB writes themselves) stays as-is.

type Db = PrismaClient | Prisma.TransactionClient;

// Runs `fn` in its own real transaction when `db` is the top-level client
// (every real caller), or just runs it directly against `db` when `db` is
// already a transaction client (a test that wraps its own setup +
// onFill/onClose call in one outer transaction it rolls back at the end,
// so the mirror's write shares that same rollback instead of needing a
// second, nested one -- Prisma transaction clients can't open their own
// nested $transaction). Either way the caller gets atomicity for the
// mirror's own writes; only WHERE that atomicity is scoped differs.
async function withTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return (db as PrismaClient).$transaction(fn);
  }
  return fn(db as Prisma.TransactionClient);
}

export type MirrorSourcePosition = {
  id: string;
  brokerId: string;
  accountId: string;
  symbolId: string;
  symbolName: string;
  side: OrderSide;
  volume: Prisma.Decimal;
};

export type MirrorSourceClose = {
  positionId: string;
  brokerId: string;
  closedLots: Prisma.Decimal; // volume just closed on the source (full or partial)
  sourceVolumeBeforeClose: Prisma.Decimal; // source position's volume immediately before this close
};

const oppositeSide = (side: OrderSide): OrderSide => (side === "BUY" ? "SELL" : "BUY");

// Pure -- no DB, directly unit-testable. Empty/null filter = every symbol
// the source trades is mirrored (the brief's own "null = all" default).
export function matchesSymbolFilter(filter: string | null | undefined, symbolName: string): boolean {
  if (!filter || !filter.trim()) return true;
  const allowed = filter
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return allowed.includes(symbolName.toUpperCase());
}

// Pure -- no DB. Rounds source volume × multiplier to the nearest lotStep
// increment at or above minLot, clamped to [minLot, maxLot]. A result
// that rounds to (or below) zero is clamped UP to minLot rather than
// silently mirroring nothing -- v0's stance is "never silently drop a
// mirror because the math rounded small," matching the brief's own
// "min/max respected" instruction; a broker wanting mirrors smaller than
// a symbol's minLot needs a smaller-minLot target symbol config instead,
// not a silent no-op here.
export function roundMirrorVolume(
  sourceVolume: Prisma.Decimal,
  multiplier: Prisma.Decimal,
  minLot: Prisma.Decimal,
  maxLot: Prisma.Decimal,
  lotStep: Prisma.Decimal
): Prisma.Decimal {
  const raw = sourceVolume.mul(multiplier);
  if (raw.lte(0)) return new Prisma.Decimal(0);
  if (lotStep.lte(0)) {
    return Prisma.Decimal.max(minLot, Prisma.Decimal.min(raw, maxLot));
  }
  const steps = raw.sub(minLot).div(lotStep).round();
  let rounded = minLot.add(steps.mul(lotStep));
  if (rounded.lt(minLot)) rounded = minLot;
  if (rounded.gt(maxLot)) rounded = maxLot;
  return rounded;
}

// Pure -- no DB. A source position that's fully closed (proportion >= 1,
// modulo the source's own lot-step rounding leaving `closedLots` a hair
// under `sourceVolumeBeforeClose`) always fully closes the target too,
// regardless of any rounding a strict multiplication would introduce --
// never leaves an unclosably-tiny sliver open on the target side just
// because the proportional math came out to 99.97% of it.
export function computeProportionalCloseVolume(
  closedLots: Prisma.Decimal,
  sourceVolumeBeforeClose: Prisma.Decimal,
  targetVolume: Prisma.Decimal
): Prisma.Decimal {
  if (sourceVolumeBeforeClose.lte(0)) return targetVolume;
  const proportion = closedLots.div(sourceVolumeBeforeClose);
  if (proportion.gte(1)) return targetVolume;
  const proportional = targetVolume.mul(proportion);
  return proportional.gte(targetVolume) ? targetVolume : proportional;
}

async function recordMirrorFailure(db: Db, rule: MirrorRule, reason: string): Promise<void> {
  await db.mirrorRule.update({ where: { id: rule.id }, data: { failureCount: { increment: 1 } } });
  await db.auditLog.create({
    data: { brokerId: rule.brokerId, action: "MIRROR_FAILED", entityType: "MirrorRule", entityId: rule.id, oldValue: {}, newValue: { reason } },
  });
}

async function triggerKillSwitch(db: Db, rule: MirrorRule, reason: string): Promise<void> {
  await db.mirrorRule.update({ where: { id: rule.id }, data: { enabled: false, killedAt: new Date() } });
  await db.auditLog.create({
    data: { brokerId: rule.brokerId, action: "MIRROR_KILL_SWITCH", entityType: "MirrorRule", entityId: rule.id, oldValue: {}, newValue: { reason } },
  });
  await createNotification(db, {
    brokerId: rule.brokerId,
    type: "MIRROR_KILL_SWITCH",
    title: "Mirror rule kill switch triggered",
    body: `Rule ${rule.id}: ${reason}`,
    entityType: "MirrorRule",
    entityId: rule.id,
  });
}

// "Before each mirror fill" (the brief's own wording) -- checks the
// CURRENT state (not a projection of what this fill would add), so a rule
// that's already over a cap gets killed and this fill skipped; the fill
// that would have tipped it over is itself caught by the very next call.
// DB check per fill, not a cached rule -- see the brief's own "10s max, or
// check DB per fill -- volume is low, DB check is fine for v0" note.
async function checkKillSwitch(db: Db, rule: MirrorRule): Promise<{ killed: boolean; reason?: string }> {
  if (rule.maxOpenLots != null) {
    const links = await db.mirrorLink.findMany({ where: { ruleId: rule.id }, select: { targetPositionId: true } });
    if (links.length > 0) {
      const agg = await db.position.aggregate({
        where: { id: { in: links.map((l) => l.targetPositionId) }, status: "OPEN" },
        _sum: { volume: true },
      });
      const openLots = agg._sum.volume ?? new Prisma.Decimal(0);
      if (openLots.gte(rule.maxOpenLots)) {
        return { killed: true, reason: `maxOpenLots breached: ${openLots} >= ${rule.maxOpenLots}` };
      }
    }
  }

  if (rule.maxDailyLoss != null) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const realizedAgg = await db.transaction.aggregate({
      where: { accountId: rule.targetAccountId, type: "TRADE_PNL", createdAt: { gte: startOfToday } },
      _sum: { amount: true },
    });
    const realizedToday = realizedAgg._sum.amount ?? new Prisma.Decimal(0);

    const openPositions = await db.position.findMany({
      where: { accountId: rule.targetAccountId, status: "OPEN" },
      select: { side: true, volume: true, openPrice: true, symbol: { select: { name: true, contractSize: true } } },
    });
    const priceBySymbol = await getFreshPrices([...new Set(openPositions.map((p) => p.symbol.name))]);
    let floating = new Prisma.Decimal(0);
    for (const p of openPositions) {
      const live = priceBySymbol.get(p.symbol.name);
      if (!live) continue; // no fresh price -- excluded from floating, same "can't value it, don't guess" convention as checkAccountPreTradeMargin
      const cp = p.side === "BUY" ? live.bid : live.ask;
      floating = floating.add(
        computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: cp, volume: p.volume, contractSize: p.symbol.contractSize })
      );
    }

    const totalPnl = realizedToday.add(floating);
    if (totalPnl.lte(rule.maxDailyLoss.neg())) {
      return { killed: true, reason: `maxDailyLoss breached: ${totalPnl} <= -${rule.maxDailyLoss}` };
    }
  }

  return { killed: false };
}

/// Called at the end of the source order's own fill transaction, once it
/// has committed. Finds every enabled rule whose source matches this
/// position's account or group, and mirrors the fill onto each rule's
/// target -- best-effort per rule: one rule failing (margin, market
/// closed, kill switch) never affects another rule, and never affects the
/// client's own trade (this function never throws out to its caller).
export async function onFill(db: Db, source: MirrorSourcePosition): Promise<void> {
  const account = await db.account.findUnique({ where: { id: source.accountId }, select: { groupId: true } });
  const sourceMatches: Prisma.MirrorRuleWhereInput[] = [{ sourceType: "ACCOUNT", sourceId: source.accountId }];
  if (account?.groupId) sourceMatches.push({ sourceType: "GROUP", sourceId: account.groupId });

  // Every rule whose source matches, enabled or not -- a disabled/killed
  // rule still needs to be seen here so a genuine match against it can be
  // logged (MIRROR_SKIPPED_RULE_DISABLED) instead of vanishing silently.
  // Without this, "no MirrorLink and no MIRROR_FAILED row" was ambiguous:
  // did nothing match, or did a real rule just not fire?
  const rules = await db.mirrorRule.findMany({
    where: { brokerId: source.brokerId, OR: sourceMatches },
  });

  for (const rule of rules) {
    if (!matchesSymbolFilter(rule.symbolFilter, source.symbolName)) continue;
    if (!rule.enabled) {
      await recordSkippedDisabledRule(db, rule, source).catch(() => {
        // even the skip-log write failed (DB down?) -- nothing left to do
        // that wouldn't risk affecting the client's own trade
      });
      continue;
    }
    await mirrorFillForRule(db, rule, source);
  }
}

// Convenience for every fill call site: they already hold the just-opened
// Position row (openPositionFromOrder's return value, or their own fresh
// tx.position.create) -- this avoids re-typing all six MirrorSourcePosition
// fields by hand at each of them (the exact class of mistake/omission this
// function's existence is meant to make less likely going forward).
export async function onFillPosition(
  db: Db,
  position: { id: string; brokerId: string; accountId: string; symbolId: string; side: OrderSide; volume: Prisma.Decimal },
  symbolName: string
): Promise<void> {
  await onFill(db, {
    id: position.id,
    brokerId: position.brokerId,
    accountId: position.accountId,
    symbolId: position.symbolId,
    symbolName,
    side: position.side,
    volume: position.volume,
  });
}

async function recordSkippedDisabledRule(db: Db, rule: MirrorRule, source: MirrorSourcePosition): Promise<void> {
  await db.auditLog.create({
    data: {
      brokerId: rule.brokerId,
      action: "MIRROR_SKIPPED_RULE_DISABLED",
      entityType: "MirrorRule",
      entityId: rule.id,
      oldValue: {},
      newValue: {
        sourcePositionId: source.id,
        sourceSide: source.side,
        sourceVolume: source.volume.toString(),
        reason: rule.killedAt ? "rule killed by kill-switch" : "rule manually disabled",
      },
    },
  });
}

async function mirrorFillForRule(db: Db, rule: MirrorRule, source: MirrorSourcePosition): Promise<void> {
  try {
    const killCheck = await checkKillSwitch(db, rule);
    if (killCheck.killed) {
      await triggerKillSwitch(db, rule, killCheck.reason!);
      return;
    }

    const [targetAccount, brokerSymbol] = await Promise.all([
      db.account.findUnique({
        where: { id: rule.targetAccountId },
        include: { group: { select: { groupType: true, marginCallLevel: true } } },
      }),
      db.brokerSymbol.findFirst({
        where: { brokerId: rule.brokerId, symbolId: source.symbolId, enabled: true },
        include: { symbol: true, tradingSessions: true },
      }),
    ]);
    if (!targetAccount) {
      await recordMirrorFailure(db, rule, "target account not found");
      return;
    }
    if (!brokerSymbol) {
      await recordMirrorFailure(db, rule, "symbol not available for target broker (market closed?)");
      return;
    }

    const mirrorSide = rule.direction === "REVERSE" ? oppositeSide(source.side) : source.side;

    const tradabilityError =
      checkSymbolTradingMode(brokerSymbol.tradingMode, mirrorSide) ??
      checkTradingSession(brokerSymbol.tradingSessions, new Date());
    if (tradabilityError) {
      await recordMirrorFailure(db, rule, tradabilityError);
      return;
    }

    const volume = roundMirrorVolume(source.volume, rule.multiplier, brokerSymbol.minLot, brokerSymbol.maxLot, brokerSymbol.lotStep);
    if (volume.lte(0)) {
      await recordMirrorFailure(db, rule, "rounded mirror volume is zero");
      return;
    }

    const livePrice = await db.livePrice.findUnique({ where: { symbol: source.symbolName } });
    if (!livePrice) {
      await recordMirrorFailure(db, rule, "no live price for symbol (market closed?)");
      return;
    }

    const pricing = await resolveSymbolPricing(db, {
      groupId: targetAccount.groupId,
      symbolId: source.symbolId,
      brokerSpreadMarkup: brokerSymbol.spreadMarkup,
      brokerCommissionPerLot: brokerSymbol.commissionPerLot,
    });
    const serverRef = mirrorSide === "BUY" ? livePrice.ask : livePrice.bid;
    const fillPrice = applySpreadMarkup({ side: mirrorSide, price: serverRef, spreadMarkup: pricing.spreadMarkup, digits: brokerSymbol.symbol.digits });

    // checkAccountPreTradeMargin takes the real PrismaClient (it runs its
    // own reads outside any transaction, same as every existing caller) --
    // safe here because `db` is always the real client for every actual
    // hook call; a test that passes a tx client instead is exercising
    // paths that don't reach this margin check (see mirror.test.ts's own
    // notes on what's covered by a live-DB-gated test vs a pure one).
    const marginError = await checkAccountPreTradeMargin(db as PrismaClient, {
      accountId: rule.targetAccountId,
      leverage: targetAccount.leverage,
      marginCallLevel: targetAccount.group?.marginCallLevel ?? new Prisma.Decimal(100),
      newOrderContractSize: brokerSymbol.symbol.contractSize,
      newOrderVolume: volume,
      newOrderFillPrice: fillPrice,
    });
    if (marginError) {
      await recordMirrorFailure(db, rule, `insufficient margin (required ${marginError.required}, available ${marginError.available})`);
      return;
    }

    const bookType = targetAccount.group ? resolveBookType(targetAccount.group.groupType) : brokerSymbol.defaultBookType;

    await withTx(db, async (tx) => {
      const order = await tx.order.create({
        data: {
          brokerId: rule.brokerId,
          accountId: rule.targetAccountId,
          symbolId: source.symbolId,
          side: mirrorSide,
          type: "MARKET",
          volume,
          // Deterministic, not random -- a retried/duplicate onFill call
          // for the same (rule, source position) collides on this same
          // key (Order's own accountId+idempotencyKey unique constraint)
          // in addition to MirrorLink's sourcePositionId uniqueness below,
          // belt-and-suspenders for the brief's idempotency requirement.
          idempotencyKey: `mirror:${rule.id}:${source.id}`,
          status: "PENDING",
        },
      });
      // NO SL/TP on the mirrored position -- the brief's own explicit
      // instruction; master risk is the rule's caps, not per-trade stops.
      const position = await openPositionFromOrder(tx, order, fillPrice, bookType, pricing.commissionPerLot);

      // Idempotency: sourcePositionId is unique. A retried/duplicate
      // onFill for the same source position throws P2002 here, which
      // rolls back this entire transaction (the order/position/
      // commission just created included) instead of silently opening a
      // second mirror -- caught below, treated as a benign no-op, not a
      // real failure.
      await tx.mirrorLink.create({
        data: { ruleId: rule.id, sourcePositionId: source.id, targetPositionId: position.id },
      });
      await tx.auditLog.create({
        data: {
          brokerId: rule.brokerId,
          action: "MIRROR_FILLED",
          entityType: "Position",
          entityId: position.id,
          oldValue: { sourcePositionId: source.id, sourceSide: source.side, sourceVolume: source.volume.toString() },
          newValue: { mirrorSide, volume: volume.toString(), fillPrice: fillPrice.toString(), ruleId: rule.id },
        },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return; // already mirrored -- idempotent retry, not a real failure
    }
    await recordMirrorFailure(db, rule, err instanceof Error ? err.message : "unknown error").catch(() => {
      // even the failure-recording write failed (DB down?) -- nothing
      // left to do that wouldn't risk affecting the client's own trade
    });
  }
}

/// Called at the end of the source position's own close transaction, once
/// it has committed (full or partial). No-op if the source position was
/// never mirrored -- the common case for most positions. Idempotent: a
/// retried/duplicate onClose call finds the target position already
/// CLOSED and returns without touching it again.
export async function onClose(db: Db, closeEvent: MirrorSourceClose): Promise<void> {
  const link = await db.mirrorLink.findUnique({ where: { sourcePositionId: closeEvent.positionId } });
  if (!link) return;

  const rule = await db.mirrorRule.findUnique({ where: { id: link.ruleId } });
  if (!rule) return; // FK guarantees this can't happen; defensive only

  try {
    const targetPosition = await db.position.findUnique({
      where: { id: link.targetPositionId },
      include: { symbol: { select: { name: true, contractSize: true } } },
    });
    if (!targetPosition || targetPosition.status !== "OPEN") return; // already closed -- idempotent no-op

    const closeVolume = computeProportionalCloseVolume(closeEvent.closedLots, closeEvent.sourceVolumeBeforeClose, targetPosition.volume);

    const livePrice = await db.livePrice.findUnique({ where: { symbol: targetPosition.symbol.name } });
    if (!livePrice) {
      await recordMirrorFailure(db, rule, "no live price to close mirrored position (market closed?)");
      return;
    }
    const closePrice = targetPosition.side === "BUY" ? livePrice.bid : livePrice.ask;

    await withTx(db, (tx) =>
      closePositionInTx(tx, {
        position: {
          id: targetPosition.id,
          accountId: targetPosition.accountId,
          brokerId: targetPosition.brokerId,
          side: targetPosition.side,
          openPrice: targetPosition.openPrice,
          volume: targetPosition.volume,
          symbol: { contractSize: targetPosition.symbol.contractSize },
        },
        closePrice,
        closeVolume,
        note: `Mirror close (rule ${rule.id}, source position ${closeEvent.positionId})`,
      })
    );

    await db.auditLog.create({
      data: {
        brokerId: rule.brokerId,
        action: "MIRROR_CLOSED",
        entityType: "Position",
        entityId: targetPosition.id,
        oldValue: { sourcePositionId: closeEvent.positionId, sourceClosedLots: closeEvent.closedLots.toString() },
        newValue: { targetClosedLots: closeVolume.toString() },
      },
    });
  } catch (err) {
    await recordMirrorFailure(db, rule, err instanceof Error ? err.message : "unknown error").catch(() => {});
  }
}
