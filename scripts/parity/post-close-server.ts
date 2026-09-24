// Stage 4.5 parity harness -- serves the web's REAL post-close route (app/api/internal/post-close) on
// 127.0.0.1 against the scratch harness DB, so the engine's DB mode (`cargo run -p parity -- --db`) can drain its
// outbox through the real dispatcher (order_management::outbox) into the real route: bearer check, lease, steps.
// scripts/parity/run-db.sh starts it and points VYX_POST_CLOSE_URL / VYX_POST_CLOSE_SECRET at it.
//
// Same safety as run-ts.ts: refuses anything but the scratch DB, pins every outbound path local, blocks fetch.
import http from "node:http";

// the parity harness DB, or the Stage 4 load harness's engine DB (scripts/load/run.sh) -- nothing else
const ALLOWED = ["postgresql://postgres@127.0.0.1:5499/vyx_rust_harness", "postgresql://postgres@127.0.0.1:5499/vyx_load_engine"];
const DB_URL = process.env.DATABASE_URL ?? "";
if (!ALLOWED.includes(DB_URL) || process.env.DIRECT_URL !== DB_URL) {
  console.error(`[post-close-server] refusing to run: DATABASE_URL and DIRECT_URL must both be one of ${ALLOWED.join(", ")}.`);
  process.exit(2);
}
const DB_NAME = DB_URL.slice(DB_URL.lastIndexOf("/") + 1);
if (!process.env.POST_CLOSE_SECRET) {
  console.error("[post-close-server] POST_CLOSE_SECRET is required");
  process.exit(2);
}
process.env.MARKET_DATA_PRICES = "";
process.env.MARKET_DATA_URL = "";
process.env.TRADING_CORE_URL = "";
process.env.GATEWAY_URL = "http://127.0.0.1:9";
process.env.INTERNAL_SERVICE_SECRET = "";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1:9/internal/events")) return new Response(null, { status: 204 });
  throw new Error(`[post-close-server] unexpected outbound fetch blocked: ${url}`);
}) as typeof fetch;

const port = Number(process.env.PARITY_POST_CLOSE_PORT ?? 5591);

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const [where] = await prisma.$queryRaw<{ db: string; port: number }[]>`SELECT current_database() AS db, inet_server_port() AS port`;
  if (where.db !== DB_NAME || Number(where.port) !== 5499) {
    throw new Error(`[post-close-server] connected to ${where.db}:${where.port}, expected ${DB_NAME}:5499`);
  }
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/internal/post-close/route");

  // Stage 4.6 measurement (PARITY_POST_CLOSE_TIMING=<file>): every runner phase, and the whole handler per request,
  // summed into <file> after each request (the process is stopped by force, so it never gets an exit hook)
  const timingFile = process.env.PARITY_POST_CLOSE_TIMING;
  const stats: Record<string, { n: number; sumMs: number; maxMs: number }> = {};
  const add = (phase: string, ms: number) => {
    const s = (stats[phase] ??= { n: 0, sumMs: 0, maxMs: 0 });
    s.n++;
    s.sumMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
  };
  if (timingFile) {
    const { setPostCloseTiming } = await import("@/lib/post-close");
    setPostCloseTiming(add);
  }
  const fs = await import("node:fs");

  // Stage 4.6 fault gate (harness only):
  // - PARITY_POST_CLOSE_FAIL_EVERY=N: every N-th row fails ONCE at "before:coverage" (a failed run: the dispatcher
  //   counts one attempt, its group stops, the row is retried after its backoff);
  // - PARITY_POST_CLOSE_DROP_EVERY=N: every N-th request is processed and then its answer is dropped (the dispatcher
  //   gets no answer and must not redo what already ran).
  const failEvery = Number(process.env.PARITY_POST_CLOSE_FAIL_EVERY ?? 0);
  const dropEvery = Number(process.env.PARITY_POST_CLOSE_DROP_EVERY ?? 0);
  let requests = 0;
  if (failEvery > 0) {
    const { setPostCloseFault } = await import("@/lib/post-close");
    let seenRows = 0;
    const doomed = new Set<string>();
    const failedOnce = new Set<string>();
    const counted = new Set<string>();
    setPostCloseFault((rowId, point) => {
      if (point !== "before:cancel_pending_close" && point !== "before:notify_margin_call") {
        if (point === "before:coverage" && doomed.has(rowId) && !failedOnce.has(rowId)) {
          failedOnce.add(rowId);
          throw new Error("injected failure (harness)");
        }
        return;
      }
      if (!counted.has(rowId)) {
        counted.add(rowId);
        if (++seenRows % failEvery === 0) doomed.add(rowId);
      }
    });
  }

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const t0 = performance.now();
      const response = await POST(new NextRequest(`http://127.0.0.1:${port}/api/internal/post-close`, { method: req.method, headers, body: Buffer.concat(chunks) }));
      const text = await response.text();
      if (dropEvery > 0 && ++requests % dropEvery === 0) {
        req.socket.destroy(); // the work is done, the answer is lost
        return;
      }
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(text);
      if (timingFile) {
        add("handler", performance.now() - t0);
        fs.writeFileSync(timingFile, JSON.stringify(stats, null, 1));
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: String(err) }));
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`[post-close-server] listening on 127.0.0.1:${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
