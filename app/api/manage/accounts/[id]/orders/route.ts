import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { getFreshPrice } from "@/lib/live-price";
import { validatePendingOrderDirection, validatePendingPriceDistance, validateSlTp } from "@/lib/trading";
import { publishTradingEvent } from "@/lib/nats";
import { orderAuditFields } from "@/lib/order-audit";
import { parseStaffOrder, staffActivityText, staffMarginRefusal, staffOrderContext } from "@/lib/staff-order";

// Staff pending orders (staff order brief change 1, owner 2026-10-28): POST a LIMIT / STOP order for a client account, with the same validation as the
// client's own pending order (entry side vs the market, the symbol's stop level, lots, SL / TP, the placement margin gate) and every broker / symbol /
// account policy (lib/staff-order.ts). Source ADMIN, an ORDER_PLACED audit row with the staff activity line, CLIENT_TRADING (BROKER_ADMIN, or a
// MANAGER granted it). The order then rests and fills exactly like the client's (lib/pending-trigger.ts); staff cancel is orders/[id]/cancel.
//   body { symbolId, side BUY | SELL, type LIMIT | STOP, volume, price, slPrice?, tpPrice?, note? }
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (await forbidUnlessBrokerAdminOrPermission(session, "CLIENT_TRADING")) {
    return NextResponse.json({ error: "forbidden", permission: "CLIENT_TRADING", permissionLabel: PERMISSION_LABELS.CLIENT_TRADING }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id: accountId } = await params;
  const body = await request.json().catch(() => null);
  const type = body?.type === "LIMIT" || body?.type === "STOP" ? (body.type as "LIMIT" | "STOP") : null;
  if (!type) return NextResponse.json({ error: "type must be LIMIT or STOP" }, { status: 400 });
  let price: Prisma.Decimal;
  try { price = new Prisma.Decimal(String(body?.price ?? "").replace(/,/g, "")); } catch { return NextResponse.json({ error: "invalid price" }, { status: 400 }); }
  if (!price.gt(0)) return NextResponse.json({ error: "price must be positive" }, { status: 400 });
  const input = parseStaffOrder(body);
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });
  const { side, volume, slPrice, tpPrice, note } = input;
  const ctx = await staffOrderContext(brokerId, accountId, input, { market: false });
  if (ctx.response) return ctx.response;
  const { account, brokerSymbol } = ctx;
  const digits = brokerSymbol.symbol.digits;

  // the entry against the market (skipped when the symbol has no live price yet, as for the client)
  const live = await getFreshPrice(brokerSymbol.symbol.name);
  if (live) {
    const marketRef = side === "BUY" ? live.ask : live.bid;
    const directionError = validatePendingOrderDirection({ type, side, entryPrice: price, marketPrice: marketRef });
    if (directionError) return NextResponse.json({ error: directionError }, { status: 400 });
    const distanceError = validatePendingPriceDistance({ type, side, entryPrice: price, marketPrice: marketRef, digits, stopLevel: brokerSymbol.stopLevel });
    if (distanceError) return NextResponse.json({ error: distanceError }, { status: 400 });
  }
  const slTpError = validateSlTp({ side, referencePrice: price, slPrice, tpPrice, digits, stopLevel: brokerSymbol.stopLevel });
  if (slTpError) return NextResponse.json({ error: slTpError }, { status: 400 });
  // the same placement margin gate as the client's resting order (priced at the entry); the fill checks again
  const marginRefusal = await staffMarginRefusal(brokerId, account, brokerSymbol, side, volume, price);
  if (marginRefusal) return NextResponse.json(marginRefusal, { status: 400 });

  const activity = staffActivityText("pending", { side, type, volume: volume.toString(), symbol: brokerSymbol.symbol.name, price: price.toString(), digits, account: account.accountNumber });
  const order = await prisma.$transaction(async (tx) => {
    const o = await tx.order.create({
      data: {
        brokerId, accountId, symbolId: brokerSymbol.symbolId, side, type, volume, requestedPrice: price, slPrice, tpPrice,
        idempotencyKey: `staff_${randomUUID()}`, status: "PENDING", source: "ADMIN", platform: "Backoffice",
      },
    });
    await tx.auditLog.create({
      data: {
        brokerId, actorAdminId: session!.adminId, action: "ORDER_PLACED", entityType: "Order", entityId: o.id, oldValue: {},
        newValue: { ...orderAuditFields(o, brokerSymbol.symbol.name, account.accountNumber), requestedPrice: price.toString(), slPrice: slPrice?.toString() ?? null, tpPrice: tpPrice?.toString() ?? null, status: "PENDING", activity, ...(note ? { note } : {}) },
      },
    });
    return o;
  });
  await publishTradingEvent("OrderAccepted", { order_id: order.id, account_id: accountId, broker_id: brokerId });
  return NextResponse.json({ orderId: order.id, type, side, volume: volume.toString(), price: price.toString(), status: "PENDING" }, { status: 201 });
}
