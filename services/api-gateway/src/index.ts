// API Gateway — the TypeScript service in front of the Rust Trading Core,
// per docs/architecture.md §3/§4 and docs/api.md §2. Standalone service,
// own package.json/deploy target (docs/deployment.md §2 — host not
// decided yet). Does not replace or modify any existing Next.js route;
// the current app/api/trade/* path keeps serving traffic unmodified per
// ADR-003 until a broker is explicitly cut over.

import express from "express";
import ordersRouter from "./routes/orders.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/v1/orders", ordersRouter);

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`api-gateway listening on :${port}`);
});
