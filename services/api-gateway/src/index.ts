// API Gateway — the TypeScript service in front of the Rust Trading Core,
// per docs/architecture.md §3/§4 and docs/api.md §2. Standalone service,
// own package.json/deploy target (docs/deployment.md §2 — host not
// decided yet). Does not replace or modify any existing Next.js route;
// the current app/api/trade/* path keeps serving traffic unmodified per
// ADR-003 until a broker is explicitly cut over.

import { createServer } from "node:http";
import express from "express";
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
// Phase 1 trust pack §2 -- reads the same Redis-backed admin_session:
// {token} key lib/auth.ts writes (services/api-gateway/src/admin-auth.ts),
// not a JWT (ADMIN_SESSION_SECRET, previously required here, is gone --
// see .env.example's own updated comment). REDIS_URL just needs to point
// at the same Redis instance the root app uses.
attachAdminEventStream(server, natsUrl).catch((err) => {
  console.error("failed to start admin event stream (NATS unreachable?)", err);
});

server.listen(port, bindAddr, () => {
  console.log(`api-gateway listening on ${bindAddr}:${port}`);
});
