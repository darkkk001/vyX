import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice, getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl, validateSlTp } from "@/lib/trading";
import { resolveBookType, applySpreadMarkup, resolveSymbolPricing, chargeCommission } from "@/lib/group-pricing";
import {
  checkTradingHalted,
  checkSymbolTradingMode,
  checkTradingSession,
  checkLotStep,
  checkGroupMaxLot,
  checkGroupTradingRestriction,
  checkGroupAllowedSymbol,
  checkMaxOpenPositions,
  checkSymbolExposure,
  checkBrokerExposure,
  checkMaxDailyLoss,
} from "@/lib/risk";
import * as mirror from "@/lib/mirror";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Everything app/manage/(shell)/positions/page.tsx's Server Component
// used to compute in one request (open positions + the account/symbol/
// group/IB option lists the exposure monitor's filters need) -- exposed
// here so PositionsManager.tsx can self-fetch and re-poll it (replacing
// the page's own 5s router.refresh() interval) instead of receiving it
// all as server-rendered props. A dedicated route rather than composing
// several existing ones: the IB option list in particular has to come
// from an unfiltered read of ibRelationship, not the IB_PAYOUTS-gated
// /api/manage/ib-relationships GET, since any Manager reaching this page
// (not just one with IB_PAYOUTS) needs the read-only IB filter dropdown.
export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const [positions, accountRows, brokerSymbolRows, groupRows, ibRelationships] = await Promise.all([
    prisma.position.findMany({
      where: { brokerId, status: "OPEN" },
      include: {
        account: {
          select: {
            accountNumber: true,
            fullName: true,
            groupId: true,
            group: { select: { name: true } },
            ibLinkAsClient: { select: { ibAccountId: true } },
          },
        },
        symbol: { select: { name: true, digits: true, contractSize: true } },
        originOrder: { select: { idempotencyKey: true } },
      },
      orderBy: { openedAt: "desc" },
    }),
    prisma.account.findMany({
      where: { brokerId, status: "ACTIVE" },
      select: { id: true, accountNumber: true, fullName: true },
      orderBy: { accountNumber: "asc" },
    }),
    prisma.brokerSymbol.findMany({
      where: { brokerId, enabled: true },
      include: { symbol: { select: { id: true, name: true } } },
      orderBy: { symbol: { name: "asc" } },
    }),
    prisma.group.findMany({ where: { brokerId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.ibRelationship.findMany({
      where: { brokerId },
      select: { ibAccountId: true, ibAccount: { select: { accountNumber: true, fullName: true } } },
    }),
  ]);

  const symbolNames = [...new Set(positions.map((p) => p.symbol.name))];
  const priceBySymbol = await getFreshPrices(symbolNames);

  const rows = positions.map((p) => {
    const lp = priceBySymbol.get(p.symbol.name);
    const currentPrice = lp ? (p.side === "BUY" ? lp.bid : lp.ask) : null;
    const floatingPnl = currentPrice
      ? computeRealizedPnl({
          side: p.side,
          openPrice: p.openPrice,
          closePrice: currentPrice,
          volume: p.volume,
          contractSize: p.symbol.contractSize,
        })
      : null;
    return {
      id: p.id,
      accountId: p.accountId,
      accountNumber: p.account.accountNumber,
      accountFullName: p.account.fullName,
      groupId: p.account.groupId,
      groupName: p.account.group?.name ?? null,
      ibAccountId: p.account.ibLinkAsClient?.ibAccountId ?? null,
      symbolName: p.symbol.name,
      digits: p.symbol.digits,
      side: p.side,
      volume: p.volume.toString(),
      openPrice: p.openPrice.toFixed(p.symbol.digits),
      currentPrice: currentPrice ? currentPrice.toFixed(p.symbol.digits) : null,
      floatingPnl: floatingPnl ? floatingPnl.toFixed(2) : null,
      slPrice: p.slPrice ? p.slPrice.toFixed(p.symbol.digits) : null,
      tpPrice: p.tpPrice ? p.tpPrice.toFixed(p.symbol.digits) : null,
      isManualOrigin: p.originOrder.idempotencyKey.startsWith("manual_"),
      openedAt: p.openedAt.toISOString().replace("T", " ").slice(0, 19),
    };
  });

  const accounts = accountRows.map((a) => ({ id: a.id, accountNumber: a.accountNumber, fullName: a.fullName }));
  const tradableSymbols = brokerSymbolRows.map((bs) => ({ id: bs.symbol.id, name: bs.symbol.name }));
  const groups = groupRows.map((g) => ({ id: g.id, name: g.name }));
  const ibOptions = [...new Map(ibRelationships.map((r) => [r.ibAccountId, r])).values()]
    .map((r) => ({ id: r.ibAccountId, accountNumber: r.ibAccount.accountNumber, fullName: r.ibAccount.fullName }))
    .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  return NextResponse.json({ rows, accounts, symbols: tradableSymbols, groups, ibOptions });
}

// Manual position open -- a dealing desk placing a MARKET trade for an
// account directly (correction, demo setup, favor), not the trader's
// own order flow (app/api/trade/orders/route.ts). Mirrors that route's
// lot-size validation and fill shape. `price` is optional: an explicit
// admin-typed price fills at exactly that value (confirmed with the
// user -- a dealer correcting a phone order often needs the trade
// booked at the price actually agreed with the client, not whatever
// the feed shows right now); omitting it falls back to the live
// LivePrice tick, same as before this was configurable.
export async function POST(request: NextRequest) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const accountId = typeof body?.accountId === "string" ? body.accountId : "";
  const symbolId = typeof body?.symbolId === "string" ? body.symbolId : "";
  const side = body?.side === "SELL" ? "SELL" : body?.side === "BUY" ? "BUY" : null;
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim() : null;

  if (!accountId || !symbolId || !side) {
    return NextResponse.json({ error: "accountId, symbolId, and side are required" }, { status: 400 });
  }

  // Optional -- see this route's own doc comment. A blank/missing value
  // means "use the live tick", same as before this was ever configurable.
  let explicitPrice: Prisma.Decimal | null = null;
  if (body?.price != null && String(body.price).trim() !== "") {
    try {
      explicitPrice = new Prisma.Decimal(String(body.price));
    } catch {
      return NextResponse.json({ error: "invalid price" }, { status: 400 });
    }
    if (explicitPrice.lte(0)) {
      return NextResponse.json({ error: "price must be positive" }, { status: 400 });
    }
  }
  let slPrice: Prisma.Decimal | null = null;
  if (body?.slPrice != null && String(body.slPrice).trim() !== "") {
    try {
      slPrice = new Prisma.Decimal(String(body.slPrice));
    } catch {
      return NextResponse.json({ error: "invalid slPrice" }, { status: 400 });
    }
  }
  let tpPrice: Prisma.Decimal | null = null;
  if (body?.tpPrice != null && String(body.tpPrice).trim() !== "") {
    try {
      tpPrice = new Prisma.Decimal(String(body.tpPrice));
    } catch {
      return NextResponse.json({ error: "invalid tpPrice" }, { status: 400 });
    }
  }

  let volume: Prisma.Decimal;
  try {
    volume = new Prisma.Decimal(String(body?.volume ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid volume" }, { status: 400 });
  }
  if (!volume.gt(0)) {
    return NextResponse.json({ error: "volume must be positive" }, { status: 400 });
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } },
  });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }
  if (account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account is not active" }, { status: 400 });
  }

  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId, symbolId, enabled: true },
    include: { symbol: true, tradingSessions: true },
  });
  if (!brokerSymbol) {
    return NextResponse.json({ error: "symbol not available for this broker" }, { status: 400 });
  }
  if (volume.lt(brokerSymbol.minLot) || volume.gt(brokerSymbol.maxLot)) {
    return NextResponse.json(
      { error: `volume must be between ${brokerSymbol.minLot} and ${brokerSymbol.maxLot}` },
      { status: 400 }
    );
  }

  // Risk checks -- see lib/risk.ts. Same checks and order as the
  // trader-facing route (app/api/trade/orders/route.ts) -- a manual
  // dealing-desk open must respect the same broker/symbol/account
  // policies as a trader's own order.
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
  const riskError =
    checkTradingHalted(broker) ??
    checkSymbolTradingMode(brokerSymbol.tradingMode, side) ??
    checkTradingSession(brokerSymbol.tradingSessions, new Date()) ??
    checkLotStep(volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
    (account.group ? checkGroupMaxLot(volume, account.group.maxLotSize) : null) ??
    (account.group ? checkGroupTradingRestriction(account.group.tradingRestriction, side) : null) ??
    (account.group
      ? checkGroupAllowedSymbol(
          account.group.restrictSymbols,
          account.group.allowedSymbols.map((s) => s.symbolId),
          brokerSymbol.symbolId
        )
      : null) ??
    (await checkMaxOpenPositions(prisma, accountId, broker.maxOpenPositionsPerAccount)) ??
    (await checkSymbolExposure(prisma, accountId, symbolId, volume, brokerSymbol.maxExposure)) ??
    (await checkBrokerExposure(prisma, brokerId, volume, broker.totalExposureLimit)) ??
    (await checkMaxDailyLoss(prisma, accountId, account.maxDailyLoss));
  if (riskError) {
    return NextResponse.json({ error: riskError }, { status: 400 });
  }

  let fillPrice: Prisma.Decimal;
  if (explicitPrice) {
    fillPrice = explicitPrice;
  } else {
    const price = await getFreshPrice(brokerSymbol.symbol.name);
    if (!price) {
      return NextResponse.json({ error: `no live price for ${brokerSymbol.symbol.name} -- type a price to open anyway` }, { status: 409 });
    }
    // BUY fills at ask, SELL fills at bid -- same convention as
    // engine/execution's execute_market_order.
    fillPrice = side === "BUY" ? price.ask : price.bid;
  }

  // See lib/group-pricing.ts's own comments -- a group's
  // GroupSymbolConfig overrides this symbol's broker-wide pricing, and
  // spread markup widens a BUY fill (a SELL fills at bid, unaffected).
  // SL/TP are validated against the actual fill price the position will
  // open at, markup included.
  const pricing = await resolveSymbolPricing(prisma, {
    groupId: account.groupId,
    symbolId: brokerSymbol.symbolId,
    brokerSpreadMarkup: brokerSymbol.spreadMarkup,
    brokerCommissionPerLot: brokerSymbol.commissionPerLot,
  });
  fillPrice = applySpreadMarkup({ side, price: fillPrice, spreadMarkup: pricing.spreadMarkup, digits: brokerSymbol.symbol.digits });

  const slTpError = validateSlTp({ side, referencePrice: fillPrice, slPrice, tpPrice });
  if (slTpError) {
    return NextResponse.json({ error: slTpError }, { status: 400 });
  }

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        brokerId,
        accountId,
        symbolId,
        side,
        type: "MARKET",
        volume,
        requestedPrice: fillPrice,
        slPrice,
        tpPrice,
        idempotencyKey: `manual_${randomUUID()}`,
        status: "FILLED",
        filledPrice: fillPrice,
        filledAt: new Date(),
      },
    });
    const position = await tx.position.create({
      data: {
        brokerId,
        accountId,
        symbolId,
        originOrderId: order.id,
        side,
        volume,
        openPrice: fillPrice,
        slPrice,
        tpPrice,
        bookType: account.group ? resolveBookType(account.group.groupType) : brokerSymbol.defaultBookType,
      },
    });
    await chargeCommission(tx, { brokerId, accountId, positionId: position.id, commissionPerLot: pricing.commissionPerLot, volume });

    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "MANUAL_POSITION_OPEN",
        entityType: "Position",
        entityId: position.id,
        newValue: {
          accountId,
          accountNumber: account.accountNumber,
          symbol: brokerSymbol.symbol.name,
          side,
          volume: volume.toString(),
          openPrice: fillPrice.toString(),
          // Optional dealing-desk reason, e.g. "Phone order -- client
          // unable to access platform" -- no schema field for it, so it
          // rides along in the AuditLog row rather than the Position/Order
          // itself, same as every other admin-action reason in this app.
          ...(note ? { note } : {}),
        },
      },
    });

    return { order, position };
  });

  // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- mirror hook gap fix: a manual
  // dealing-desk open ("execute for client") is a real fill on the
  // account, same as any trader-initiated one -- if the account is in a
  // mirrored group, it must mirror too.
  await mirror.onFillPosition(prisma, result.position, brokerSymbol.symbol.name).catch((err) => console.error("mirror.onFill failed", err));

  return NextResponse.json({
    positionId: result.position.id,
    symbol: brokerSymbol.symbol.name,
    side,
    volume: volume.toString(),
    openPrice: fillPrice.toString(),
  });
}
