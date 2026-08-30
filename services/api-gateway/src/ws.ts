// Price-tick WebSocket fan-out — the "GW -> WebSocket -> Web/Desktop/
// Mobile charts" leg of docs/market-data.md §2's diagram. Subscribes once
// to NATS (published by engine/server's ingest route, one message per
// tick on `price.tick.{symbol}`) and re-broadcasts every message to every
// connected browser, replacing WebTrader.tsx's client-side polling of
// /api/trade/prices with a push.
//
// Auth: the browser's native WebSocket API can't attach custom headers,
// only cookies ride along automatically — so the handshake is gated on
// the same Redis-backed trader session cookie requireTraderSession checks
// (src/auth.ts), just without that middleware's additional X-Broker-Id
// cross-check (there's no way for a browser WS client to send that
// header either). That's an acceptable narrowing here specifically
// because ticks are broker-agnostic raw market data, not
// account/broker-scoped (see docs/market-data.md's auth note) — a valid
// trader session on any broker proves "this is a logged-in trader," which
// is all this stream needs to gate on.

import type { IncomingMessage, Server } from "http";
import { connect, type NatsConnection } from "nats";
import { WebSocket, WebSocketServer } from "ws";
import { getTraderSession } from "./auth.js";
import { getAdminSession } from "./admin-auth.js";
import { getEnabledSymbolNames } from "./db.js";

const PRICE_STREAM_PATH = "/v1/prices/stream";
const TRADING_STREAM_PATH = "/v1/trading/stream";
const ADMIN_EVENTS_STREAM_PATH = "/v1/events/stream";

// Per-broker enabled-symbol cache, 30s TTL -- "hot-reload on cfg change"
// in practice means a Manager toggling a symbol's enabled flag is picked
// up within at most 30s, not instantly; there's no push channel from the
// Next.js app's own symbol-config mutation to this process (no NATS
// event, no LISTEN/NOTIFY) to do better than that without adding one, and
// a symbol enable/disable isn't latency-sensitive the way a price tick
// is. Re-fetched lazily per broker (on first connection or cache expiry),
// not pre-warmed for every broker up front.
interface SymbolFilterCacheEntry {
  symbols: Set<string>;
  fetchedAt: number;
}
const SYMBOL_FILTER_TTL_MS = 30_000;
const symbolFilterCache = new Map<string, SymbolFilterCacheEntry>();

async function getEnabledSymbolsCached(brokerId: string): Promise<Set<string>> {
  const cached = symbolFilterCache.get(brokerId);
  if (cached && Date.now() - cached.fetchedAt < SYMBOL_FILTER_TTL_MS) {
    return cached.symbols;
  }
  const names = await getEnabledSymbolNames(brokerId);
  const symbols = new Set(names);
  symbolFilterCache.set(brokerId, { symbols, fetchedAt: Date.now() });
  return symbols;
}

// Phase 4 of the tick-pipeline audit -- exported so index.ts's stats
// route can read it without this module needing its own HTTP route.
// Counters only (no rolling latency window here, unlike engine/server's
// FeedStats): this hop doesn't see per-tick timestamps, just connection
// lifecycle, so "how many times has this reconnected" is the meaningful
// signal at this layer.
export const gatewayStats = {
  wsConnectionsTotal: 0,
  wsDisconnectionsTotal: 0,
  ticksForwardedTotal: 0,
  natsMessagesReceivedTotal: 0,
  tradingWsConnectionsTotal: 0,
  tradingWsDisconnectionsTotal: 0,
  tradingEventsForwardedTotal: 0,
  tradingEventsReceivedTotal: 0,
  adminWsConnectionsTotal: 0,
  adminWsDisconnectionsTotal: 0,
  adminEventsForwardedTotal: 0,
  adminEventsReceivedTotal: 0,
};

// Phase 0 money-risk patch item 3 (docs/ROADMAP.md) -- "we will never
// again ship an order path we can't measure." This process (unlike the
// Vercel-hosted legacy path, see lib/order-latency.ts's own comment on
// why that one needs Redis instead) is a single long-running host, so a
// plain capped array works -- same windowed-percentile shape as
// engine/market-data/src/stats.rs's FeedStats, sized the same (500).
// Records src/routes/orders.ts's own gateway-to-Rust-engine round trip
// for POST /market -- this Gateway's own definition of "order ack".
const ORDER_ACK_WINDOW = 500;
const orderAckLatenciesMs: number[] = [];

export function recordOrderAckLatency(ms: number): void {
  orderAckLatenciesMs.push(ms);
  if (orderAckLatenciesMs.length > ORDER_ACK_WINDOW) orderAckLatenciesMs.shift();
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.round((sorted.length - 1) * p)];
}

export function orderAckStats(): { order_ack_ms_p50: number | null; order_ack_ms_p95: number | null; order_ack_sample_count: number } {
  const sorted = [...orderAckLatenciesMs].sort((a, b) => a - b);
  return {
    order_ack_ms_p50: percentile(sorted, 0.5),
    order_ack_ms_p95: percentile(sorted, 0.95),
    order_ack_sample_count: sorted.length,
  };
}

export async function attachPriceStream(server: Server, natsUrl: string): Promise<void> {
  const nc: NatsConnection = await connect({ servers: natsUrl });
  const sub = nc.subscribe("price.tick.*");

  const wss = new WebSocketServer({ noServer: true });
  // ws -> that connection's own broker id, so a forwarded tick can be
  // checked against that specific broker's enabled-symbol set (see
  // getEnabledSymbolsCached above) -- was a bare Set<WebSocket> before
  // the per-tenant filtering this map exists for.
  const clients = new Map<WebSocket, string>();

  function registerClient(ws: WebSocket, brokerId: string) {
    clients.set(ws, brokerId);
    gatewayStats.wsConnectionsTotal += 1;
    ws.on("close", () => {
      clients.delete(ws);
      gatewayStats.wsDisconnectionsTotal += 1;
    });
    ws.on("error", () => {
      clients.delete(ws);
      gatewayStats.wsDisconnectionsTotal += 1;
    });
  }

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const { pathname } = new URL(req.url ?? "", "http://internal");
    if (pathname !== PRICE_STREAM_PATH) return;

    getTraderSession(req.headers.cookie)
      .then((session) => {
        if (!session) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          registerClient(ws, session.brokerId);
        });
      })
      .catch((err) => {
        console.error("price stream: session lookup failed", err);
        socket.destroy();
      });
  });

  // NATS payloads are already the exact JSON the Rust side serialized
  // (protocol::Tick — {symbol, bid, ask}) — decoded to a string and sent
  // as a WS text frame (not the raw bytes as binary) so the browser's
  // native WebSocket delivers `event.data` as a string, not a Blob.
  //
  // Per-tenant filtering (second Contabo-audit follow-up): the engine no
  // longer enforces a fixed symbol list (a MARKET_WATCH-mode EA can push
  // anything selected in a terminal), so this is now the only place a
  // broker's traders are kept to that broker's own enabled symbols --
  // every tick is parsed for its `symbol` once, then checked per client
  // against that client's own broker's cached enabled-symbol set.
  (async () => {
    for await (const msg of sub) {
      gatewayStats.natsMessagesReceivedTotal += 1;
      const text = Buffer.from(msg.data).toString("utf-8");
      let symbol: string | undefined;
      try {
        symbol = JSON.parse(text)?.symbol;
      } catch {
        continue; // malformed tick -- nothing to filter or forward
      }
      if (!symbol) continue;

      for (const [client, brokerId] of clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        const enabled = await getEnabledSymbolsCached(brokerId);
        if (!enabled.has(symbol)) continue;
        client.send(text);
        gatewayStats.ticksForwardedTotal += 1;
      }
    }
  })().catch((err) => {
    console.error("price stream: NATS subscription loop ended", err);
  });
}

// Order/position/account event fan-out — docs/webtrader-stm-architecture-
// review.md §4.3 (sequencing item 4). Unlike price ticks (broker-agnostic
// market data, broadcast to every connected client), these events are
// account-scoped and sensitive -- a fill/rejection/close belongs to one
// trader's session, never every connected browser -- so this keeps a
// Map<accountId, Set<WebSocket>> instead of one flat Set, and only
// forwards a message to the sockets registered under the account_id that
// message itself carries (every TradingEvent variant has one -- see
// protocol::TradingEvent's doc comment). accountId is never taken from
// anything the client sends; it comes from the same Redis-backed session
// lookup getTraderSession always uses, so a client can only ever end up
// registered under its own account.
//
// Published from two places today: engine/order-management (once a
// broker's orders route through the Rust engine -- see
// events.rs/publish_best_effort) and the legacy Next.js trade routes via
// lib/nats.ts (the actually-live path today, per ADR-003) -- both publish
// the identical JSON shape, so this one subscription/fan-out serves
// either origin without caring which one produced a given event.
export async function attachTradingEventStream(server: Server, natsUrl: string): Promise<void> {
  const nc: NatsConnection = await connect({ servers: natsUrl });
  const subs = [nc.subscribe("order.>"), nc.subscribe("margin.>"), nc.subscribe("position.>")];

  const wss = new WebSocketServer({ noServer: true });
  const clientsByAccount = new Map<string, Set<WebSocket>>();

  function registerClient(ws: WebSocket, accountId: string) {
    let set = clientsByAccount.get(accountId);
    if (!set) {
      set = new Set();
      clientsByAccount.set(accountId, set);
    }
    set.add(ws);
    gatewayStats.tradingWsConnectionsTotal += 1;

    function unregister() {
      set!.delete(ws);
      if (set!.size === 0) clientsByAccount.delete(accountId);
      gatewayStats.tradingWsDisconnectionsTotal += 1;
    }
    ws.on("close", unregister);
    ws.on("error", unregister);
  }

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const { pathname } = new URL(req.url ?? "", "http://internal");
    if (pathname !== TRADING_STREAM_PATH) return;

    getTraderSession(req.headers.cookie)
      .then((session) => {
        if (!session) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          registerClient(ws, session.accountId);
        });
      })
      .catch((err) => {
        console.error("trading stream: session lookup failed", err);
        socket.destroy();
      });
  });

  for (const sub of subs) {
    (async () => {
      for await (const msg of sub) {
        gatewayStats.tradingEventsReceivedTotal += 1;
        const text = Buffer.from(msg.data).toString("utf-8");

        let accountId: string | undefined;
        try {
          accountId = JSON.parse(text)?.account_id;
        } catch {
          continue; // malformed payload -- nothing to route it to
        }
        if (!accountId) continue;

        const clients = clientsByAccount.get(accountId);
        if (!clients) continue;
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(text);
            gatewayStats.tradingEventsForwardedTotal += 1;
          }
        }
      }
    })().catch((err) => {
      console.error("trading stream: NATS subscription loop ended", err);
    });
  }
}

// Backoffice real-time sync (fix/realtime-sync §1) -- the Manager/Broker-
// Admin equivalent of attachTradingEventStream above. Backoffice pages
// (app/manage/(shell)/dealing, /positions, ...) previously only loaded
// data once via a Server Component or a manual poll and never learned
// about a change another dealer/tab (or the trader themselves) made until
// a manual refresh -- see lib/nats.ts's publishTradingEvent, now called
// from every order/position mutation site with a broker_id field added
// specifically for this stream to filter on.
//
// Scoped to one broker per connection (unlike the trader stream's
// account_id scoping, or the price stream's per-broker symbol-allowlist
// filtering) since every consumer today (Dealing Queue, Positions) is a
// Manager/Broker Admin page -- Super Admin's own cross-tenant pages
// (Brokers, Health, ...) aren't part of this fix and are refused a
// connection (a null brokerId session) rather than silently getting every
// broker's events or none.
export async function attachAdminEventStream(server: Server, natsUrl: string): Promise<void> {
  const nc: NatsConnection = await connect({ servers: natsUrl });
  const subs = [nc.subscribe("order.>"), nc.subscribe("position.>"), nc.subscribe("dealing.>"), nc.subscribe("account.>")];

  const wss = new WebSocketServer({ noServer: true });
  // ws -> that connection's own admin's brokerId, same per-tenant
  // filtering shape as attachPriceStream's clients map.
  const clientsByBroker = new Map<WebSocket, string>();

  function registerClient(ws: WebSocket, brokerId: string) {
    clientsByBroker.set(ws, brokerId);
    gatewayStats.adminWsConnectionsTotal += 1;
    function unregister() {
      clientsByBroker.delete(ws);
      gatewayStats.adminWsDisconnectionsTotal += 1;
    }
    ws.on("close", unregister);
    ws.on("error", unregister);
  }

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const { pathname } = new URL(req.url ?? "", "http://internal");
    if (pathname !== ADMIN_EVENTS_STREAM_PATH) return;

    getAdminSession(req.headers.cookie)
      .then((session) => {
        if (!session) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        if (!session.brokerId) {
          // Super Admin (brokerId: null) -- out of scope, see this
          // function's own doc comment.
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          registerClient(ws, session.brokerId!);
        });
      })
      .catch((err) => {
        console.error("admin event stream: session lookup failed", err);
        socket.destroy();
      });
  });

  for (const sub of subs) {
    (async () => {
      for await (const msg of sub) {
        gatewayStats.adminEventsReceivedTotal += 1;
        const text = Buffer.from(msg.data).toString("utf-8");

        let brokerId: string | undefined;
        try {
          brokerId = JSON.parse(text)?.broker_id;
        } catch {
          continue; // malformed payload -- nothing to route it to
        }
        if (!brokerId) continue; // no broker_id -- can't be scoped, never forwarded here

        for (const [client, clientBrokerId] of clientsByBroker) {
          if (clientBrokerId !== brokerId) continue;
          if (client.readyState !== WebSocket.OPEN) continue;
          client.send(text);
          gatewayStats.adminEventsForwardedTotal += 1;
        }
      }
    })().catch((err) => {
      console.error("admin event stream: NATS subscription loop ended", err);
    });
  }
}
