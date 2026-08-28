import { Prisma, BookType, OrderSide } from "@prisma/client";
import { chargeCommission } from "@/lib/group-pricing";

type Tx = Prisma.TransactionClient;

// Shared "risk checks already passed, now actually fill this order"
// step -- used by every dealing-queue fill path: manual dealer Accept
// (app/api/manage/dealing-queue/[id]/route.ts), Smart Dealer's
// auto-accept (app/api/trade/orders/route.ts), and a client accepting a
// requote (app/api/trade/orders/[id]/requote-response/route.ts). Each
// call site still writes its own AuditLog entry (different action names
// and actors), matching this codebase's existing convention of
// route-local audit calls. `fillPrice` must already have any spread
// markup applied by the caller (see lib/group-pricing.ts's
// applySpreadMarkup) -- this function charges commission but does not
// touch price. commissionPerLot defaults to 0 (no charge) for callers
// that haven't resolved group pricing.
export async function openPositionFromOrder(
  tx: Tx,
  order: {
    id: string;
    brokerId: string;
    accountId: string;
    symbolId: string;
    side: OrderSide;
    volume: Prisma.Decimal;
    slPrice: Prisma.Decimal | null;
    tpPrice: Prisma.Decimal | null;
  },
  fillPrice: Prisma.Decimal,
  bookType: BookType,
  commissionPerLot: Prisma.Decimal = new Prisma.Decimal(0)
) {
  await tx.order.update({
    where: { id: order.id },
    data: { status: "FILLED", filledPrice: fillPrice, filledAt: new Date() },
  });
  const position = await tx.position.create({
    data: {
      brokerId: order.brokerId,
      accountId: order.accountId,
      symbolId: order.symbolId,
      originOrderId: order.id,
      side: order.side,
      volume: order.volume,
      openPrice: fillPrice,
      slPrice: order.slPrice,
      tpPrice: order.tpPrice,
      bookType,
    },
  });
  await chargeCommission(tx, {
    brokerId: order.brokerId,
    accountId: order.accountId,
    positionId: position.id,
    commissionPerLot,
    volume: order.volume,
  });
  return position;
}
