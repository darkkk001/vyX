import { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { publishTradingEvent } from "@/lib/nats";
import { orderAuditFields } from "@/lib/order-audit";

// Dealer queue expiry (owner decision 2026-10-29, C:\vyx\handoff\web-dealer-queue-expiry-brief.md). No offer may sit
// for hours: order #100014118 sat REQUOTED for ~26 h (33 points over a 30-point slippage cap) until staff rejected it.
//
//   REQUOTED (the server's slippage cap or a dealer offered the client a new price): expires requoteExpirySeconds
//     (Broker, default 60) after the requote, measured from executedAt (both requote paths set it).
//   PENDING MARKET (a client order waiting for the dealer, an open or a queued CLOSE): expires offerExpirySeconds
//     (Broker, default 300) after it joined the queue: Order.queuedAt, written once by every path that queues an order
//     (app/api/trade/orders placement, lib/queued-close.ts, a triggered LIMIT / STOP in lib/pending-trigger.ts). Never
//     updatedAt: a client SL / TP edit moves it and would restart the clock on every edit. Never createdAt alone: a
//     triggered LIMIT / STOP keeps its original, possibly days-old, createdAt. A row without queuedAt (none after the
//     migration's backfill) falls back to createdAt, the earlier and therefore safe end.
//   Resting LIMIT / STOP orders never expire here.
//
// An expired order becomes CANCELLED with rejectionReason OFFER_EXPIRED (no new status: every client already knows
// CANCELLED), a queued CLOSE releases its position's lock, one DEALING_ORDER_EXPIRED audit row is written and an
// OrderCancelled event tells the terminal and the backoffice at once. Neither side can accept it afterwards: the accept
// paths check expiry on read and answer 409 OFFER_EXPIRED.
//
// Every transition is a compare-and-set on the status that was read: a client accept, a dealer action or a desk flush
// that got there first wins, and the expiry skips the row.

export const OFFER_EXPIRED = "OFFER_EXPIRED";
export const DEFAULT_REQUOTE_EXPIRY_SECONDS = 60;
export const DEFAULT_OFFER_EXPIRY_SECONDS = 300;
/** Bounds for the per-broker settings (app/api/manage/risk): 10 s to 1 day. */
export const MIN_EXPIRY_SECONDS = 10;
export const MAX_EXPIRY_SECONDS = 86_400;

export type ExpirySettings = { requoteExpirySeconds: number; offerExpirySeconds: number };

type ExpiryOrder = {
  status: string;
  type: string;
  executedAt: Date | null;
  queuedAt?: Date | null;
  createdAt: Date;
};

/** When this order's offer expires, or null when it is not an offer (a resting LIMIT / STOP, a filled order...). */
export function offerExpiresAt(order: ExpiryOrder, broker: ExpirySettings): Date | null {
  if (order.type !== "MARKET") return null;
  if (order.status === "REQUOTED") return new Date((order.executedAt ?? order.queuedAt ?? order.createdAt).getTime() + broker.requoteExpirySeconds * 1000);
  if (order.status === "PENDING") return new Date((order.queuedAt ?? order.createdAt).getTime() + broker.offerExpirySeconds * 1000);
  return null;
}

export function isOfferExpired(order: ExpiryOrder, broker: ExpirySettings, now: Date = new Date()): boolean {
  const at = offerExpiresAt(order, broker);
  return at != null && at.getTime() <= now.getTime();
}

/** The fields expireOffer needs; the routes that already loaded the order pass theirs. */
export type ExpirableOrder = ExpiryOrder & {
  id: string;
  ticket?: number | null;
  brokerId: string;
  accountId: string;
  side: string;
  volume: Prisma.Decimal | string;
  requotedPrice?: Prisma.Decimal | null;
  closesPositionId: string | null;
  symbolName: string;
  accountNumber: string;
};

const EXPIRABLE_SELECT = {
  id: true, ticket: true, brokerId: true, accountId: true, side: true, type: true, volume: true, status: true, requotedPrice: true,
  executedAt: true, queuedAt: true, createdAt: true, closesPositionId: true,
  symbol: { select: { name: true } },
  account: { select: { accountNumber: true } },
  broker: { select: { requoteExpirySeconds: true, offerExpirySeconds: true } },
} satisfies Prisma.OrderSelect;

/** Expire one order (compare-and-set on the status it was read with). True when this call expired it; false when
 *  someone else moved it first. Publishes OrderCancelled after the commit. */
export async function expireOffer(db: PrismaClient, order: ExpirableOrder, now: Date = new Date()): Promise<boolean> {
  const priorStatus = order.status as "PENDING" | "REQUOTED";
  const isClose = order.closesPositionId != null;
  const expired = await db.$transaction(async (tx) => {
    const result = await tx.order.updateMany({
      where: { id: order.id, status: priorStatus, type: "MARKET" },
      data: { status: "CANCELLED", rejectionReason: OFFER_EXPIRED, executedAt: now },
    });
    if (result.count === 0) return false;
    // a queued CLOSE releases its position, only while the lock is still this order's (a stop-out or close-by may have
    // closed the position already: then nothing matches and nothing changes)
    if (order.closesPositionId) {
      await tx.position.updateMany({ where: { id: order.closesPositionId, closePendingOrderId: order.id }, data: { closePendingOrderId: null } });
    }
    await tx.auditLog.create({
      data: {
        brokerId: order.brokerId,
        action: "DEALING_ORDER_EXPIRED",
        entityType: "Order",
        entityId: order.id,
        oldValue: {
          ...orderAuditFields(order, order.symbolName, order.accountNumber),
          status: priorStatus,
          requotedPrice: order.requotedPrice?.toString() ?? null,
        },
        newValue: { status: "CANCELLED", reason: OFFER_EXPIRED, kind: isClose ? "CLOSE" : "OPEN", expiredAt: now.toISOString() },
      },
    });
    return true;
  });
  if (expired) {
    await publishTradingEvent("OrderCancelled", { order_id: order.id, account_id: order.accountId, broker_id: order.brokerId, reason: OFFER_EXPIRED });
  }
  return expired;
}

/** Load one order and expire it when its window has passed. True = the order is (now) expired and must not be acted
 *  on; the caller answers 409 OFFER_EXPIRED. */
export async function expireIfStale(db: PrismaClient, orderId: string, now: Date = new Date()): Promise<boolean> {
  const row = await db.order.findUnique({ where: { id: orderId }, select: EXPIRABLE_SELECT });
  if (!row || !isOfferExpired(row, row.broker, now)) return false;
  await expireOffer(db, toExpirable(row), now);
  return true;
}

function toExpirable(row: Prisma.OrderGetPayload<{ select: typeof EXPIRABLE_SELECT }>): ExpirableOrder {
  return { ...row, symbolName: row.symbol.name, accountNumber: row.account.accountNumber };
}

/** The periodic sweep (app/api/internal/margin-monitor): every MARKET order still waiting (PENDING or REQUOTED) whose
 *  window has passed. One indexed query when there is nothing to do. `brokerId` limits it to one broker (the dealing
 *  queue's own read). */
export async function expireStaleOffers(
  db: PrismaClient = defaultPrisma,
  now: Date = new Date(),
  brokerId?: string
): Promise<{ checked: number; expired: number; errors: number }> {
  const rows = await db.order.findMany({
    where: { type: "MARKET", status: { in: ["PENDING", "REQUOTED"] }, ...(brokerId ? { brokerId } : {}) },
    select: EXPIRABLE_SELECT,
  });
  let expired = 0;
  let errors = 0;
  for (const row of rows) {
    if (!isOfferExpired(row, row.broker, now)) continue;
    try {
      if (await expireOffer(db, toExpirable(row), now)) expired++;
    } catch (err) {
      errors++;
      console.error("order-expiry: expire failed", row.id, err);
    }
  }
  return { checked: rows.length, expired, errors };
}
