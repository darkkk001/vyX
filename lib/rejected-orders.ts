import "server-only";
import { prisma } from "@/lib/prisma";
import { publishTradingEvent } from "@/lib/nats";
import { requestMeta } from "@/lib/order-execution";

// Rejected-order trace (2026-10-23, owner, SpotBrent investigation). An order request the client route refused BEFORE
// any Order row was written left no trace: the trader saw "market closed" and the broker saw nothing. Now every such
// refusal (app/api/trade/orders/route.ts, HTTP 400 whose answer carries no order) is one RejectedOrder row plus a
// backoffice-only event (dealing.order_rejected: only the admin stream subscribes dealing.>, so the trader's own
// terminal does not refetch on it); the Live exposure FEED lists it as REJECTED (lib/dealer-activity.ts).
// Best effort: written after the response, never fails or delays the trader's answer.

type Session = { accountId: string; brokerId: string };

const SIDES = new Set(["BUY", "SELL"]);
const TYPES = new Set(["MARKET", "LIMIT", "STOP"]);
const SOURCES = new Set(["DESKTOP_NATIVE", "MOBILE", "API"]);
const clip = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/** The refusal of one order request, from the request the client sent and the 400 answer it got. Returns the row id,
 *  or null when there is nothing to record (an answer that carries an order is not a pre-insert refusal). */
export async function traceRejectedOrder(
  session: Session,
  headers: Headers,
  requestedAt: Date,
  requestBody: Record<string, unknown> | null,
  answer: Record<string, unknown> | null
): Promise<string | null> {
  if (!answer || answer.order != null || answer.position != null) return null;
  const meta = requestMeta(headers, requestedAt);
  const platformHeader = headers.get("x-client-platform") ?? "";
  const symbol = clip(requestBody?.symbol, 40) ?? "(none)";
  const side = typeof requestBody?.side === "string" && SIDES.has(requestBody.side) ? requestBody.side : null;
  const orderType = typeof requestBody?.type === "string" && TYPES.has(requestBody.type) ? requestBody.type : null;
  const volume = requestBody?.volume != null ? clip(String(requestBody.volume), 30) : null;
  const reason = clip(answer.error, 120) ?? "REJECTED";
  const detail = clip(answer.reason, 200) ?? clip(answer.code, 200);
  const account = await prisma.account.findUnique({ where: { id: session.accountId }, select: { accountNumber: true } });
  const row = await prisma.rejectedOrder.create({
    data: {
      brokerId: session.brokerId,
      accountId: session.accountId,
      symbol,
      side,
      volume,
      orderType,
      reason,
      detail,
      requestedAt,
      platform: meta.platform,
      clientIp: meta.clientIp,
      source: SOURCES.has(platformHeader) ? (platformHeader as "DESKTOP_NATIVE" | "MOBILE" | "API") : "WEB",
    },
  });
  await publishTradingEvent("OrderRejectedPreTrade", {
    broker_id: session.brokerId,
    account_id: session.accountId,
    account_number: account?.accountNumber ?? null,
    symbol,
    side,
    volume,
    reason,
    detail,
    rejected_order_id: row.id,
  }).catch(() => {});
  return row.id;
}
