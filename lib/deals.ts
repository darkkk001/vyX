import "server-only";
import { Prisma, type DealReason, type OrderSource } from "@prisma/client";

type Tx = Prisma.TransactionClient;

// Deal model step 1 (docs/POSITION-DEAL-MODEL.md section 3.3 step 2): the web writes one Deal per execution, in the
// same transaction as the ledger row it explains. Write-only for now: nothing reads the table until the read switch
// (step 4), so a wrong value here changes no balance and no screen. The close side lives in closePositionInTx
// (lib/position-close.ts), which every web close goes through; this file is the open side.

/// The channel a client request came from (the `x-client-platform` header the terminal / mobile / API clients send),
/// the same rule the open and queued-close paths use. Anything else is the WebTrader.
export function clientDealSource(header: string | null | undefined): OrderSource {
  return header === "DESKTOP_NATIVE" || header === "MOBILE" || header === "API" ? header : "WEB";
}

/// IN deal for a position that was just created in this transaction: volume and price of the fill, the commission
/// already charged for it (call this AFTER chargeCommission), the opening Order and its channel. Also sets
/// Position.initialVolume. `source` overrides the opening Order's own source (staff opens have none of their own).
export async function writeOpenDealInTx(
  tx: Tx,
  params: { positionId: string; reason: DealReason; adminId?: string | null; source?: OrderSource | null }
) {
  const position = await tx.position.findUniqueOrThrow({
    where: { id: params.positionId },
    select: {
      id: true,
      brokerId: true,
      accountId: true,
      symbolId: true,
      side: true,
      volume: true,
      openPrice: true,
      openedAt: true,
      originOrderId: true,
      originOrder: { select: { source: true } },
    },
  });
  const commissions = await tx.transaction.findMany({
    where: { referenceType: "Position", referenceId: position.id, type: "COMMISSION" },
    select: { id: true, amount: true },
  });
  const commission = commissions.reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
  const deal = await tx.deal.create({
    data: {
      brokerId: position.brokerId,
      accountId: position.accountId,
      positionId: position.id,
      orderId: position.originOrderId,
      symbolId: position.symbolId,
      side: position.side,
      entry: "IN",
      reason: params.reason,
      source: params.source !== undefined ? params.source : position.originOrder.source,
      volume: position.volume,
      price: position.openPrice,
      commission,
      transactionId: commissions.length === 1 ? commissions[0].id : null,
      adminId: params.adminId ?? null,
      executedAt: position.openedAt,
    },
  });
  await tx.position.update({ where: { id: position.id }, data: { initialVolume: position.volume } });
  return deal;
}

/// What a close tells closePositionInTx about itself, for its OUT / OUT_BY deal. The entry is derived there:
/// OUT_BY when the close names the opposite leg (closeByPositionId), OUT otherwise.
export type CloseDealInput = {
  reason: DealReason;
  source?: OrderSource | null;
  orderId?: string | null; // the queued close Order, when the close went through the dealer queue
  adminId?: string | null;
};

/// Staff reverse in place (side flipped on the same row): an OUT for the old side and an IN for the new side, both on
/// the same position, so the deal history shows the flip. The flip keeps the entry price and realises nothing (no
/// ledger row), so both deals are at the open price with profit 0 and no transactionId; INOUT stays reserved for
/// netting. Call it AFTER the side update. Both deals trade the new side: closing a BUY is a SELL, opening a SELL is one.
export async function writeFlipDealsInTx(tx: Tx, params: { positionId: string; adminId: string }) {
  const position = await tx.position.findUniqueOrThrow({
    where: { id: params.positionId },
    select: { id: true, brokerId: true, accountId: true, symbolId: true, side: true, volume: true, openPrice: true },
  });
  const executedAt = new Date();
  const common = {
    brokerId: position.brokerId,
    accountId: position.accountId,
    positionId: position.id,
    symbolId: position.symbolId,
    side: position.side,
    reason: "REVERSE" as const,
    source: "ADMIN" as const,
    volume: position.volume,
    price: position.openPrice,
    adminId: params.adminId,
    executedAt,
  };
  // sequential, so the OUT gets the lower ticket and reads first at the same executedAt
  await tx.deal.create({ data: { ...common, entry: "OUT" } });
  await tx.deal.create({ data: { ...common, entry: "IN" } });
}

/// Void: the position's deals stay, marked voided (the ledger reversal is the ADJUSTMENT row the void writes).
export async function markDealsVoidedInTx(tx: Tx, positionId: string, at: Date = new Date()) {
  return tx.deal.updateMany({ where: { positionId, voidedAt: null }, data: { voidedAt: at } });
}
