import "server-only";

// Publish-only relay for the legacy Next.js trade routes — see
// docs/webtrader-stm-architecture-review.md §4.3 (sequencing item 4).
//
// This used to open a direct NATS connection from inside the Vercel
// serverless function itself. That never actually worked in production:
// confirmed via `vercel env ls production` that NATS_URL was never set
// at all, so every attempt fell back to connecting to
// nats://127.0.0.1:4222 — nothing lives inside an ephemeral serverless
// container at that address — and the connection failure was caught and
// only ever `console.warn`ed. Every backoffice "live" view fed by these
// events (dealing queue, positions, exposure) has depended on a manual
// page refresh in production since the day they were built, with zero
// visible error anywhere.
//
// Fixed by publishing over plain HTTPS instead, to a new endpoint on the
// API Gateway (services/api-gateway/src/index.ts's POST /internal/events)
// — a process that already holds a real, working NATS connection (it
// runs where NATS is actually reachable) and already owns every
// subscriber that matters (attachTradingEventStream, attachAdminEventStream).
// Vercel can already reach this gateway (the WebSocket price/admin
// streams prove that); this is one more route on the same service, same
// shared-secret convention as app/api/manage/feed-health/route.ts's own
// calls to it.
const SUBJECTS: Record<string, string> = {
  OrderAccepted: "order.accepted",
  OrderRejected: "order.rejected",
  OrderFilled: "order.filled",
  OrderCancelled: "order.cancelled",
  OrderRequoted: "order.requoted",
  DealingQueued: "dealing.queued",
  PositionClosed: "position.closed",
  PositionModified: "position.modified",
};

export type TradingEventType = keyof typeof SUBJECTS;

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:8080";
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "";

// broker_id is required (not just conventional) since services/api-
// gateway's admin event stream (attachAdminEventStream) filters every
// message by this field to scope it to one broker's backoffice --
// unlike the trader stream (account_id-keyed), which every event here
// already carried. A publish call missing it would silently vanish from
// every backoffice tab watching that broker, so it's enforced in the
// type rather than left to each call site to remember.
export async function publishTradingEvent(
  type: TradingEventType,
  payload: Record<string, unknown> & { broker_id: string }
): Promise<void> {
  try {
    // Bounded, not truly fire-and-forget -- a slow/unreachable gateway
    // must never add meaningful latency to (or fail) the caller's own
    // trade/dealing action. Same 2s AbortController convention as
    // app/api/manage/feed-health/route.ts's own internal-service calls.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${GATEWAY_URL}/internal/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SERVICE_SECRET },
        body: JSON.stringify({ subject: SUBJECTS[type], payload: { type, ...payload } }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn("publishTradingEvent: gateway rejected event", type, res.status);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn("failed to publish trading event to gateway", type, err);
  }
}
