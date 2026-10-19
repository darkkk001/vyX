// Local stand-in for engine/server's two routes the feed calls, for testing without touching any real engine:
//   GET  /internal/time        -> {"server_utc_ms": now}
//   POST /internal/price-feed  -> checks x-price-feed-secret and the body against protocol::Tick's shape
//                                 (single object or array; symbol string; bid/ask numbers; optional integer
//                                 t0/tick_ms/broker_offset_sec/clock_offset_ms/rtt_ms; no unknown fields the
//                                 engine would ignore silently), answers {"ok":true,"count":n} like the engine.
//   GET  /stats                -> what it has accepted so far
// Usage: MOCK_SECRET=... MOCK_PORT=8091 node tools/mock-engine.ts  (counts are printed every 60s and on exit)

import http from "node:http";

const port = Number(process.env.MOCK_PORT ?? 8091);
const secret = process.env.MOCK_SECRET ?? "";
if (!secret) throw new Error("MOCK_SECRET is not set");

const KNOWN = new Set(["symbol", "bid", "ask", "t0", "tick_ms", "broker_offset_sec", "clock_offset_ms", "rtt_ms", "bars"]);
const INTS = ["t0", "tick_ms", "broker_offset_sec", "clock_offset_ms", "rtt_ms"];
const counts = new Map<string, number>();
let requests = 0, rejected = 0;
const problems = new Map<string, number>();

function check(t: Record<string, unknown>): string | null {
  for (const k of Object.keys(t)) if (!KNOWN.has(k)) return `unknown field ${k}`;
  if (typeof t.symbol !== "string" || !t.symbol) return "symbol missing";
  if (typeof t.bid !== "number" || typeof t.ask !== "number") return "bid/ask not numbers";
  if (!(t.bid > 0 && t.ask > 0)) return "bid/ask not positive";
  for (const k of INTS) if (k in t && !Number.isInteger(t[k])) return `${k} not an integer`;
  if (typeof t.tick_ms === "number" && Math.abs(Date.now() - t.tick_ms) > 120_000) return "tick_ms more than 120s from now";
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/internal/time") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ server_utc_ms: Date.now() }));
    return;
  }
  if (req.method === "GET" && req.url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" }).end(report());
    return;
  }
  if (req.method !== "POST" || req.url !== "/internal/price-feed") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    requests++;
    if (req.headers["x-price-feed-secret"] !== secret) {
      rejected++;
      res.writeHead(401).end("unauthorized");
      return;
    }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { rejected++; res.writeHead(400).end("bad json"); return; }
    const ticks = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
    for (const t of ticks) {
      const p = check(t);
      if (p) problems.set(p, (problems.get(p) ?? 0) + 1);
      else counts.set(t.symbol as string, (counts.get(t.symbol as string) ?? 0) + 1);
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, count: ticks.length }));
  });
});

function report(): string {
  return JSON.stringify({ requests, rejected, ticksBySymbol: Object.fromEntries(counts), problems: Object.fromEntries(problems) });
}

server.listen(port, "127.0.0.1", () => console.log(`mock engine on http://127.0.0.1:${port}`));
setInterval(() => console.log(`${new Date().toISOString()} ${report()}`), 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { console.log(`final ${report()}`); process.exit(0); });
