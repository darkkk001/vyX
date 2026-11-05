import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { corsMiddleware, normalizeOrigin, parseAllowedOrigins } from "./cors.js";
import { clientIpFrom, edgeRateLimit, parseEdgeLimit } from "./edge-rate-limit.js";

const PWA = "https://app.qoretrader.com";
const EVIL = "https://evil.example.com";

// A real Express app on a real socket, wired in the same order as index.ts: Express's automatic
// OPTIONS answer and the header order can only be proven this way, not by calling the function.
async function withApp(
  limit: number,
  run: (base: string) => Promise<void>,
  extraOrigins?: string
): Promise<void> {
  const app = express();
  app.use(corsMiddleware(parseAllowedOrigins(extraOrigins)));
  app.use(edgeRateLimit(limit));
  app.use(express.json());
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/v1/orders/market", (req, res) => {
    if (!req.headers.authorization && !req.headers.cookie) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.status(200).json({ auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
  });
  app.get("/internal/gateway-stats", (_req, res) => {
    res.json({ ok: true });
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function preflight(base: string, path: string, origin: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type, x-broker-id",
    },
  });
}

test("preflight from the PWA origin: 204 and exactly the agreed headers", async () => {
  await withApp(0, async (base) => {
    const res = await preflight(base, "/v1/orders/market", PWA);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), PWA);
    assert.equal(res.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    assert.equal(
      res.headers.get("access-control-allow-headers"),
      "content-type, authorization, x-broker-id, idempotency-key"
    );
    assert.equal(res.headers.get("access-control-max-age"), "600");
    assert.match(res.headers.get("vary") ?? "", /origin/i);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
    assert.equal(res.headers.get("allow"), null, "Express's automatic OPTIONS answer must not run");
  });
});

test("preflight from a wrong origin: no Access-Control header of any kind, Vary still set", async () => {
  await withApp(0, async (base) => {
    const res = await preflight(base, "/v1/orders/market", EVIL);
    assert.equal(res.status, 204);
    for (const name of ["origin", "methods", "headers"]) {
      assert.equal(res.headers.get(`access-control-allow-${name}`), null);
    }
    assert.equal(res.headers.get("access-control-max-age"), null);
    assert.match(res.headers.get("vary") ?? "", /origin/i);
  });
});

test("a real Bearer POST from the PWA gets the origin echoed, not *, and no credentials header", async () => {
  await withApp(0, async (base) => {
    const res = await fetch(`${base}/v1/orders/market`, {
      method: "POST",
      headers: { origin: PWA, authorization: "Bearer abc", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), PWA);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
    assert.equal(((await res.json()) as { auth: string }).auth, "Bearer abc");
  });
});

test("a refusal is readable by the PWA: a 401 still carries the origin", async () => {
  await withApp(0, async (base) => {
    const res = await fetch(`${base}/v1/orders/market`, { method: "POST", headers: { origin: PWA } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("access-control-allow-origin"), PWA);
  });
});

test("the cookie path is unchanged: no Origin means no CORS header, and the cookie reaches the route", async () => {
  await withApp(0, async (base) => {
    const res = await fetch(`${base}/v1/orders/market`, {
      method: "POST",
      headers: { cookie: "vyx_trade_session=abc", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(((await res.json()) as { cookie: string }).cookie, "vyx_trade_session=abc");
  });
});

test("/internal/* never gets CORS, even from an allowed origin; OPTIONS there is still a bare 204", async () => {
  await withApp(0, async (base) => {
    const get = await fetch(`${base}/internal/gateway-stats`, { headers: { origin: PWA } });
    assert.equal(get.headers.get("access-control-allow-origin"), null);
    const pre = await preflight(base, "/internal/gateway-stats", PWA);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), null);
    assert.equal(pre.headers.get("allow"), null);
  });
});

test("a per-broker origin from GATEWAY_CORS_ORIGINS is allowed; a near miss is not", async () => {
  await withApp(
    0,
    async (base) => {
      const ok = await preflight(base, "/v1/orders/market", "https://trade.broker.example");
      assert.equal(ok.headers.get("access-control-allow-origin"), "https://trade.broker.example");
      for (const bad of ["http://app.qoretrader.com", "https://app.qoretrader.com.evil.example", "null"]) {
        const res = await preflight(base, "/v1/orders/market", bad);
        assert.equal(res.headers.get("access-control-allow-origin"), null, bad);
      }
    },
    "https://trade.broker.example"
  );
});

test("the allow-list can never contain a wildcard or a non-https origin", () => {
  const allowed = parseAllowedOrigins("*, https://*.example.com, http://plain.example, https://ok.example/path, https://Good.Example");
  assert.deepEqual([...allowed].sort(), ["https://app.qoretrader.com", "https://good.example"]);
  assert.equal(normalizeOrigin("https://a.example:8443"), "https://a.example:8443");
  assert.equal(normalizeOrigin("https://user:pw@a.example"), null);
});

test("edge limit: off by default, and only a positive whole number turns it on", () => {
  for (const raw of [undefined, "", "0", "-5", "1.5", "abc"]) assert.equal(parseEdgeLimit(raw), 0);
  assert.equal(parseEdgeLimit(" 300 "), 300);
});

test("edge limit keys on the last X-Forwarded-For entry, which a client cannot forge", () => {
  assert.equal(clientIpFrom("1.1.1.1, 203.0.113.9"), "203.0.113.9");
  assert.equal(clientIpFrom(undefined), null);
});

test("edge limit: 429 past the limit, readable cross-origin, loopback exempt, preflight never counted", async () => {
  await withApp(2, async (base) => {
    const hit = (ip?: string) =>
      fetch(`${base}/v1/orders/market`, {
        method: "POST",
        headers: { origin: PWA, ...(ip ? { "x-forwarded-for": ip } : {}) },
      });
    for (let i = 0; i < 5; i += 1) await preflight(base, "/v1/orders/market", PWA);
    assert.equal((await hit("198.51.100.7")).status, 401);
    assert.equal((await hit("198.51.100.7")).status, 401);
    const limited = await hit("198.51.100.7");
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(limited.headers.get("access-control-allow-origin"), PWA);
    assert.equal((await hit("198.51.100.8")).status, 401, "another client has its own budget");
    for (let i = 0; i < 5; i += 1) assert.equal((await hit()).status, 401, "no X-Forwarded-For is never limited");
  });
});
