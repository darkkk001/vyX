import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { publishTradingEvent } from "@/lib/nats";
import { isDealingManagedAccount } from "@/lib/dealing-routing";

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
  | "POSITION_CLOSED"
  // a client's manual close routed to the dealer queue (docs/CLOSES-RESPECT-DEALER-MODE.md)
  | "CLOSE_REQUESTED";

// Per the feature spec: a dealer gets an actual notification (bell badge)
// for the things they're responsible for reacting to -- placing a pending
// order, changing SL/TP, or a pending order triggering into their queue.
// A position simply opening or closing isn't separately alerted (it's
// already visible in Live Exposure, and OPENED/CLOSED on a dealing-group
// account is usually itself the direct result of one of the three actions
// above, or of the dealer's own queue action) -- still shown in the feed,
// just not double-counted on the bell.
const NOTIFY_ACTIONS = new Set<DealerActivityAction>(["ORDER_PLACED", "ORDER_MODIFIED", "ORDER_TRIGGERED", "CLOSE_REQUESTED"]);

function titleFor(action: DealerActivityAction): string {
  switch (action) {
    case "ORDER_PLACED":
      return "Dealing-group account placed a pending order";
    case "ORDER_MODIFIED":
      return "Dealing-group account modified SL/TP";
    case "ORDER_TRIGGERED":
      return "Dealing-group pending order triggered";
    case "CLOSE_REQUESTED":
      return "Dealing-group close awaiting dealer review";
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
    if (v.oldSlPrice !== undefined || v.newSlPrice !== undefined) slTp.push(`SL ${v.oldSlPrice ?? "-"}→${v.newSlPrice ?? "-"}`);
    if (v.oldTpPrice !== undefined || v.newTpPrice !== undefined) slTp.push(`TP ${v.oldTpPrice ?? "-"}→${v.newTpPrice ?? "-"}`);
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

// Closes respect DEALER mode (docs/CLOSES-RESPECT-DEALER-MODE.md, #5): EVERY close on a
// dealing-group account -- the client's own, bulk, close-by, the dealer's accept, the risk
// monitor's SL / TP / stop-out (which bypass the queue), the mirror -- must reach the dealer
// activity feed LIVE. The history side is covered by getDealerActivityFeedRows reading the
// Position table (any close path writes it); this is the real-time half, called by each close
// site after its transaction committed. Loads what the feed row needs from the position itself
// so a caller that only holds an id (the risk monitor, the mirror) can still emit it.
export type CloseReason = "MANUAL" | "STOP_LOSS" | "TAKE_PROFIT" | "STOP_OUT" | "MIRROR" | "ADMIN";

export async function emitPositionClosedActivity(
  db: PrismaClient | Prisma.TransactionClient,
  p: { positionId: string; closePrice: Prisma.Decimal | string; closeVolume: Prisma.Decimal; partial: boolean; realizedPnl: Prisma.Decimal; closeReason: CloseReason; origin: string }
): Promise<void> {
  try {
    const position = await db.position.findUnique({
      where: { id: p.positionId },
      select: {
        brokerId: true, accountId: true, side: true,
        symbol: { select: { name: true } },
        account: { select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } } },
        broker: { select: { dealingModeAt: true, dealingDeskAutoFillAt: true } },
      },
    });
    if (!position) return;
    await recordDealerActivity(db, {
      brokerId: position.brokerId,
      accountId: position.accountId,
      accountNumber: position.account.accountNumber,
      accountFullName: position.account.fullName,
      isDealingGroup: isDealingManagedAccount({ group: position.account.group, brokerDealingModeOn: !!position.broker.dealingModeAt, dealingDeskAutoFillOn: !!position.broker.dealingDeskAutoFillAt }),
      action: "POSITION_CLOSED",
      symbol: position.symbol.name,
      side: position.side,
      volume: p.closeVolume.toString(),
      values: { closePrice: p.closePrice.toString(), partial: p.partial, realizedPnl: p.realizedPnl.toString(), closeReason: p.closeReason, origin: p.origin },
      positionId: p.positionId,
    });
  } catch (err) {
    console.error("emitPositionClosedActivity failed", p.positionId, err);   // the feed must never fail a close
  }
}

/// The close reason of a closed position, read back from its TRADE_PNL ledger note (the one
/// place every close path already records what it was) -- for the feed's history rows.
export function closeReasonFromNote(note: string | null | undefined): CloseReason {
  const n = (note ?? "").toLowerCase();
  if (n.startsWith("stop loss")) return "STOP_LOSS";
  if (n.startsWith("take profit")) return "TAKE_PROFIT";
  if (n.startsWith("stop-out")) return "STOP_OUT";
  if (n.startsWith("mirror close")) return "MIRROR";
  if (n.startsWith("admin close") || n.startsWith("manual close")) return "ADMIN";
  return "MANUAL";
}

// ─────────────────────────────────────────────────────────────────────────
// Shared cold-load query -- backs GET /api/manage/dealing-desk (DEALING-
// group accounts only, plus the resting-orders list -- the Dealing page's
// own dedicated panel, per the 2026-09-04 refinement: "nothing about a
// dealing-group account happens without appearing here"). Kept general
// (the `dealingOnly` option) rather than hardcoded to that one caller --
// an earlier general, every-account feed on Live Exposure used the same
// function with dealingOnly:false before being removed as redundant
// clutter (2026-09-04 follow-up: the dealer's own view belongs on the
// Dealing page, not scattered elsewhere); nothing stops a future
// general-purpose consumer from reusing it the same way.
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
  // a client close routed to the dealer queue (lib/queued-close.ts)
  DEALING_CLOSE_QUEUED: "CLOSE_REQUESTED",
  // POSITION_CLOSED is deliberately NOT sourced from AuditLog any more.
  // Only the manager's manual close ever wrote an audit row that mapped
  // here (MANUAL_POSITION_CLOSE); a trader's own close (STM_BULK_CLOSE,
  // no realizedPnl in its JSON) and every engine close (SL / TP / stop-
  // out) wrote nothing usable, so the cold-load feed showed a closed
  // position's realized P&L only for the rarest close path. Closes now
  // come from the Position table itself (the `closed` query below),
  // which every close path writes.
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
  const [rows, broker, closed] = await Promise.all([
    prisma.auditLog.findMany({
      where: { brokerId, action: { in: Object.keys(AUDIT_ACTION_MAP) } },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.broker.findUnique({ where: { id: brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true } }),
    // Closed positions straight from the Position table -- the one record
    // every close path writes (engine SL / TP / stop-out, the trader's own
    // close, the manager's manual close), each with its realized P&L.
    prisma.position.findMany({
      where: { account: { brokerId }, status: "CLOSED", closedAt: { not: null } },
      orderBy: { closedAt: "desc" },
      take: limit,
      select: {
        id: true,
        closedAt: true,
        side: true,
        volume: true,
        closePrice: true,
        realizedPnl: true,
        symbol: { select: { name: true } },
        account: { select: { id: true, accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } } },
      },
    }),
  ]);
  const brokerDealingModeOn = !!broker?.dealingModeAt;
  const dealingDeskAutoFillOn = !!broker?.dealingDeskAutoFillAt;

  // the close reason lives on the TRADE_PNL ledger row every close path writes
  const pnlRows = closed.length
    ? await prisma.transaction.findMany({
        where: { type: "TRADE_PNL", referenceType: "Position", referenceId: { in: closed.map((p) => p.id) } },
        select: { referenceId: true, note: true },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const noteByPosition = new Map<string, string | null>();
  for (const r of pnlRows) if (r.referenceId && !noteByPosition.has(r.referenceId)) noteByPosition.set(r.referenceId, r.note);
  const closedRows = closed
    .map((p): DealerActivityFeedRow | null => {
      const isDealingGroup = isDealingManagedAccount({ group: p.account.group, brokerDealingModeOn, dealingDeskAutoFillOn });
      if (opts.dealingOnly && !isDealingGroup) return null;
      return {
        id: `pos:${p.id}`,
        at: p.closedAt!.toISOString(),
        accountId: p.account.id,
        accountNumber: p.account.accountNumber,
        accountFullName: p.account.fullName,
        isDealingGroup,
        action: "POSITION_CLOSED",
        symbol: p.symbol.name,
        side: p.side,
        volume: p.volume.toString(),
        values: {
          closePrice: p.closePrice?.toString(),
          realizedPnl: p.realizedPnl?.toString(),
          closeReason: closeReasonFromNote(noteByPosition.get(p.id)),
        },
      };
    })
    .filter((r): r is DealerActivityFeedRow => r !== null);

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
        select: { id: true, accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } },
      })
    : [];
  const accountByNumber = new Map(accounts.map((a) => [a.accountNumber, a]));

  const auditRows = rows
    .map((r): DealerActivityFeedRow | null => {
      const before = asObj(r.oldValue);
      const after = asObj(r.newValue);
      const accountNumber = (after.accountNumber ?? before.accountNumber) as string | undefined;
      const account = accountNumber ? accountByNumber.get(accountNumber) : undefined;
      const action = AUDIT_ACTION_MAP[r.action];
      if (!action || !account) return null;
      // 2026-09-04 bug fix: was `account.group?.groupType === "DEALING"`,
      // which flagged ANY book-routing-DEALING group as dealer-managed --
      // wrong for a group like "B-Book" that's groupType=DEALING but
      // dealingMode=AUTO (a legitimate, common config: book accounting and
      // manual review are independent). isDealingManagedAccount is the
      // same resolution the real order-routing path uses.
      const isDealingGroup = isDealingManagedAccount({ group: account.group, brokerDealingModeOn, dealingDeskAutoFillOn });
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
          closesTicket: after.closesTicket,
          closeVolume: after.closeVolume,
          partial: after.closeVolume != null && after.positionVolume != null ? String(after.closeVolume) !== String(after.positionVolume) : undefined,
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

  // One feed, newest first, capped at `limit` across both sources.
  return [...auditRows, ...closedRows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
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

// Currently-active LIMIT/STOP pending orders for dealer-managed accounts --
// the "resting orders" list the 2026-09-04 refinement asked for: a
// persistent view of what's sitting active on a manually-managed account,
// not just something that scrolled past in the feed. A MARKET order
// queued for dealer review is deliberately excluded here (it's not a
// resting order -- it's already in the approval queue, see
// DealingQueueManager.tsx); once a resting order TRIGGERS it reclassifies
// to MARKET/PENDING too and naturally drops out of this same query.
//
// Filtered in application code, not a Prisma `where` clause -- the
// 2026-09-04 bug fix moved this off a bare `group: { groupType: "DEALING" }`
// filter (wrong: leaks any book-routing-DEALING group regardless of its
// own dealingMode) to the real routing decision
// (isDealingManagedAccount), which isn't expressible as a single relation
// filter. Broker-scoped `type`/`status` filter keeps the candidate set
// small regardless.
export async function getDealingDeskRestingOrders(brokerId: string): Promise<RestingOrderRow[]> {
  const [orders, broker] = await Promise.all([
    prisma.order.findMany({
      where: { brokerId, type: { in: ["LIMIT", "STOP"] }, status: "PENDING" },
      include: {
        account: { select: { id: true, accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } } },
        symbol: { select: { name: true, digits: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.broker.findUnique({ where: { id: brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true } }),
  ]);
  const brokerDealingModeOn = !!broker?.dealingModeAt;
  const dealingDeskAutoFillOn = !!broker?.dealingDeskAutoFillAt;

  return orders
    .filter((o) => isDealingManagedAccount({ group: o.account.group, brokerDealingModeOn, dealingDeskAutoFillOn }))
    .map((o) => ({
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

// Same 2026-09-04 fix as above, but resolved a level higher for
// efficiency: the routing decision only depends on GROUP settings (plus
// the broker-wide toggles), so this narrows to dealing-managed GROUP ids
// first (a broker has a handful of groups, not thousands) rather than
// pulling every account broker-wide just to filter most of them back out.
export async function getDealingGroupAccounts(brokerId: string): Promise<{ id: string; accountNumber: string; fullName: string }[]> {
  const [groups, broker] = await Promise.all([
    prisma.group.findMany({ where: { brokerId }, select: { id: true, groupType: true, dealingMode: true, forceDealingMode: true } }),
    prisma.broker.findUnique({ where: { id: brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true } }),
  ]);
  const brokerDealingModeOn = !!broker?.dealingModeAt;
  const dealingDeskAutoFillOn = !!broker?.dealingDeskAutoFillAt;
  const dealingGroupIds = groups
    .filter((g) => isDealingManagedAccount({ group: g, brokerDealingModeOn, dealingDeskAutoFillOn }))
    .map((g) => g.id);
  if (dealingGroupIds.length === 0) return [];
  return prisma.account.findMany({
    where: { brokerId, groupId: { in: dealingGroupIds } },
    select: { id: true, accountNumber: true, fullName: true },
    orderBy: { accountNumber: "asc" },
  });
}
