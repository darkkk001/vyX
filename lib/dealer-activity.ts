import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { publishTradingEvent } from "@/lib/nats";

// Dealer awareness (2026-09-04 feature) -- a dealer responsible for a
// DEALING-group account (Group.groupType === "DEALING") needs to see
// everything that account does, live, without watching a specific page.
// This is the one place that both (a) publishes the backoffice activity-
// feed event (lib/nats.ts's DealerActivity, subject dealing.activity --
// see that file's own comment on why it's kept off order.>/position.>)
// and (b) writes a real Notification row for the subset of actions a
// dealer should be actively alerted to, not just able to see if they
// happen to be looking at the feed.
//
// Always called AFTER a caller's own $transaction has committed, same
// convention as every other publishTradingEvent call in this codebase --
// this does a real network call (the gateway relay) and a Notification
// write, neither of which belongs inside a DB transaction.
export type DealerActivityAction =
  | "ORDER_PLACED"
  | "ORDER_MODIFIED"
  | "ORDER_CANCELLED"
  | "ORDER_TRIGGERED"
  | "POSITION_OPENED"
  | "POSITION_CLOSED";

// Per the feature spec: a dealer gets an actual notification (bell badge)
// for the things they're responsible for reacting to -- placing a pending
// order, changing SL/TP, or a pending order triggering into their queue.
// A position simply opening or closing isn't separately alerted (it's
// already visible in Live Exposure, and OPENED/CLOSED on a dealing-group
// account is usually itself the direct result of one of the three actions
// above, or of the dealer's own queue action) -- still shown in the feed,
// just not double-counted on the bell.
const NOTIFY_ACTIONS = new Set<DealerActivityAction>(["ORDER_PLACED", "ORDER_MODIFIED", "ORDER_TRIGGERED"]);

function titleFor(action: DealerActivityAction): string {
  switch (action) {
    case "ORDER_PLACED":
      return "Dealing-group account placed a pending order";
    case "ORDER_MODIFIED":
      return "Dealing-group account modified SL/TP";
    case "ORDER_TRIGGERED":
      return "Dealing-group pending order triggered";
    default:
      return "Dealing-group account activity";
  }
}

function bodyFor(params: { accountNumber: string; symbol: string; side: "BUY" | "SELL" | null; volume: string | null; values: Record<string, unknown> }): string {
  const parts = [params.accountNumber];
  if (params.side && params.volume) parts.push(`${params.side} ${params.volume}`);
  if (params.symbol) parts.push(params.symbol);
  const v = params.values;
  if (v.triggerPrice) parts.push(`@ ${v.triggerPrice}`);
  else if (v.requestedPrice) parts.push(`@ ${v.requestedPrice}`);
  if (v.slPrice !== undefined || v.tpPrice !== undefined) {
    const slTp: string[] = [];
    if (v.oldSlPrice !== undefined || v.newSlPrice !== undefined) slTp.push(`SL ${v.oldSlPrice ?? "—"}→${v.newSlPrice ?? "—"}`);
    if (v.oldTpPrice !== undefined || v.newTpPrice !== undefined) slTp.push(`TP ${v.oldTpPrice ?? "—"}→${v.newTpPrice ?? "—"}`);
    if (slTp.length) parts.push(slTp.join(", "));
  }
  return parts.join(" ");
}

export async function recordDealerActivity(
  db: PrismaClient | Prisma.TransactionClient,
  params: {
    brokerId: string;
    accountId: string;
    accountNumber: string;
    accountFullName: string;
    isDealingGroup: boolean;
    action: DealerActivityAction;
    symbol: string;
    side: "BUY" | "SELL" | null;
    volume: string | null;
    values: Record<string, unknown>;
    orderId?: string;
    positionId?: string;
    // For a MARKET order landing in the dealing queue -- its own
    // DEALING_ORDER_PENDING notification already fires at that call site
    // (app/api/trade/orders/route.ts); this event is only recorded here so
    // it also shows up in the general activity feed, without double-
    // notifying the bell for the same order.
    skipNotification?: boolean;
  }
): Promise<void> {
  await publishTradingEvent("DealerActivity", {
    broker_id: params.brokerId,
    account_id: params.accountId,
    account_number: params.accountNumber,
    account_full_name: params.accountFullName,
    is_dealing_group: params.isDealingGroup,
    action: params.action,
    symbol: params.symbol,
    side: params.side,
    volume: params.volume,
    values: params.values,
    order_id: params.orderId ?? null,
    position_id: params.positionId ?? null,
    at: new Date().toISOString(),
  });

  if (!params.skipNotification && params.isDealingGroup && NOTIFY_ACTIONS.has(params.action)) {
    await createNotification(db, {
      brokerId: params.brokerId,
      type: "DEALER_ACTIVITY",
      title: titleFor(params.action),
      body: bodyFor(params),
      entityType: params.positionId ? "Position" : "Order",
      entityId: params.positionId ?? params.orderId,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Shared cold-load queries -- used by both GET /api/manage/dealer-activity
// (every account, amber-highlighted -- Live Exposure / Dealing "Activity"
// tab's original general feed) and GET /api/manage/dealing-desk (DEALING-
// group accounts only, plus the resting-orders list -- the Dealing page's
// own dedicated panel, per the 2026-09-04 refinement: "nothing about a
// dealing-group account happens without appearing here"). One query
// function, one row shape, so the two consumers can never drift.
// ─────────────────────────────────────────────────────────────────────────

// Same known, disclosed gap as before this refinement: two lifecycle
// points don't yet write an AuditLog row at all -- an open position's own
// SL/TP edit (app/api/trade/positions/[id]/route.ts PATCH) and a trader-
// initiated close's non-STM_BULK_CLOSE case
// (app/api/trade/positions/[id]/close). Both already publish the live
// DealerActivity event, so a dealer with the panel open sees them in real
// time -- they just won't backfill into this cold-load history.
const AUDIT_ACTION_MAP: Record<string, DealerActivityAction> = {
  ORDER_PLACED: "ORDER_PLACED",
  ORDER_MODIFIED: "ORDER_MODIFIED",
  TRADER_CANCELLED_DEALING_ORDER: "ORDER_CANCELLED",
  TRADER_CANCELLED_PENDING_ORDER: "ORDER_CANCELLED",
  PENDING_ORDER_QUEUED_FOR_DEALING: "ORDER_TRIGGERED",
  ORDER_FILLED: "POSITION_OPENED",
  ORDER_TRIGGERED_AND_FILLED: "POSITION_OPENED",
  DEALING_ORDER_AUTO_ACCEPTED: "POSITION_OPENED",
  DEALING_ORDER_ACCEPTED: "POSITION_OPENED",
  MANUAL_POSITION_CLOSE: "POSITION_CLOSED",
};

export type DealerActivityFeedRow = {
  id: string;
  at: string;
  accountId: string;
  accountNumber: string;
  accountFullName: string;
  isDealingGroup: boolean;
  action: DealerActivityAction;
  symbol: string | undefined;
  side: string | undefined;
  volume: string | undefined;
  values: Record<string, unknown>;
};

function asObj(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export async function getDealerActivityFeedRows(
  brokerId: string,
  opts: { dealingOnly?: boolean; limit?: number } = {}
): Promise<DealerActivityFeedRow[]> {
  const limit = opts.limit ?? 50;
  // Broker-scoped, not yet DEALING-filtered -- filtering by group requires
  // resolving accountNumber -> account first (AuditLog's JSON is the only
  // place that carries it), done below in one batched query rather than
  // per row. Over-fetches slightly when dealingOnly is true (a row that
  // turns out non-dealing is dropped after the join), acceptable at this
  // volume (`take: limit` rows, not the whole table).
  const rows = await prisma.auditLog.findMany({
    where: { brokerId, action: { in: Object.keys(AUDIT_ACTION_MAP) } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const accountNumbers = [
    ...new Set(
      rows
        .map((r) => (asObj(r.newValue).accountNumber ?? asObj(r.oldValue).accountNumber) as string | undefined)
        .filter((v): v is string => !!v)
    ),
  ];
  const accounts = accountNumbers.length
    ? await prisma.account.findMany({
        where: { brokerId, accountNumber: { in: accountNumbers } },
        select: { id: true, accountNumber: true, fullName: true, group: { select: { groupType: true } } },
      })
    : [];
  const accountByNumber = new Map(accounts.map((a) => [a.accountNumber, a]));

  return rows
    .map((r): DealerActivityFeedRow | null => {
      const before = asObj(r.oldValue);
      const after = asObj(r.newValue);
      const accountNumber = (after.accountNumber ?? before.accountNumber) as string | undefined;
      const account = accountNumber ? accountByNumber.get(accountNumber) : undefined;
      const action = AUDIT_ACTION_MAP[r.action];
      if (!action || !account) return null;
      const isDealingGroup = account.group?.groupType === "DEALING";
      if (opts.dealingOnly && !isDealingGroup) return null;
      return {
        id: r.id,
        at: r.createdAt.toISOString(),
        accountId: account.id,
        accountNumber: account.accountNumber,
        accountFullName: account.fullName,
        isDealingGroup,
        action,
        symbol: (after.symbol ?? before.symbol) as string | undefined,
        side: (after.side ?? before.side) as string | undefined,
        volume: (after.lots ?? before.lots) as string | undefined,
        values: {
          requestedPrice: after.requestedPrice ?? before.requestedPrice,
          triggerPrice: after.triggerPrice,
          filledPrice: after.filledPrice,
          slPrice: after.slPrice,
          tpPrice: after.tpPrice,
          oldSlPrice: before.slPrice,
          newSlPrice: after.slPrice,
          oldTpPrice: before.tpPrice,
          newTpPrice: after.tpPrice,
          closePrice: after.closePrice,
          realizedPnl: after.realizedPnl,
        },
      };
    })
    .filter((r): r is DealerActivityFeedRow => r !== null);
}

export type RestingOrderRow = {
  orderId: string;
  accountId: string;
  accountNumber: string;
  accountFullName: string;
  symbol: string;
  digits: number;
  side: "BUY" | "SELL";
  volume: string;
  orderType: "LIMIT" | "STOP";
  requestedPrice: string | null;
  slPrice: string | null;
  tpPrice: string | null;
  createdAt: string;
};

// Currently-active LIMIT/STOP pending orders for DEALING-group accounts --
// the "resting orders" list the 2026-09-04 refinement asked for: a
// persistent view of what's sitting active on a manually-managed account,
// not just something that scrolled past in the feed. A MARKET order
// queued for dealer review is deliberately excluded here (it's not a
// resting order -- it's already in the approval queue, see
// DealingQueueManager.tsx); once a resting order TRIGGERS it reclassifies
// to MARKET/PENDING too and naturally drops out of this same query.
export async function getDealingDeskRestingOrders(brokerId: string): Promise<RestingOrderRow[]> {
  const orders = await prisma.order.findMany({
    where: {
      brokerId,
      type: { in: ["LIMIT", "STOP"] },
      status: "PENDING",
      account: { group: { groupType: "DEALING" } },
    },
    include: {
      account: { select: { id: true, accountNumber: true, fullName: true } },
      symbol: { select: { name: true, digits: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return orders.map((o) => ({
    orderId: o.id,
    accountId: o.account.id,
    accountNumber: o.account.accountNumber,
    accountFullName: o.account.fullName,
    symbol: o.symbol.name,
    digits: o.symbol.digits,
    side: o.side,
    volume: o.volume.toString(),
    orderType: o.type as "LIMIT" | "STOP",
    requestedPrice: o.requestedPrice ? o.requestedPrice.toString() : null,
    slPrice: o.slPrice ? o.slPrice.toString() : null,
    tpPrice: o.tpPrice ? o.tpPrice.toString() : null,
    createdAt: o.createdAt.toISOString(),
  }));
}

export async function getDealingGroupAccounts(brokerId: string): Promise<{ id: string; accountNumber: string; fullName: string }[]> {
  return prisma.account.findMany({
    where: { brokerId, group: { groupType: "DEALING" } },
    select: { id: true, accountNumber: true, fullName: true },
    orderBy: { accountNumber: "asc" },
  });
}
