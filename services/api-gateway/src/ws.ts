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
import { getTraderSession, getTraderSessionByTicket } from "./auth.js";
import { getAdminSession } from "./admin-auth.js";
import { getEnabledSymbolNames } from "./db.js";

const PRICE_STREAM_PATH = "/v1/prices/stream";
const TRADING_STREAM_PATH = "/v1/trading/stream";
const ADMIN_EVENTS_STREAM_PATH = "/v1/events/stream";

// 2026-09-08 outage fix -- root cause of a full live-feed outage: nats.js
// defaults to maxReconnectAttempts=10 (node_modules/nats/lib/nats-base-
// client/options.js's own DEFAULT_MAX_RECONNECT_ATTEMPTS). A NATS blip
// long enough to exhaust 10 attempts made the client give up and close
// for good -- the gateway process stayed up (still accepted WS
// connections, still answered /internal/gateway-stats) but its `for
// await (const msg of sub)` loops had silently ended with nothing to
// restart them, so every stream (price ticks, trading events, admin
// events) went permanently dark with no crash, no log line a human would
// see, nothing -- confirmed live: natsMessagesReceivedTotal/
// ticksForwardedTotal/tradingEventsReceivedTotal/adminEventsReceivedTotal
// were all completely frozen across a 12-minute window while the engine
// kept publishing 30k+ new ticks in that same window. `connect()` now
// passes maxReconnectAttempts: -1 (unlimited) at every call site in this
// service so a transient NATS outage of ANY length reconnects on its own
// -- nats.js's own reconnect logic transparently re-establishes
// subscriptions created before the drop, no resubscribe code needed here.
// This logger is the other half of the fix: closed() resolving is now
// impossible in normal operation (unlimited retries), so if it ever
// fires again that's a real, unexpected event -- log it loudly instead
// of the silence that let this outage go undetected until a trader
// noticed stale prices.
function logNatsConnectionLoss(streamName: string, nc: NatsConnection): void {
  nc.closed().then((err) => {
    console.error(
      `[FATAL] ${streamName}: NATS connection closed permanently (reconnect attempts exhausted or an unrecoverable error), this stream is now dark until the gateway process is restarted.`,
      err ?? "(no error object, clean close)"
    );
  });
}

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
// 10 minutes, not 30 s (2026-09-23). The enabled-symbol set changes only when an admin enables or
// disables a symbol, never as a market event, but this refresh fired every 30 s for every broker with
// a client connected, which on a scale-to-zero Postgres meant it could never idle. The read stays
// stale-then-refresh off the hot path, so a change is picked up within one window and a slow DB never
// blocks a tick either way.
const SYMBOL_FILTER_TTL_MS = 600_000;
const symbolFilterCache = new Map<string, SymbolFilterCacheEntry>();

// Hot-path read: NEVER awaits a database call and NEVER throws.
//
// 2026-09-21 outage class: the tick fan-out used to `await
// getEnabledSymbolsCached(brokerId)` once per client PER TICK. On a cache
// miss that is a live DB query inside the fan-out, so (a) N connected
// clients meant N queries per tick and a TTL expiry serialised the whole
// broadcast behind a Neon round trip, and (b) a single transient DB error
// threw straight out of the `for await`, ending the NATS subscription for
// the rest of the process's life with nothing to restart it. The feed went
// silently dark -- health stayed 200, the engine kept publishing, and not
// one tick reached a client until someone restarted the gateway by hand.
//
// So the hot path now only ever reads what is already in memory. A miss or
// an expired entry returns the stale set (or, with nothing cached at all,
// null so the caller can decide) and schedules the refresh off to one side.
function getEnabledSymbolsHot(brokerId: string): Set<string> | null {
  const cached = symbolFilterCache.get(brokerId);
  if (!cached) {
    void refreshSymbolFilter(brokerId);
    return null;
  }
  if (Date.now() - cached.fetchedAt >= SYMBOL_FILTER_TTL_MS) {
    void refreshSymbolFilter(brokerId); // serve stale now, fresh next tick
  }
  return cached.symbols;
}

// Off-hot-path refresh. At most one in flight per broker; a failure leaves
// the previous entry in place (stale beats dark) and is logged, not thrown.
const symbolFilterRefreshing = new Set<string>();
async function refreshSymbolFilter(brokerId: string): Promise<void> {
  if (symbolFilterRefreshing.has(brokerId)) return;
  symbolFilterRefreshing.add(brokerId);
  try {
    const names = await getEnabledSymbolNames(brokerId);
    symbolFilterCache.set(brokerId, { symbols: new Set(names), fetchedAt: Date.now() });
  } catch (err) {
    console.error(`price stream: enabled-symbol refresh failed for broker ${brokerId} (keeping the previous set)`, err);
  } finally {
    symbolFilterRefreshing.delete(brokerId);
  }
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
  // Watchdog surface (2026-09-21): a dead fan-out used to be invisible from
  // outside -- these make "NATS is delivering but nothing is going out" a
  // readable condition rather than something a trader reports.
  priceSubscriptionRestartsTotal: 0,
  lastNatsMessageAtMs: 0,
  lastTickForwardedAtMs: 0,
  tradingWsConnectionsTotal: 0,
  tradingWsDisconnectionsTotal: 0,
  tradingEventsForwardedTotal: 0,
  tradingEventsReceivedTotal: 0,
  adminWsConnectionsTotal: 0,
  adminWsDisconnectionsTotal: 0,
  adminEventsForwardedTotal: 0,
  adminEventsReceivedTotal: 0,
  // POST /internal/events (index.ts) -- the Vercel-to-gateway relay
  // publish, distinct from adminEventsReceivedTotal above (which counts
  // messages the admin-stream subscriber consumes FROM NATS, not
  // messages handed to this process TO publish).
  internalEventsPublishedTotal: 0,
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

// Shared by both attachPriceStream and attachTradingEventStream's upgrade
// handlers -- tries the `ticket` query param first (see
// getTraderSessionByTicket's own comment: the only option for a browser
// WS handshake on a broker's own custom domain, which never carries this
// Gateway's session cookie at all), falling back to the cookie-based
// lookup every existing client (any *.vyxtrader.com subdomain, which CAN
// share that cookie) still relies on. Cheap either way -- a subdomain
// client that also happens to send a ticket just resolves off that
// instead, no double lookup.
async function resolveTraderSession(req: IncomingMessage): Promise<import("./auth.js").AccountSessionPayload | null> {
  const { searchParams } = new URL(req.url ?? "", "http://internal");
  const ticket = searchParams.get("ticket");
  if (ticket) {
    const byTicket = await getTraderSessionByTicket(ticket);
    if (byTicket) return byTicket;
  }
  return getTraderSession(req.headers.cookie);
}

export async function attachPriceStream(server: Server, natsUrl: string): Promise<void> {
  const nc: NatsConnection = await connect({ servers: natsUrl, reconnect: true, maxReconnectAttempts: -1 });
  logNatsConnectionLoss("price stream", nc);
  const sub = nc.subscribe("price.tick.*");

  const wss = new WebSocketServer({ noServer: true });
  // ws -> that connection's own broker id, so a forwarded tick can be
  // checked against that specific broker's enabled-symbol set (see
  // getEnabledSymbolsHot above) -- was a bare Set<WebSocket> before
  // the per-tenant filtering this map exists for.
  const clients = new Map<WebSocket, string>();

  function registerClient(ws: WebSocket, brokerId: string) {
    clients.set(ws, brokerId);
    gatewayStats.wsConnectionsTotal += 1;
    // Pre-warm this broker's enabled-symbol set off the hot path, so the
    // first ticks after a connection are filtered against the real set
    // rather than skipped while a lazy load happens.
    void refreshSymbolFilter(brokerId);
    // hotfix/terminal-live-bugs #3 -- app-level ping/pong so the client can
    // measure real RTT to this gateway over the connection it already has
    // for ticks, instead of timing an unrelated HTTP request to Vercel
    // (which was being mislabeled "Ping" and included the Vercel function's
    // own cold-start/DB-roundtrip time, not network latency). The browser's
    // native WebSocket API never surfaces protocol-level ping/pong frames
    // to JS, so this has to be a plain echoed application message instead.
    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed?.type === "ping") ws.send(JSON.stringify({ type: "pong", t: parsed.t }));
      } catch {
        // not a ping frame -- this socket never expects anything else from
        // the client, so just ignore it
      }
    });
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

    resolveTraderSession(req)
      .then((session) => {
        if (session) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            registerClient(ws, session.brokerId);
          });
          return;
        }
        // Manager/Broker-Admin backoffice (PositionsManager.tsx's live
        // exposure P/L) has no trader session cookie at all -- fall back
        // to an admin session before rejecting. Still broker-agnostic
        // public market data either way (this function's own module
        // comment), just a second valid way to prove "this is a logged-in
        // session," same reasoning attachAdminEventStream already applies
        // to its own stream.
        return getAdminSession(req.headers.cookie).then((adminSession) => {
          if (!adminSession || !adminSession.brokerId) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            registerClient(ws, adminSession.brokerId!);
          });
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
  // One pass over one tick. Entirely synchronous and fully guarded: nothing
  // in here can reject, so nothing in here can end the subscription.
  function fanOutTick(text: string, symbol: string): void {
    for (const [client, brokerId] of clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // In-memory only. Unknown broker (nothing cached yet) = forward
      // nothing for it this tick; the refresh it just scheduled means the
      // next tick has the real set. Failing OPEN here would leak another
      // broker's symbols, so the closed direction is the safe one.
      const enabled = getEnabledSymbolsHot(brokerId);
      if (!enabled || !enabled.has(symbol)) continue;
      try {
        client.send(text);
        gatewayStats.ticksForwardedTotal += 1;
        gatewayStats.lastTickForwardedAtMs = Date.now();
      } catch (err) {
        // A single bad socket must not cost every other client its tick.
        console.error("price stream: send failed for one client, dropping it", err);
        try { client.terminate(); } catch { /* already gone */ }
        clients.delete(client);
      }
    }
  }

  // The subscription runs under a supervisor. Any exit -- a thrown error, or
  // the iterator simply completing because NATS tore the subscription down --
  // resubscribes with backoff instead of leaving the feed dark forever.
  let currentSub = sub;
  let stopped = false;
  let consecutiveFailures = 0;

  async function runSubscription(): Promise<void> {
    for await (const msg of currentSub) {
      gatewayStats.natsMessagesReceivedTotal += 1;
      gatewayStats.lastNatsMessageAtMs = Date.now();
      // Per-message guard: one malformed payload, one bad client, one
      // anything cannot end the loop.
      try {
        const text = Buffer.from(msg.data).toString("utf-8");
        let symbol: string | undefined;
        try {
          symbol = JSON.parse(text)?.symbol;
        } catch {
          continue; // malformed tick -- nothing to filter or forward
        }
        if (!symbol) continue;
        fanOutTick(text, symbol);
      } catch (err) {
        console.error("price stream: failed to handle one tick (skipping it, subscription stays up)", err);
      }
    }
  }

  async function superviseSubscription(): Promise<void> {
    while (!stopped) {
      try {
        await runSubscription();
        // Clean exit still means no more ticks -- treat it as a failure.
        console.error("price stream: NATS subscription ended cleanly, resubscribing");
      } catch (err) {
        console.error("price stream: NATS subscription loop ended", err);
      }
      if (stopped) break;

      const wait = Math.min(1000 * 2 ** Math.min(consecutiveFailures, 4), 15_000);
      consecutiveFailures += 1;
      gatewayStats.priceSubscriptionRestartsTotal += 1;
      console.error(`price stream: resubscribing to price.tick.* in ${wait}ms (restart #${gatewayStats.priceSubscriptionRestartsTotal})`);
      await new Promise((r) => setTimeout(r, wait));
      try {
        currentSub = nc.subscribe("price.tick.*");
        consecutiveFailures = 0;
        console.error("price stream: resubscribed to price.tick.*");
      } catch (err) {
        console.error("price stream: resubscribe failed, will retry", err);
      }
    }
  }

  void superviseSubscription();

  // Watchdog: NATS is delivering but nothing has gone out to anyone for
  // WATCHDOG_STALL_MS while clients are connected. That is the signature of
  // a fan-out that has stopped doing its job, and it is exactly the state
  // that previously went unnoticed until a trader complained. Force a
  // resubscribe rather than only logging.
  const WATCHDOG_INTERVAL_MS = 15_000;
  const WATCHDOG_STALL_MS = 30_000;
  const watchdog = setInterval(() => {
    if (clients.size === 0) return;
    const now = Date.now();
    const natsRecent = now - gatewayStats.lastNatsMessageAtMs < WATCHDOG_STALL_MS;
    const forwardedStale = now - gatewayStats.lastTickForwardedAtMs > WATCHDOG_STALL_MS;
    if (natsRecent && forwardedStale) {
      console.error(
        `[ALERT] price stream: ${clients.size} client(s) connected and NATS is delivering, but no tick has been forwarded for ` +
          `${Math.round((now - gatewayStats.lastTickForwardedAtMs) / 1000)}s. Forcing a resubscribe.`
      );
      try { currentSub.unsubscribe(); } catch { /* the supervisor picks it up either way */ }
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();
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
  const nc: NatsConnection = await connect({ servers: natsUrl, reconnect: true, maxReconnectAttempts: -1 });
  logNatsConnectionLoss("trading event stream", nc);
  // "alert.>" added Phase 1 trust pack §3 -- engine/server publishes
  // alert.triggered with the same account_id field every other subject
  // here already carries, so the forwarding loop below needs no change
  // at all, just this one more subscription.
  const subs = [nc.subscribe("order.>"), nc.subscribe("margin.>"), nc.subscribe("position.>"), nc.subscribe("alert.>")];

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

    resolveTraderSession(req)
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
  const nc: NatsConnection = await connect({ servers: natsUrl, reconnect: true, maxReconnectAttempts: -1 });
  logNatsConnectionLoss("admin event stream", nc);
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
    const url = new URL(req.url ?? "", "http://internal");
    if (url.pathname !== ADMIN_EVENTS_STREAM_PATH) return;

    // Headless-service auth path (vyx-mt5-copier and similar) -- a browser
    // WebSocket can only ride cookies, but a server-side client (Node,
    // Python's `websockets`) can set arbitrary headers same as any HTTP
    // request, so this reuses the exact shared-secret convention already
    // established for /internal/events and /internal/gateway-stats
    // (index.ts) rather than provisioning a real admin login + session
    // cookie-jar for a bot. brokerId comes from the query string (there's
    // no session to read it from); only checked against the secret, never
    // trusted from the cookie path below, so a caller can never widen its
    // own access by also sending a stale/mismatched cookie.
    const internalSecretHeader = req.headers["x-internal-secret"];
    const providedSecret = Array.isArray(internalSecretHeader) ? internalSecretHeader[0] : internalSecretHeader;
    const expectedSecret = process.env.INTERNAL_SERVICE_SECRET ?? "";
    if (expectedSecret && providedSecret === expectedSecret) {
      const brokerId = url.searchParams.get("brokerId");
      if (!brokerId) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        registerClient(ws, brokerId);
      });
      return;
    }

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
