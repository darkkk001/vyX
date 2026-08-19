import { Prisma, BookType, OrderSide } from "@prisma/client";

type Tx = Prisma.TransactionClient;

// Shared "risk checks already passed, now actually fill this order"
// step -- used by every dealing-queue fill path: manual dealer Accept
// (app/api/manage/dealing-queue/[id]/route.ts), Smart Dealer's
// auto-accept (app/api/trade/orders/route.ts), and a client accepting a
// requote (app/api/trade/orders/[id]/requote-response/route.ts). Each
// call site still writes its own AuditLog entry (different action names
// and actors), matching this codebase's existing convention of
// route-local audit calls.
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
  bookType: BookType
) {
  await tx.order.update({
    where: { id: order.id },
    data: { status: "FILLED", filledPrice: fillPrice, filledAt: new Date() },
  });
  return tx.position.create({
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
}
