// Stage 4.5 parity harness -- serves the web's REAL post-close route (app/api/internal/post-close) on
// 127.0.0.1 against the scratch harness DB, so the engine's DB mode (`cargo run -p parity -- --db`) can drain its
// outbox through the real dispatcher (order_management::outbox) into the real route: bearer check, lease, steps.
// scripts/parity/run-db.sh starts it and points VYX_POST_CLOSE_URL / VYX_POST_CLOSE_SECRET at it.
//
// Same safety as run-ts.ts: refuses anything but the scratch DB, pins every outbound path local, blocks fetch.
import http from "node:http";

const HARNESS_URL = "postgresql://postgres@127.0.0.1:5499/vyx_rust_harness";
for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
  if (process.env[name] !== HARNESS_URL) {
    console.error(`[post-close-server] refusing to run: ${name} must be exactly ${HARNESS_URL}.`);
    process.exit(2);
  }
}
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
  if (where.db !== "vyx_rust_harness" || Number(where.port) !== 5499) {
    throw new Error(`[post-close-server] connected to ${where.db}:${where.port}, expected vyx_rust_harness:5499`);
  }
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/internal/post-close/route");

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const response = await POST(new NextRequest(`http://127.0.0.1:${port}/api/internal/post-close`, { method: req.method, headers, body: Buffer.concat(chunks) }));
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
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
