import { NextRequest, NextResponse } from "next/server";
import { accountClosePrice, loadAccountAskRules } from "@/lib/ask-markup";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publishTradingEvent } from "@/lib/nats";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import { validateSlTp } from "@/lib/trading";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { isDealingManagedAccount, deskIsOn } from "@/lib/dealing-routing";
import { runAfterResponse } from "@/lib/after-response";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Modify an OPEN position's SL/TP -- Position.slPrice/tpPrice already
// existed in the schema but nothing wrote them until now (see
// docs/trading-engine.md's implementation-status note, which flagged this
// gap). Targets the position directly (unlike app/api/trade/orders, which
// only modifies a still-PENDING order) -- matches what the live Next.js
// trading path already does for a trader's own modify action.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // owner decision 2026-09-25 (audit Batch 4): CLIENT_TRADING -- BROKER_ADMIN, or a MANAGER granted it. No second admin
  // (dealing needs speed); every action writes its audit row.
  if (await forbidUnlessBrokerAdminOrPermission(session, "CLIENT_TRADING")) {
    return NextResponse.json({ error: "forbidden", permission: "CLIENT_TRADING", permissionLabel: PERMISSION_LABELS.CLIENT_TRADING }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const position = await prisma.position.findUnique({
    where: { id },
    include: { symbol: { select: { name: true } }, account: { select: { accountNumber: true } } },
  });
  if (!position || position.brokerId !== brokerId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "position is not open" }, { status: 409 });
  }

  const body = await request.json().catch(() => null);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return NextResponse.json({ error: "reason is required" }, { status: 400 });
  }

  let slPrice: Prisma.Decimal | null = position.slPrice;
  let tpPrice: Prisma.Decimal | null = position.tpPrice;
  if (body?.slPrice !== undefined) {
    try {
      slPrice = body.slPrice === null || body.slPrice === "" ? null : new Prisma.Decimal(String(body.slPrice));
    } catch {
      return NextResponse.json({ error: "invalid slPrice" }, { status: 400 });
    }
  }
  if (body?.tpPrice !== undefined) {
    try {
      tpPrice = body.tpPrice === null || body.tpPrice === "" ? null : new Prisma.Decimal(String(body.tpPrice));
    } catch {
      return NextResponse.json({ error: "invalid tpPrice" }, { status: 400 });
    }
  }

  // Validated against the current market price -- what closing (or
  // triggering) the position right now would actually reference -- same
  // bid/BUY, ask/SELL convention as the close route's own closePrice.
  const price = await getFreshPrice(position.symbol.name);
  if (!price) {
    return NextResponse.json({ error: `no live price for ${position.symbol.name}` }, { status: 409 });
  }
  // a SELL is checked against its account's ask -- the price it closes / triggers at (lib/ask-markup.ts)
  const referencePrice = position.side === "BUY" ? price.bid : accountClosePrice("SELL", price.bid, price.ask, (await loadAccountAskRules(prisma, position.accountId, [position.symbolId]))(position.symbolId));
  const brokerSymbol = await prisma.brokerSymbol.findUnique({
    where: { brokerId_symbolId: { brokerId: position.brokerId, symbolId: position.symbolId } },
    include: { symbol: { select: { digits: true } } },
  });
  const validationError = validateSlTp({
    side: position.side,
    referencePrice,
    slPrice,
    tpPrice,
    digits: brokerSymbol?.symbol.digits,
    stopLevel: brokerSymbol?.stopLevel,
  });
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.position.update({
      where: { id: position.id },
      data: { slPrice, tpPrice },
    });

    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "POSITION_SLTP_MODIFIED",
        entityType: "Position",
        entityId: position.id,
        oldValue: {
          slPrice: position.slPrice?.toString() ?? null,
          tpPrice: position.tpPrice?.toString() ?? null,
        },
        newValue: {
          accountNumber: position.account.accountNumber,
          symbol: position.symbol.name,
          slPrice: slPrice?.toString() ?? null,
          tpPrice: tpPrice?.toString() ?? null,
          reason,
        },
      },
    });

    return result;
  });

  // Batch 5 (audit: admin SL/TP edits published nothing): the trader's terminal and every backoffice see it at once
  await publishTradingEvent("PositionModified", { position_id: updated.id, account_id: updated.accountId, broker_id: brokerId }).catch(() => {});
  // Phase 2 batch 3 (audit EXP line): the change also reaches the dealer activity feed, after the response
  await runAfterResponse("admin sl/tp dealer activity", async () => {
    const [account, broker] = await Promise.all([
      prisma.account.findUnique({ where: { id: updated.accountId }, select: { accountNumber: true, fullName: true, group: { select: { category: true, forceDealingMode: true } } } }),
      prisma.broker.findUnique({ where: { id: brokerId }, select: { dealingDeskAutoFillAt: true } }),
    ]);
    if (!account) return;
    await recordDealerActivity(prisma, {
      brokerId,
      accountId: updated.accountId,
      accountNumber: account.accountNumber,
      accountFullName: account.fullName,
      isDealingGroup: isDealingManagedAccount({ group: account.group, deskOn: deskIsOn(broker) }),
      action: "ORDER_MODIFIED",
      symbol: position.symbol.name,
      side: position.side,
      volume: position.volume.toString(),
      values: {
        oldSlPrice: position.slPrice?.toString() ?? null,
        newSlPrice: slPrice?.toString() ?? null,
        oldTpPrice: position.tpPrice?.toString() ?? null,
        newTpPrice: tpPrice?.toString() ?? null,
        onOpenPosition: true,
        origin: "admin",
        reason,
      },
      positionId: updated.id,
      skipNotification: true, // staff made this change; no staff notification about it
    });
  });

  return NextResponse.json({
    positionId: updated.id,
    slPrice: updated.slPrice?.toString() ?? null,
    tpPrice: updated.tpPrice?.toString() ?? null,
  });
}
