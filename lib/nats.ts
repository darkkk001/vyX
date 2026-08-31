import "server-only";
import { connect, type NatsConnection, StringCodec } from "nats";

// Publish-only NATS client for the legacy Next.js trade routes — see
// docs/webtrader-stm-architecture-review.md §4.3 (sequencing item 4).
// engine/order-management publishes the same TradingEvent shape
// (engine/protocol/src/lib.rs) once a broker's orders route through the
// Rust engine; until then (ADR-003 — every broker today), these routes
// are the only source of these events. The API Gateway
// (services/api-gateway/src/ws.ts's attachTradingEventStream) doesn't
// care which side published a given message, only that the JSON shape
// and subject convention match.
//
// Connection is lazily established and cached at module scope (this
// process's one connection, reused across requests) rather than
// reconnecting per publish — same rationale as lib/redis.ts's singleton.
let connectionPromise: Promise<NatsConnection> | null = null;
const sc = StringCodec();

function getConnection(): Promise<NatsConnection> {
  if (!connectionPromise) {
    const natsUrl = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
    connectionPromise = connect({ servers: natsUrl }).catch((err) => {
      // Let the next publish attempt retry a fresh connection instead of
      // permanently caching a failed one.
      connectionPromise = null;
      throw err;
    });
  }
  return connectionPromise;
}

// Subject convention matches engine/order-management/src/events.rs's
// subject_for exactly -- both producers feed the same Gateway
// subscription (order.>, margin.>, position.>). DealingQueued has no
// Rust-side analog yet -- the legacy Next.js dealing-queue path
// (app/api/manage/dealing-queue/[id]/route.ts) is the only producer, but
// it's still under the order.> wildcard the trading-event stream already
// subscribes to, so no gateway subscription change was needed for it.
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
    const nc = await getConnection();
    nc.publish(SUBJECTS[type], sc.encode(JSON.stringify({ type, ...payload })));
  } catch (err) {
    console.warn("failed to publish trading event to NATS", type, err);
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

export async function publishAlertConfig(message: AlertConfigMessage): Promise<void> {
  try {
    const nc = await getConnection();
    nc.publish(`cfg.alerts.${message.broker_id}`, sc.encode(JSON.stringify(message)));
  } catch (err) {
    console.warn("failed to publish alert config to NATS", message.action, err);
  }
}
