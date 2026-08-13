// API Gateway — the TypeScript service in front of the Rust Trading Core,
// per docs/architecture.md §3/§4 and docs/api.md §2. Standalone service,
// own package.json/deploy target (docs/deployment.md §2 — host not
// decided yet). Does not replace or modify any existing Next.js route;
// the current app/api/trade/* path keeps serving traffic unmodified per
// ADR-003 until a broker is explicitly cut over.

import { createServer } from "node:http";
import express from "express";
import ordersRouter from "./routes/orders.js";
import { attachPriceStream } from "./ws.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/v1/orders", ordersRouter);

// A plain http.Server (not app.listen's implicit one) so the WebSocket
// price stream (src/ws.ts) can hook the server's "upgrade" event
// alongside Express handling normal HTTP requests on the same port.
const server = createServer(app);

const port = Number(process.env.PORT ?? 8080);
const natsUrl = process.env.NATS_URL ?? "nats://127.0.0.1:4222";

attachPriceStream(server, natsUrl).catch((err) => {
  console.error("failed to start price stream (NATS unreachable?)", err);
});

server.listen(port, () => {
  console.log(`api-gateway listening on :${port}`);
});
