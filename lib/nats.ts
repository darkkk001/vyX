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
// subscription (order.>, margin.>, position.>).
const SUBJECTS: Record<string, string> = {
  OrderAccepted: "order.accepted",
  OrderRejected: "order.rejected",
  OrderFilled: "order.filled",
  OrderCancelled: "order.cancelled",
  PositionClosed: "position.closed",
  PositionModified: "position.modified",
};

export type TradingEventType = keyof typeof SUBJECTS;

// Best-effort, fire-and-forget -- same rule as Rust's publish_best_effort:
// the mutation itself already committed to Postgres by the time this is
// called, so a NATS publish failure only means a connected client's UI
// stays stale until its next 2s poll, never that trading data is wrong.
// Logged, never thrown, on that basis.
export async function publishTradingEvent(
  type: TradingEventType,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const nc = await getConnection();
    nc.publish(SUBJECTS[type], sc.encode(JSON.stringify({ type, ...payload })));
  } catch (err) {
    console.warn("failed to publish trading event to NATS", type, err);
  }
}
