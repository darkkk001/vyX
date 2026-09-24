import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

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
// `as const satisfies`: the event names are a closed set. It used to be typed Record<string, string>, which made
// TradingEventType plain `string` -- so publishTradingEvent("BalanceChanged") compiled although the map had no such
// entry, sent `subject: undefined`, and the gateway rejected every deposit / withdrawal / adjustment event (400):
// the terminal and WebTrader never heard of a backoffice balance change until some other event refreshed them
// (2026-09-24). A misspelt or missing event name is now a type error.
const SUBJECTS = {
  OrderAccepted: "order.accepted",
  OrderRejected: "order.rejected",
  OrderFilled: "order.filled",
  OrderCancelled: "order.cancelled",
  OrderRequoted: "order.requoted",
  // A pending LIMIT/STOP order's own entry price (and/or SL/TP) edited in
  // place -- the chart's draggable entry-price line. Under the already-
  // subscribed order.> wildcard on both event streams, so no gateway
  // subscription change was needed (same reasoning as PositionsClosed's
  // own comment below).
  OrderModified: "order.modified",
  DealingQueued: "dealing.queued",
  PositionClosed: "position.closed",
  PositionModified: "position.modified",
  // One event for a whole bulk close (lib/bulk-close.ts) instead of N
  // PositionClosed events -- still under the position.> wildcard both
  // event streams already subscribe to, so no gateway subscription
  // change was needed for it (same reasoning as DealingQueued's own
  // comment above).
  PositionsClosed: "position.closed_bulk",
  // Dealer-awareness feed/notifications (backoffice-only -- see
  // lib/dealer-activity.ts). Subject lives under the already-subscribed
  // dealing.> wildcard (services/api-gateway/src/ws.ts's
  // attachAdminEventStream), so no gateway change was needed; deliberately
  // NOT under order.>/position.>, which attachTradingEventStream (the
  // trader-facing stream) also subscribes to -- this event carries other
  // accounts' activity and must never reach a trader's own browser.
  DealerActivity: "dealing.activity",
  // A backoffice balance change landed on an account (deposit / withdrawal approved, adjustment, transfer, IB
  // payout). Account-scoped (account_id), like order.> / position.>: the gateway's trader stream forwards it to
  // that account's sockets, the admin stream (account.>) to its broker's backoffice. Clients refetch the account.
  BalanceChanged: "account.balance",
} as const satisfies Record<string, string>;

export type TradingEventType = keyof typeof SUBJECTS;

export type BufferedTradingEvent = { type: TradingEventType; payload: Record<string, unknown> & { broker_id: string } };

// Rust cutover Stage 3 (lib/post-close.ts): while `fn` runs, every publishTradingEvent call is collected into
// `buffer` instead of being sent. The outbox runner records a step's events in the SAME transaction as the
// step's writes and publishes them only once that transaction has committed, so an event can never announce a
// write that rolled back, and a crash between commit and publish just publishes again (at-least-once).
const eventBuffer = new AsyncLocalStorage<BufferedTradingEvent[]>();

export function withTradingEventBuffer<T>(buffer: BufferedTradingEvent[], fn: () => Promise<T>): Promise<T> {
  return eventBuffer.run(buffer, fn);
}

/** Runs `fn` (typically a transaction) and publishes the events it raised only after it resolved; nothing is
 *  published when it throws. Inside an outer buffer (the outbox runner) the events simply join that buffer. */
export async function deferTradingEvents<T>(fn: () => Promise<T>): Promise<T> {
  if (eventBuffer.getStore()) return fn();
  const buffer: BufferedTradingEvent[] = [];
  const result = await eventBuffer.run(buffer, fn);
  for (const e of buffer) await publishTradingEvent(e.type, e.payload);
  return result;
}

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
  const buffer = eventBuffer.getStore();
  if (buffer) {
    buffer.push({ type, payload });
    return;
  }
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

// Phase 1 trust pack §3 -- hot-reloads engine/server's in-memory
// AlertCache (engine/market-data/src/alerts.rs) the moment
// app/api/trade/alerts creates or cancels a PriceAlert, so a trader's new
// alert is checked against the very next tick instead of waiting for the
// engine's own restart-only boot load. Per-broker subject
// (`cfg.alerts.{brokerId}`, not a shared `cfg.alerts.*` topic every
// engine process would need to filter itself) even though today there's
// only one engine process subscribing to the wildcard -- keeps this
// symmetric with every other broker-scoped publish in this file rather
// than being the one exception.
export type AlertConfigMessage =
  | {
      action: "create";
      id: string;
      account_id: string;
      broker_id: string;
      symbol: string;
      condition: "ABOVE" | "BELOW" | "CROSSES";
      price: string;
    }
  | { action: "cancel"; id: string; broker_id: string };

// Same publish-over-HTTPS-to-the-gateway approach as publishTradingEvent
// above (this file no longer holds a direct NATS connection at all --
// see this file's own top-of-file comment on why), just with a dynamic
// per-broker subject instead of a fixed SUBJECTS[type] lookup --
// /internal/events accepts any subject string, not just the trading-
// event ones.
export async function publishAlertConfig(message: AlertConfigMessage): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${GATEWAY_URL}/internal/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SERVICE_SECRET },
        body: JSON.stringify({ subject: `cfg.alerts.${message.broker_id}`, payload: message }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn("publishAlertConfig: gateway rejected event", message.action, res.status);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn("failed to publish alert config to gateway", message.action, err);
  }
}
