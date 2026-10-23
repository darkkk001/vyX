import "server-only";
import type { Deal } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { EXEC_ORDER_SELECT, clientExecution, dealExecutionDetail, executionDetail } from "@/lib/order-execution";

// D-4 (owner 2026-10-23): the execution detail a client's own history carries (terminal 1.0.94 Fill details reads
// openExecution / closeExecution). Same sources as the backoffice (GET /api/manage/deals): the opening Order; the close
// = the newest FILLED queued-close Order, else the newest OUT / OUT_BY deal (D-3). Filtered by clientExecution.

type Subject = { id: string; originOrderId: string; bookType: string | null; symbol: { digits: number } };

/// openExecution / closeExecution per position of this account (closeExecution absent while nothing is closed).
export async function loadPositionExecutions(accountId: string, positions: Subject[]): Promise<Map<string, { openExecution?: Record<string, string | number>; closeExecution?: Record<string, string | number> }>> {
  const out = new Map<string, { openExecution?: Record<string, string | number>; closeExecution?: Record<string, string | number> }>();
  if (positions.length === 0) return out;
  const ids = positions.map((p) => p.id);
  const [opens, closeOrders, outs] = await Promise.all([
    prisma.order.findMany({ where: { accountId, id: { in: positions.map((p) => p.originOrderId) } }, select: { id: true, ...EXEC_ORDER_SELECT } }),
    prisma.order.findMany({ where: { accountId, closesPositionId: { in: ids }, status: "FILLED" }, orderBy: { filledAt: "desc" }, select: { closesPositionId: true, ...EXEC_ORDER_SELECT } }),
    prisma.deal.findMany({ where: { accountId, positionId: { in: ids }, entry: { in: ["OUT", "OUT_BY"] } }, orderBy: [{ executedAt: "desc" }, { ticket: "desc" }] }),
  ]);
  const openById = new Map(opens.map((o) => [o.id, o]));
  const closeOrderOf = new Map<string, (typeof closeOrders)[number]>();
  for (const o of closeOrders) if (o.closesPositionId && !closeOrderOf.has(o.closesPositionId)) closeOrderOf.set(o.closesPositionId, o);
  const lastOut = new Map<string, Deal>();
  for (const d of outs) if (!lastOut.has(d.positionId)) lastOut.set(d.positionId, d);
  for (const p of positions) {
    const digits = p.symbol.digits;
    const open = openById.get(p.originOrderId);
    const closeOrder = closeOrderOf.get(p.id);
    const outDeal = lastOut.get(p.id);
    const close = closeOrder ? executionDetail(closeOrder, digits) : outDeal ? dealExecutionDetail(outDeal, digits, p.bookType) : undefined;
    out.set(p.id, {
      ...(open ? { openExecution: clientExecution(executionDetail(open, digits)) } : {}),
      ...(close ? { closeExecution: clientExecution(close) } : {}),
    });
  }
  return out;
}

/// `execution` per deal of this account: an order-backed deal (the open, a queued close) from its Order, any other
/// OUT / OUT_BY from the deal itself; nothing for an IN without an order.
export async function loadDealExecutions(accountId: string, deals: Deal[], digitsOf: (symbolId: string) => number, bookTypeOf: (positionId: string) => string | null) {
  const orderIds = [...new Set(deals.map((d) => d.orderId).filter((id): id is string => !!id))];
  const orders = orderIds.length === 0 ? [] : await prisma.order.findMany({ where: { accountId, id: { in: orderIds } }, select: { id: true, ...EXEC_ORDER_SELECT } });
  const byId = new Map(orders.map((o) => [o.id, o]));
  return (d: Deal): Record<string, string | number> | undefined => {
    const digits = digitsOf(d.symbolId);
    const o = d.orderId ? byId.get(d.orderId) : undefined;
    if (o) return clientExecution(executionDetail(o, digits));
    if (d.entry === "OUT" || d.entry === "OUT_BY") return clientExecution(dealExecutionDetail(d, digits, bookTypeOf(d.positionId)));
    return undefined;
  };
}
