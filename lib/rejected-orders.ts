import "server-only";
import { prisma } from "@/lib/prisma";
import { publishTradingEvent } from "@/lib/nats";
import { requestMeta } from "@/lib/order-execution";
import { checkRateLimit } from "@/lib/rate-limit";
import { clientReasonFor } from "@/lib/client-reason";

// Rejected-order trace (2026-10-23, owner, SpotBrent investigation). An order request the client route refused BEFORE
// any Order row was written left no trace: the trader saw "market closed" and the broker saw nothing. Now every such
// refusal (app/api/trade/orders/route.ts, HTTP 400 whose answer carries no order) is one RejectedOrder row plus a
// backoffice-only event (dealing.order_rejected: only the admin stream subscribes dealing.>, so the trader's own
// terminal does not refetch on it); the Live exposure FEED lists it as REJECTED (lib/dealer-activity.ts).
// Best effort: written after the response, never fails or delays the trader's answer.

type Session = { accountId: string; brokerId: string };

// Per account, per minute (security re-audit 2026-10-23): the order route has no rate limit of its own, so without a cap
// one signed-in client could write unlimited rows and flood every dealer's FEED. Past the cap the trader still gets
// every 400; only the trace is skipped until the minute ends.
export const REJECTED_TRACE_PER_MINUTE = 60;

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
  answer: Record<string, unknown> | null,
  // a close or modify refusal (2026-10-23): what it was about, from the position rather than the request body
  about?: { kind: "CLOSE" | "MODIFY"; positionId: string; symbol: string; side: string; volume?: string | null; lastTickAgeMs?: number | null }
): Promise<string | null> {
  if (!answer || answer.order != null || answer.position != null) return null;
  if (!(await checkRateLimit(`rejected-order:${session.accountId}`, REJECTED_TRACE_PER_MINUTE, 60)).allowed) return null;
  const meta = requestMeta(headers, requestedAt);
  const platformHeader = headers.get("x-client-platform") ?? "";
  const symbol = about ? about.symbol : clip(requestBody?.symbol, 40) ?? "(none)";
  const side = about ? about.side : typeof requestBody?.side === "string" && SIDES.has(requestBody.side) ? requestBody.side : null;
  const orderType = typeof requestBody?.type === "string" && TYPES.has(requestBody.type) ? requestBody.type : null;
  const volume = about ? about.volume ?? null : requestBody?.volume != null ? clip(String(requestBody.volume), 30) : null;
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
      kind: about?.kind ?? "OPEN",
      positionId: about?.positionId ?? null,
      clientReason: clientReasonFor(answer),
      lastTickAgeMs: about?.lastTickAgeMs ?? null,
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
    kind: about?.kind ?? "OPEN",
    position_id: about?.positionId ?? null,
  }).catch(() => {});
  return row.id;
}

const TRACED_STATUSES = new Set([400, 403, 422, 429]);

/** Close and modify refusals (owner 2026-10-23): one RejectedOrder row per refused position, from the route's internal
 *  answer (before the client allow-list cuts it). A single refusal ({ error }) is about `positionId`; a bulk answer's
 *  refused rows ({ results: [{ positionId, ok: false, error }] }) each about their own. The position supplies symbol,
 *  side and volume; the answer's `lastTickAgeMs`, when the route measured it, is kept. Best effort, after the response. */
export async function traceCloseOrModifyRefusals(
  kind: "CLOSE" | "MODIFY",
  answer: Response,
  headers: Headers,
  requestedAt: Date,
  positionId: string | null
): Promise<void> {
  if (!TRACED_STATUSES.has(answer.status) && answer.status !== 200) return;
  const body = (await answer.clone().json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return;
  const refusals: { positionId: string; answer: Record<string, unknown> }[] = [];
  if (TRACED_STATUSES.has(answer.status) && typeof body.error === "string" && positionId) refusals.push({ positionId, answer: body });
  if (answer.status === 200 && Array.isArray(body.results)) {
    for (const r of body.results as Record<string, unknown>[]) {
      if (r?.ok === false && typeof r.error === "string" && typeof r.positionId === "string") refusals.push({ positionId: r.positionId, answer: r });
    }
  }
  if (refusals.length === 0) return;
  const { runAfterResponse } = await import("@/lib/after-response");
  const { getAccountSession } = await import("@/lib/account-auth");
  await runAfterResponse(`${kind.toLowerCase()}-refusal`, async () => {
    const session = await getAccountSession();
    if (!session) return;
    const positions = await prisma.position.findMany({
      where: { id: { in: refusals.map((r) => r.positionId) }, accountId: session.accountId },
      select: { id: true, side: true, volume: true, symbol: { select: { name: true } } },
    });
    const byId = new Map(positions.map((p) => [p.id, p]));
    for (const r of refusals) {
      const p = byId.get(r.positionId);
      if (!p) continue; // someone else's or an unknown id: nothing of theirs is written
      const age = typeof r.answer.lastTickAgeMs === "number" ? Math.round(r.answer.lastTickAgeMs) : null;
      await traceRejectedOrder(session, headers, requestedAt, null, r.answer, { kind, positionId: p.id, symbol: p.symbol.name, side: p.side, volume: p.volume.toString(), lastTickAgeMs: age });
    }
  });
}
