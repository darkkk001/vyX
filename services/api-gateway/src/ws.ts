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

const PRICE_STREAM_PATH = "/v1/prices/stream";

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
};

export async function attachPriceStream(server: Server, natsUrl: string): Promise<void> {
  const nc: NatsConnection = await connect({ servers: natsUrl });
  const sub = nc.subscribe("price.tick.*");

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    gatewayStats.wsConnectionsTotal += 1;
    ws.on("close", () => {
      clients.delete(ws);
      gatewayStats.wsDisconnectionsTotal += 1;
    });
    ws.on("error", () => {
      clients.delete(ws);
      gatewayStats.wsDisconnectionsTotal += 1;
    });
  });

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
          wss.emit("connection", ws, req);
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
  (async () => {
    for await (const msg of sub) {
      gatewayStats.natsMessagesReceivedTotal += 1;
      const text = Buffer.from(msg.data).toString("utf-8");
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(text);
          gatewayStats.ticksForwardedTotal += 1;
        }
      }
    }
  })().catch((err) => {
    console.error("price stream: NATS subscription loop ended", err);
  });
}
