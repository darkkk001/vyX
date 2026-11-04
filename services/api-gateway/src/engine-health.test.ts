// PRIORITY 1 (FAILOVER): the gateway's engine-health probe, over a real socket.
//
// This is the endpoint the web guard asks before it forwards an order, so the property that matters is
// not "it returns 200 when the engine is up" but the other one: EVERY way of not being up must come
// back as 503. A probe that answered 200 on a timeout would send orders at a dead engine and hand the
// trader exactly the failure this whole priority exists to remove.
//
// The router is mounted on a real express app on an ephemeral port and the calls are real HTTP, so the
// route's own wiring (path, method, mount prefix) is covered too -- a test that called the handler
// directly would pass even if the route were never registered.

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";

import ordersRouter from "./routes/orders.js";

const realFetch = globalThis.fetch;

async function withServer(fn: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use("/v1/orders", ordersRouter);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Answers the engine's /health however the test wants, and refuses everything else.
 *
 * It HONOURS THE ABORT SIGNAL, as real fetch does. Without that the "never answers" case below would
 * hang the test rather than exercise the probe's deadline -- the deadline works by aborting, and a stub
 * that ignores the abort proves nothing about it.
 */
function stubEngine(reply: () => Promise<Response> | Response) {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.endsWith("/health")) return realFetch(url as string, init);
    const signal = init?.signal;
    if (!signal) return reply();
    return Promise.race([
      Promise.resolve(reply()),
      new Promise<never>((_, reject) => {
        const fail = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      }),
    ]);
  }) as typeof fetch;
}

test("an engine that answers /health is reported up", async () => {
  await withServer(async (base) => {
    stubEngine(() => new Response("ok", { status: 200 }));
    const res = await realFetch(`${base}/v1/orders/engine-health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("an engine that is unreachable is reported DOWN, not up", async () => {
  await withServer(async (base) => {
    stubEngine(() => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const res = await realFetch(`${base}/v1/orders/engine-health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false });
  });
});

test("an engine answering 500 is reported DOWN", async () => {
  await withServer(async (base) => {
    stubEngine(() => new Response("boom", { status: 500 }));
    const res = await realFetch(`${base}/v1/orders/engine-health`);
    assert.equal(res.status, 503);
  });
});

// The one that would otherwise be missed. A hung engine does not refuse the connection -- it accepts
// it and says nothing. Without the probe's own deadline this request would hang for as long as the
// socket stayed open, and the guard would be blocked on a health check instead of filling the order.
test("an engine that accepts the connection and never answers is reported DOWN, within the deadline", async () => {
  await withServer(async (base) => {
    stubEngine(
      () =>
        new Promise<Response>(() => {
          /* never settles */
        })
    );
    const startedAt = Date.now();
    const res = await realFetch(`${base}/v1/orders/engine-health`);
    const elapsed = Date.now() - startedAt;
    assert.equal(res.status, 503);
    assert.ok(elapsed < 3_000, `the probe has to give up on its own, took ${elapsed} ms`);
  });
});

// Not strictly about health, but it is the reason this endpoint can be unauthenticated: it says one
// boolean and nothing else. The engine's commit header, its mode, its scope -- none of it leaks.
test("the answer carries nothing but the boolean", async () => {
  await withServer(async (base) => {
    stubEngine(() => new Response("ok", { status: 200, headers: { "x-commit": "deadbeef" } }));
    const res = await realFetch(`${base}/v1/orders/engine-health`);
    assert.deepEqual(Object.keys((await res.json()) as object), ["ok"]);
    assert.equal(res.headers.get("x-commit"), null);
  });
});
