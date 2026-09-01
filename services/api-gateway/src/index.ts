// API Gateway — the TypeScript service in front of the Rust Trading Core,
// per docs/architecture.md §3/§4 and docs/api.md §2. Standalone service,
// own package.json/deploy target (docs/deployment.md §2 — host not
// decided yet). Does not replace or modify any existing Next.js route;
// the current app/api/trade/* path keeps serving traffic unmodified per
// ADR-003 until a broker is explicitly cut over.

import { createServer } from "node:http";
import express from "express";
import { connect, StringCodec, type NatsConnection } from "nats";
import ordersRouter from "./routes/orders.js";
import positionsRouter from "./routes/positions.js";
import { attachPriceStream, attachTradingEventStream, attachAdminEventStream, gatewayStats, orderAckStats } from "./ws.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Phase 4 of the tick-pipeline audit -- same shared-secret convention as
// engine/server's /internal/feed-stats, read by the Manager Feed Health
// page (app/manage/(shell)/feed-health).
app.get("/internal/gateway-stats", (req, res) => {
  const provided = req.headers["x-internal-secret"];
  if (provided !== (process.env.INTERNAL_SERVICE_SECRET ?? "")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json({ ...gatewayStats, ...orderAckStats() });
});

// Publish relay for the legacy Vercel-hosted Next.js trade routes
// (lib/nats.ts's publishTradingEvent) -- Vercel serverless functions have
// no working path to this box's NATS instance (confirmed: NATS_URL was
// never even set in the Vercel env, so every direct-publish attempt fell
// back to nats://127.0.0.1:4222 inside an ephemeral container and
// silently failed from day one -- the entire reason the backoffice
// dealing queue/positions/exposure views needed a manual refresh in
// production). This process already has a real NATS connection and
// already owns every subscriber that matters (attachTradingEventStream,
// attachAdminEventStream) -- Vercel just needs a way to hand it a
// message over plain HTTPS, which it can already reach (the WebSocket
// relay itself proves connectivity). Same shared-secret convention as
// /internal/gateway-stats above.
let internalEventsNc: Promise<NatsConnection> | null = null;
const internalEventsSc = StringCodec();

function getInternalEventsConnection(): Promise<NatsConnection> {
  if (!internalEventsNc) {
    internalEventsNc = connect({ servers: natsUrl }).catch((err) => {
      internalEventsNc = null; // let the next publish attempt retry a fresh connection
      throw err;
    });
  }
  return internalEventsNc;
}

app.post("/internal/events", async (req, res) => {
  const provided = req.headers["x-internal-secret"];
  if (provided !== (process.env.INTERNAL_SERVICE_SECRET ?? "")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { subject, payload } = req.body ?? {};
  if (typeof subject !== "string" || !subject || typeof payload !== "object" || payload === null) {
    res.status(400).json({ error: "subject (string) and payload (object) are required" });
    return;
  }
  try {
    const nc = await getInternalEventsConnection();
    nc.publish(subject, internalEventsSc.encode(JSON.stringify(payload)));
    gatewayStats.internalEventsPublishedTotal += 1;
    res.status(202).json({ ok: true });
  } catch (err) {
    console.error("POST /internal/events: failed to publish (NATS unreachable?)", err);
    res.status(502).json({ error: "failed to publish to NATS" });
  }
});

app.use("/v1/orders", ordersRouter);
app.use("/v1/positions", positionsRouter);

// A plain http.Server (not app.listen's implicit one) so the WebSocket
// price stream (src/ws.ts) can hook the server's "upgrade" event
// alongside Express handling normal HTTP requests on the same port.
const server = createServer(app);

const port = Number(process.env.PORT ?? 8080);
const natsUrl = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
// Defaults to loopback-only, same reasoning and same Contabo audit
// (2026-08-29) as engine/server's own BIND_ADDR -- this was only ever
// meant to be reached via a local Caddy reverse proxy (feed.vyxtrader.com),
// not directly from the internet. server.listen(port) alone binds all
// interfaces by default; still overridable (BIND_ADDR=0.0.0.0) for a
// deployment shape that genuinely needs it.
const bindAddr = process.env.BIND_ADDR ?? "127.0.0.1";

attachPriceStream(server, natsUrl).catch((err) => {
  console.error("failed to start price stream (NATS unreachable?)", err);
});
attachTradingEventStream(server, natsUrl).catch((err) => {
  console.error("failed to start trading event stream (NATS unreachable?)", err);
});
// fix/realtime-sync §1 -- new env var this process now needs:
// ADMIN_SESSION_SECRET, the exact same value Vercel/Next.js signs
// vyx_admin_session with (lib/auth.ts). Not required to start the
// gateway itself (only checked lazily on the first admin-stream
// connection attempt, same as REDIS_URL's own getRedis()), but every
// backoffice event-stream connection 401s until it's set.
attachAdminEventStream(server, natsUrl).catch((err) => {
  console.error("failed to start admin event stream (NATS unreachable?)", err);
});

server.listen(port, bindAddr, () => {
  console.log(`api-gateway listening on ${bindAddr}:${port}`);
});
