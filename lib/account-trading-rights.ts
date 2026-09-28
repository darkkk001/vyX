import "server-only";
import { NextResponse } from "next/server";
import { Prisma, type TradingRights } from "@prisma/client";
import { checkAccountTradingRights, type TradeIntent } from "@/lib/risk";

type Tx = Prisma.TransactionClient;

// Per-account trading rights (2026-09-28, owner decisions): FULL / CLOSE_ONLY / READ_ONLY. The rule itself is
// lib/risk.ts checkAccountTradingRights; this file holds the trader-route refusal and the change itself.

/** A trader route's refusal: 403 with the sentence the terminal / WebTrader shows, or null when allowed. */
export function tradingRightsRefusal(
  account: { status: "ACTIVE" | "SUSPENDED" | "CLOSED"; tradingRights: TradingRights },
  intent: TradeIntent
): NextResponse | null {
  const refused = checkAccountTradingRights(account, intent);
  if (!refused) return null;
  return NextResponse.json({ error: refused, code: "TRADING_RIGHTS", tradingRights: account.tradingRights }, { status: 403 });
}

/** The reason stored on each pending order cancelled by a rights change, and shown to the trader. */
export function pendingCancelReason(rights: TradingRights): string {
  return rights === "READ_ONLY"
    ? "Cancelled: your account was set to read-only (trading disabled)"
    : "Cancelled: your account was set to close-only (no new positions)";
}

export type TradingRightsChange = {
  changed: boolean;
  from: TradingRights;
  to: TradingRights;
  /** the pending orders this change cancelled (owner decision 2026-09-28: at once, not at their trigger) */
  cancelledOrderIds: string[];
};

/**
 * Sets an account's trading rights inside the caller's transaction. When the rights drop below FULL, every order of
 * the account that could still OPEN a position is cancelled at once, with the reason stored on the order and audited:
 * resting LIMIT / STOP orders and MARKET orders waiting for the dealer. A queued CLOSE (closesPositionId set) is left
 * for the dealer (owner decision 6: it was requested while allowed). Each cancel is status-guarded, so an order a
 * trigger or the dealer fills at the same moment is either filled or cancelled, never both.
 */
export async function setAccountTradingRights(
  tx: Tx,
  params: { brokerId: string; accountId: string; to: TradingRights; adminId: string; note?: string }
): Promise<TradingRightsChange> {
  // row lock: two admins changing the rights at once apply in turn, each against the other's result
  const rows = await tx.$queryRaw<{ tradingRights: TradingRights; brokerId: string }[]>`SELECT "tradingRights", "brokerId" FROM "Account" WHERE id = ${params.accountId} FOR UPDATE`;
  if (rows.length === 0 || rows[0].brokerId !== params.brokerId) throw new Error("account not found");
  const from = rows[0].tradingRights;
  if (from === params.to) return { changed: false, from, to: params.to, cancelledOrderIds: [] };

  await tx.account.update({ where: { id: params.accountId }, data: { tradingRights: params.to } });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "ACCOUNT_TRADING_RIGHTS_CHANGED",
      entityType: "Account",
      entityId: params.accountId,
      oldValue: { tradingRights: from },
      newValue: { tradingRights: params.to, ...(params.note ? { note: params.note } : {}) },
    },
  });

  const cancelledOrderIds: string[] = [];
  if (params.to !== "FULL") {
    const reason = pendingCancelReason(params.to);
    const open = await tx.order.findMany({
      where: { accountId: params.accountId, status: "PENDING", closesPositionId: null },
      select: { id: true, type: true, side: true, volume: true, requestedPrice: true, symbol: { select: { name: true } } },
    });
    for (const o of open) {
      const res = await tx.order.updateMany({ where: { id: o.id, status: "PENDING" }, data: { status: "CANCELLED", rejectionReason: reason } });
      if (res.count === 0) continue; // filled or cancelled meanwhile
      cancelledOrderIds.push(o.id);
      await tx.auditLog.create({
        data: {
          brokerId: params.brokerId,
          actorAdminId: params.adminId,
          action: "PENDING_ORDER_CANCELLED_BY_TRADING_RIGHTS",
          entityType: "Order",
          entityId: o.id,
          oldValue: { status: "PENDING", type: o.type, side: o.side, volume: o.volume.toString(), requestedPrice: o.requestedPrice?.toString() ?? null, symbol: o.symbol.name },
          newValue: { status: "CANCELLED", cancelledBy: "TRADING_RIGHTS", tradingRights: params.to, reason, cancelledAt: new Date().toISOString() },
        },
      });
    }
  }
  return { changed: true, from, to: params.to, cancelledOrderIds };
}

/** The trader's notice for a rights change (the title of the account notification). */
export function tradingRightsNotice(change: TradingRightsChange): string {
  const what = change.to === "FULL" ? "Trading is enabled again on your account"
    : change.to === "CLOSE_ONLY" ? "Your account is now close-only: you can close positions but not open new ones"
    : "Your account is now read-only: trading is disabled";
  const n = change.cancelledOrderIds.length;
  return n > 0 ? `${what}. ${n} pending order${n === 1 ? " was" : "s were"} cancelled.` : what;
}
