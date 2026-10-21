import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tradingDayStart } from "@/lib/trading-day";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { dealExecutionDetail, executionDetail } from "@/lib/order-execution";

// Same query app/manage/(shell)/deals/page.tsx's Server Component used
// to do inline -- exposed as JSON so DealsManager can fetch it itself
// (both the website and a bundled manager-shell desktop app use this
// one path now).
//
// Optional query filters (all broker-scoped, all narrowing): from / to
// (ISO date or datetime; range on closedAt -- `to` is inclusive of the
// whole day when only a date is given), accountId, groupId. Used by the
// backoffice dealing-group HISTORY view's date-range picker.
//
// view=deals (deal model step 4): one row per execution from the Deal table instead of one row per closed position:
// the opening IN, every OUT (partial / final), OUT_BY legs, a reverse's OUT + IN pair. Same filters (from / to on the
// execution time), same cap and headers. Voided trades stay listed (voided: true), as the positions view lists VOIDED
// rows. Without `view` (or view=positions) the answer is the positions list, unchanged.
//
// Batch D (owner 2026-10-21), on both views:
//   ?deleted=1        also list deleted trades (the "show deleted" filter); each row carries `deleted` (true / false) and,
//                     when deleted, deletedAt / deletedBy (staff e-mail) / deleteReason
//   pendingAction     the void / delete / reverse request waiting for approval on the trade, or null:
//                     { type: VOID | DELETE | REVERSE_IN_PLACE | REVERSE_CLOSE_REOPEN, requestId, requestedBy, requestedAt }
//   execution detail  positions view: openExecution (the opening order) and closeExecution (the last close: its filled
//                     close order for a dealer-queued close, otherwise its OUT deal, D-3, so every close has one);
//                     deals view: execution (the deal's order, or an OUT deal's own capture). lib/order-execution.ts
//                     executionDetail / dealExecutionDetail: a field the server does not have is left out.
const DEALS_LIMIT = 500;

const EXEC_SELECT = {
  ticket: true, type: true, source: true, status: true, requestedAt: true, executedAt: true, clientIp: true, platform: true, routing: true,
  executionMode: true, requestedPrice: true, filledPrice: true, rejectionReason: true,
} as const;

/// The waiting request per position (at most one: PositionActionRequest_one_pending_per_position).
async function pendingActions(brokerId: string, positionIds: string[]) {
  if (positionIds.length === 0) return new Map<string, { type: string; requestId: string; requestedBy: string; requestedAt: string }>();
  const rows = await prisma.positionActionRequest.findMany({
    where: { brokerId, status: "PENDING", positionId: { in: positionIds } },
    select: { id: true, positionId: true, actionType: true, createdAt: true, requestedByAdmin: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return new Map(rows.map((r) => [r.positionId, { type: r.actionType, requestId: r.id, requestedBy: r.requestedByAdmin.email, requestedAt: r.createdAt.toISOString() }]));
}

const truthy = (v: string | null) => v === "1" || v === "true";

/// closeExecution: the queued close's Order when the close went through the dealer, else the last OUT deal; none while
/// nothing was closed.
function closeExecutionOf(order: Parameters<typeof executionDetail>[0] | undefined, out: Parameters<typeof dealExecutionDetail>[0] | undefined, digits: number, bookType: string) {
  if (order) return { closeExecution: executionDetail(order, digits) };
  if (out) return { closeExecution: dealExecutionDetail(out, digits, bookType) };
  return {};
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) /* SUPPORT: read-only support role, lib/permissions.ts isSupportReader */ || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const sp = request.nextUrl.searchParams;
  const accountId = sp.get("accountId")?.trim() || null;
  const groupId = sp.get("groupId")?.trim() || null;

  // Range on closedAt. A bare "YYYY-MM-DD" for `to` means "through the end
  // of that day" -- widen to the next midnight so the whole day is included
  // rather than only trades closed at exactly 00:00:00.
  const closedAt: Prisma.DateTimeFilter = {};
  const fromRaw = sp.get("from")?.trim();
  if (fromRaw === "trading-day") {
    // the broker's trading day, the charts' own D1 boundary (lib/trading-day.ts; Batch 4)
    closedAt.gte = (await tradingDayStart()).start;
  } else if (fromRaw) {
    const d = new Date(fromRaw);
    if (!Number.isNaN(d.getTime())) closedAt.gte = d;
  }
  const toRaw = sp.get("to")?.trim();
  if (toRaw) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(toRaw);
    const d = new Date(toRaw);
    if (!Number.isNaN(d.getTime())) {
      if (dateOnly) d.setUTCDate(d.getUTCDate() + 1);
      closedAt.lt = d;
    }
  }

  // VYX-POSITION-TOOLS-V0 -- VOIDED rows belong here too (the brief's
  // "visible to admins" for Void has nowhere else to land: the Live
  // Exposure page only ever shows status: OPEN, so a just-voided position
  // used to vanish from every backoffice view the instant it voided).
  // deletedAt: null hides a soft-deleted row from this normal-browsing
  // list -- "recoverable from the audit view" (the brief's own words)
  // means the audit log, not this list; see POSITION_DELETED's own
  // AuditLog entry for the full record.
  const showDeleted = truthy(sp.get("deleted"));
  if (sp.get("view") === "deals") return dealsView(brokerId, { accountId, groupId, from: closedAt.gte as Date | undefined, before: closedAt.lt as Date | undefined, showDeleted });

  const dealsWhere: Prisma.PositionWhereInput = {
    brokerId,
    status: { in: ["CLOSED", "VOIDED"] },
    ...(showDeleted ? {} : { deletedAt: null }),
    ...(accountId ? { accountId } : {}),
    ...(groupId ? { account: { groupId } } : {}),
    ...(closedAt.gte || closedAt.lt ? { closedAt } : {}),
  };
  const positions = await prisma.position.findMany({
    where: dealsWhere,
    include: {
      account: { select: { accountNumber: true, fullName: true, currency: true } },
      // the hedge leg this trade was booked against: whether the platform opened it (auto-hedge) or
      // the dealer did (BOOK NOW) decides who closes it, so it decides how a still-open leg reads
      // in the Smart Dealer Manager -- AWAITING DEALER vs a real ORPHAN (lib/coverage.ts onClose)
      coveragePosition: { select: { autoHedged: true, status: true } },
      symbol: { select: { name: true, digits: true } },
      originOrder: { select: EXEC_SELECT },
      closeOrders: { where: { status: "FILLED" }, orderBy: { filledAt: "desc" }, take: 1, select: EXEC_SELECT },
      deletedByAdmin: { select: { email: true } },
    },
    orderBy: { closedAt: "desc" },
    take: DEALS_LIMIT + 1,
  });
  // Phase 2 batch 6 (issues 108 / 114): one row past the cap tells whether the list was cut; the body stays the bare
  // array every client parses, the answer goes in headers (x-truncated, x-total-count only when cut)
  const truncated = positions.length > DEALS_LIMIT;
  if (truncated) positions.length = DEALS_LIMIT;
  const headers: Record<string, string> = { "x-row-limit": String(DEALS_LIMIT), "x-truncated": truncated ? "true" : "false" };
  if (truncated) headers["x-total-count"] = String(await prisma.position.count({ where: dealsWhere }));
  const pending = await pendingActions(brokerId, positions.map((p) => p.id));
  // the last close of each position (D-3): the newest OUT / OUT_BY deal
  const lastOut = new Map<string, Awaited<ReturnType<typeof prisma.deal.findMany>>[number]>();
  if (positions.length > 0) {
    const outs = await prisma.deal.findMany({ where: { positionId: { in: positions.map((p) => p.id) }, entry: { in: ["OUT", "OUT_BY"] } }, orderBy: [{ executedAt: "desc" }, { ticket: "desc" }] });
    for (const d of outs) if (!lastOut.has(d.positionId)) lastOut.set(d.positionId, d);
  }

  return NextResponse.json(
    positions.map((p) => ({
      id: p.id,
      ticket: p.ticket,
      accountNumber: p.account.accountNumber,
      currency: p.account.currency, // web5 (owner 2026-09-30): the deal's account currency (P/L, swap, commission are in it)
      accountFullName: p.account.fullName,
      symbol: p.symbol.name,
      digits: p.symbol.digits,
      side: p.side,
      status: p.status,
      volume: (p.closedVolume ?? p.volume).toString(), // lots traded (cumulative closed), not the last remaining piece
      closedVolume: p.closedVolume?.toString() ?? null,
      openPrice: p.openPrice.toFixed(p.symbol.digits),
      closePrice: p.closePrice ? p.closePrice.toFixed(p.symbol.digits) : null,
      commission: p.commission.toFixed(2),
      swap: p.swap.toFixed(2),
      realizedPnl: p.realizedPnl != null ? p.realizedPnl.toFixed(2) : null,
      closedAt: p.closedAt ? p.closedAt.toISOString().replace("T", " ").slice(0, 19) : null,
      // Phase 2 batch 7 (issue 284): the open time, same format, so a closed row's OPENED cell is filled
      openedAt: p.openedAt.toISOString().replace("T", " ").slice(0, 19),
      // dealer coverage (2026-09-22): a booked client trade keeps its hedge-leg id after closing so the
      // Smart Dealer Manager can show the closing side with both P&Ls
      covered: p.covered,
      coveragePositionId: p.coveragePositionId,
      // true when the platform opened the hedge (and so closes it itself); false = the dealer booked
      // it by hand and the dealer closes it
      coverageAutoHedged: p.coveragePosition?.autoHedged ?? false,
      // A_BOOK / B_BOOK: the Smart Dealer Manager's realized DEALER P/L counts only the desk's own
      // B-book closes (2026-09-23); an A-book trade's result is the LP's, not the dealer's
      bookType: p.bookType,
      deleted: p.deletedAt != null,
      ...(p.deletedAt ? { deletedAt: p.deletedAt.toISOString(), deletedBy: p.deletedByAdmin?.email ?? "", deleteReason: p.deleteReason ?? "" } : {}),
      pendingAction: pending.get(p.id) ?? null,
      openExecution: executionDetail(p.originOrder, p.symbol.digits),
      ...closeExecutionOf(p.closeOrders[0], lastOut.get(p.id), p.symbol.digits, p.bookType),
    })),
    { headers }
  );
}

const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

/** view=deals: the broker's deals, newest first, capped like the positions view. */
async function dealsView(brokerId: string, f: { accountId: string | null; groupId: string | null; from?: Date; before?: Date; showDeleted: boolean }) {
  let accountIds: string[] | undefined;
  if (f.groupId) {
    accountIds = (await prisma.account.findMany({ where: { brokerId, groupId: f.groupId, ...(f.accountId ? { id: f.accountId } : {}) }, select: { id: true } })).map((a) => a.id);
    if (accountIds.length === 0) return NextResponse.json([], { headers: { "x-row-limit": String(DEALS_LIMIT), "x-truncated": "false" } });
  }
  const where: Prisma.DealWhereInput = {
    brokerId,
    ...(accountIds ? { accountId: { in: accountIds } } : f.accountId ? { accountId: f.accountId } : {}),
    ...(f.from || f.before ? { executedAt: { ...(f.from ? { gte: f.from } : {}), ...(f.before ? { lt: f.before } : {}) } } : {}),
  };
  const deals = await prisma.deal.findMany({ where, orderBy: [{ executedAt: "desc" }, { ticket: "desc" }], take: DEALS_LIMIT + 1 });
  const truncated = deals.length > DEALS_LIMIT;
  if (truncated) deals.length = DEALS_LIMIT;
  const positionIds = [...new Set(deals.flatMap((d) => (d.byPositionId ? [d.positionId, d.byPositionId] : [d.positionId])))];
  const orderIds = [...new Set(deals.map((d) => d.orderId).filter((id): id is string => !!id))];
  const [positions, accounts, symbols, orders, pending] = await Promise.all([
    prisma.position.findMany({ where: { brokerId, id: { in: positionIds } }, select: { id: true, ticket: true, deletedAt: true, bookType: true } }),
    prisma.account.findMany({ where: { brokerId, id: { in: [...new Set(deals.map((d) => d.accountId))] } }, select: { id: true, accountNumber: true, fullName: true, currency: true } }),
    prisma.symbol.findMany({ where: { id: { in: [...new Set(deals.map((d) => d.symbolId))] } }, select: { id: true, name: true, digits: true } }),
    orderIds.length === 0 ? Promise.resolve([]) : prisma.order.findMany({ where: { brokerId, id: { in: orderIds } }, select: { id: true, ...EXEC_SELECT } }),
    pendingActions(brokerId, [...new Set(deals.map((d) => d.positionId))]),
  ]);
  const pos = new Map(positions.map((p) => [p.id, p]));
  const ord = new Map(orders.map((o) => [o.id, o]));
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const sym = new Map(symbols.map((s) => [s.id, s]));
  const headers: Record<string, string> = { "x-row-limit": String(DEALS_LIMIT), "x-truncated": truncated ? "true" : "false" };
  if (truncated) headers["x-total-count"] = String(await prisma.deal.count({ where }));
  const rows = [];
  for (const d of deals) {
    const p = pos.get(d.positionId);
    const a = acc.get(d.accountId);
    if (!p || (p.deletedAt && !f.showDeleted) || !a) continue; // a deleted trade stays out unless asked for, as in the positions view
    const s = sym.get(d.symbolId);
    const digits = s?.digits ?? 5;
    rows.push({
      id: d.id,
      ticket: Number(d.ticket),
      positionId: d.positionId,
      positionTicket: p.ticket,
      accountNumber: a.accountNumber,
      currency: a.currency,
      accountFullName: a.fullName,
      symbol: s?.name ?? null,
      digits,
      side: d.side,
      entry: d.entry,
      reason: d.reason,
      source: d.source,
      volume: d.volume.toString(),
      price: d.price.toFixed(digits),
      profit: d.profit.toFixed(2),
      commission: d.commission.toFixed(2),
      swap: d.swap.toFixed(2),
      executedAt: fmt(d.executedAt),
      byPositionTicket: d.byPositionId ? pos.get(d.byPositionId)?.ticket ?? null : null,
      voided: d.voidedAt != null,
      deleted: p.deletedAt != null,
      pendingAction: pending.get(d.positionId) ?? null,
      ...(d.orderId && ord.get(d.orderId)
        ? { execution: executionDetail(ord.get(d.orderId)!, digits) }
        : d.entry === "OUT" || d.entry === "OUT_BY" ? { execution: dealExecutionDetail(d, digits, p.bookType) } : {}),
    });
  }
  return NextResponse.json(rows, { headers });
}
