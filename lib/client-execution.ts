import "server-only";
import { Prisma, type Deal } from "@prisma/client";
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

// ---- Client-safe row shapes (owner 2026-10-23): what a CLIENT route may return of a Position or an Order. ----
// The ONE allow-list for every /api/trade/* answer: a field not listed here never reaches a client, so a column added
// to the schema later stays server-side until it is added on purpose. Left out on purpose: the broker's book and
// routing (bookType, groupCategoryAtOpen, routing, executionMode), coverage (covered, autoHedged, coveredAt,
// coveragePositionId), tenancy / ownership ids (brokerId, accountId), staff identities (closedByAdminId -> a fixed
// "staff" marker, deletedByAdminId, deleteReason), soft-delete and internal bookkeeping (deletedAt, lastSwapAt,
// reversedFromPositionId), and a staff member's IP. Every field a shipped client reads (terminal, WebTrader, mobile,
// 2026-10-23) is in the lists.

const POSITION_FIELDS = [
  "id", "ticket", "symbolId", "originOrderId", "side", "volume", "openPrice", "slPrice", "tpPrice", "status", "closePrice",
  "realizedPnl", "swap", "commission", "closedVolume", "closedSwap", "initialVolume", "openedAt", "closedAt", "closePendingOrderId",
  // relations the client routes select (already narrowed by their own selects)
  "symbol", "originOrder", "closePendingOrder",
] as const;

const ORDER_FIELDS = [
  "id", "ticket", "symbolId", "side", "type", "volume", "requestedPrice", "slPrice", "tpPrice", "status", "filledPrice", "filledAt",
  "rejectionReason", "requotedPrice", "idempotencyKey", "source", "closesPositionId", "closeVolume", "closeByPositionId",
  "requestedAt", "executedAt", "platform", "createdAt", "updatedAt",
  "symbol",
] as const;

// a ledger row (the close route answers with its TRADE_PNL row): what GET /api/trade/transactions selects, plus the
// close's own fields; never the tenancy ids or any staff review / marking field
const TRANSACTION_FIELDS = [
  "id", "type", "status", "amount", "balanceBefore", "balanceAfter", "note", "createdAt", "referenceType", "referenceId",
  "closeVolume", "closePrice", "closeSwap", "closeByPositionId",
] as const;

// GET /api/trade/me, the account's own info (owner 2026-10-23): the group is internal. Its name ("Dealing", "Reverse"...)
// and id never reach a client; the client-facing label is accountPlan (Group.displayName, default "Standard").
const ACCOUNT_INFO_FIELDS = [
  "id", "accountNumber", "accountMode", "currency", "leverage", "balance", "credit", "status", "tradingRights", "fullName",
  "twoFactorEnabled", "tradingDayStart", "tradingWeekStart", "tradingDaySource", "marginCallLevel", "stopOutLevel",
  "tradingState", "tradingRestriction", "accountPlan",
] as const;

type Row = Record<string, unknown>;

/// /api/trade/me's answer cut to the client allow-list.
export function clientAccountInfo(a: Row): Row {
  const out: Row = {};
  for (const k of ACCOUNT_INFO_FIELDS) if (k in a) out[k] = a[k];
  return out;
}

/// A Position row (or a DTO spread from one) cut to the client allow-list.
export function clientPosition(p: Row): Row {
  const out: Row = {};
  for (const k of POSITION_FIELDS) if (k in p) out[k] = p[k];
  if (p.closedByAdminId != null) out.closedByAdminId = "staff"; // clients test presence only (closed by the desk)
  return out;
}

/// An Order row cut to the client allow-list; the IP only on an order the client placed itself.
export function clientOrder(o: Row): Row {
  const out: Row = {};
  for (const k of ORDER_FIELDS) if (k in o) out[k] = o[k];
  if (o.clientIp != null && CLIENT_ORDER_SOURCES.has(String(o.source ?? ""))) out.clientIp = o.clientIp;
  if (o.position != null && typeof o.position === "object") out.position = toClientShape(o.position);
  return out;
}
const CLIENT_ORDER_SOURCES = new Set(["WEB", "DESKTOP_NATIVE", "MOBILE", "API", "EA"]);

// A raw DB row is recognised by keys only the database row carries: a Position always has bookType (non-null enum),
// an Order always has idempotencyKey. Anything else (computed fields, closes, executions, balances) is kept as it is.
const isPositionRow = (v: Row) => "bookType" in v && "openPrice" in v;
const isOrderRow = (v: Row) => "idempotencyKey" in v && "type" in v;
const isTransactionRow = (v: Row) => "balanceBefore" in v && "balanceAfter" in v && "referenceType" in v;
function pick(v: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const k of keys) if (k in v) out[k] = v[k];
  return out;
}

/// Walks a client route's answer and cuts every Position / Order row in it to the allow-list (arrays, nested objects,
/// `{ order, position }` envelopes). Keys a route adds next to the row's own (closes, openExecution, ...) survive: they
/// are applied to the row object itself, so callers cut the row first and add their computed fields after, or pass the
/// combined object (a combined object keeps its non-row keys).
export function toClientShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toClientShape);
  if (value === null || typeof value !== "object" || value instanceof Date || isDecimalLike(value)) return value;
  const v = value as Row;
  if (isPositionRow(v)) return { ...extras(v, POSITION_FIELDS, POSITION_RAW_ONLY), ...clientPosition(v) };
  if (isOrderRow(v)) return { ...extras(v, ORDER_FIELDS, ORDER_RAW_ONLY), ...clientOrder(v) };
  if (isTransactionRow(v)) return { ...extras(v, TRANSACTION_FIELDS, TRANSACTION_RAW_ONLY), ...pick(v, TRANSACTION_FIELDS) };
  const out: Row = {};
  for (const [k, x] of Object.entries(v)) out[k] = toClientShape(x);
  return out;
}

// Every column and relation of the two models, from the Prisma schema itself: a key of a row object that is NOT one of
// them is a computed field a route added (closes, openExecution, closedPnl, ...) and is kept; a key that IS one is kept
// only when it is on the allow-list. A column added to the schema later is therefore dropped until it is listed.
const modelFields = (name: string) => new Set((Prisma.dmmf.datamodel.models.find((m) => m.name === name)?.fields ?? []).map((f) => f.name));
const POSITION_RAW_ONLY = modelFields("Position");
const ORDER_RAW_ONLY = modelFields("Order");
const TRANSACTION_RAW_ONLY = modelFields("Transaction");
function extras(v: Row, allowed: readonly string[], rawOnly: Set<string>): Row {
  const out: Row = {};
  for (const [k, x] of Object.entries(v)) if (!allowed.includes(k) && !rawOnly.has(k)) out[k] = toClientShape(x);
  return out;
}
function isDecimalLike(v: object): boolean {
  return typeof (v as { toFixed?: unknown }).toFixed === "function" && typeof (v as { d?: unknown }).d !== "undefined";
}
