// L2 Step 5 -- the engine ingress is fail-closed, proved rather than asserted in a comment.
//
// This guard sits in POST /api/trade/orders, the route every real order goes through, so the property
// that matters is not "the designated account diverts" but "NOTHING ELSE DOES, under every
// misconfiguration". An unset variable, a blank one, a list without a URL, a URL without a list: all
// of them must leave every order on the existing path.
//
// The module reads its environment once at import, which is what production does, so each case
// re-imports with a fresh module registry rather than mutating state the module has already read.

import { afterEach, describe, expect, it, vi } from "vitest";

// the request the route is serving: a cookie jar and the headers, set per test
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined, authorization: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "vyx_trade_session" && jar.cookie !== undefined ? { value: jar.cookie } : undefined) }),
  headers: async () => ({ get: (n: string) => (n.toLowerCase() === "authorization" ? jar.authorization : null) }),
}));

const DEMO = "cmvzzzovp000nl208tujjh7l4"; // Futurix DEMO 50005725
const OTHER = "cmv1someotheraccountid00";

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("./engine-ingress");
}

afterEach(() => {
  jar.cookie = undefined;
  jar.authorization = null;
  vi.unstubAllGlobals();
  delete process.env.ENGINE_INGRESS_ACCOUNT_IDS;
  delete process.env.ENGINE_INGRESS_GATEWAY_URL;
  vi.resetModules();
});

describe("engineFillsFor is fail-closed", () => {
  it("diverts nothing when nothing is configured", async () => {
    const { engineFillsFor, engineIngressScope } = await load({
      ENGINE_INGRESS_ACCOUNT_IDS: undefined,
      ENGINE_INGRESS_GATEWAY_URL: undefined,
    });
    expect(engineFillsFor(DEMO)).toBe(false);
    expect(engineFillsFor(OTHER)).toBe(false);
    expect(engineIngressScope()).toEqual({ enabled: false, accounts: 0 });
  });

  it("diverts nothing when the variables are blank", async () => {
    const { engineFillsFor } = await load({ ENGINE_INGRESS_ACCOUNT_IDS: "  ,  ", ENGINE_INGRESS_GATEWAY_URL: "   " });
    expect(engineFillsFor(DEMO)).toBe(false);
  });

  it("needs BOTH the list and the gateway URL", async () => {
    const listOnly = await load({ ENGINE_INGRESS_ACCOUNT_IDS: DEMO, ENGINE_INGRESS_GATEWAY_URL: undefined });
    expect(listOnly.engineFillsFor(DEMO)).toBe(false);

    const urlOnly = await load({ ENGINE_INGRESS_ACCOUNT_IDS: undefined, ENGINE_INGRESS_GATEWAY_URL: "https://feed.example" });
    expect(urlOnly.engineFillsFor(DEMO)).toBe(false);
  });

  it("diverts the designated account and nothing else", async () => {
    const { engineFillsFor, engineIngressScope } = await load({
      ENGINE_INGRESS_ACCOUNT_IDS: DEMO,
      ENGINE_INGRESS_GATEWAY_URL: "https://feed.example",
    });
    expect(engineFillsFor(DEMO)).toBe(true);
    expect(engineFillsFor(OTHER)).toBe(false);
    expect(engineFillsFor("")).toBe(false);
    // no prefix / suffix near-miss
    expect(engineFillsFor(DEMO + "x")).toBe(false);
    expect(engineFillsFor(DEMO.slice(0, -1))).toBe(false);
    expect(engineIngressScope()).toEqual({ enabled: true, accounts: 1 });
  });

  it("takes a list of several and still excludes everything else", async () => {
    const { engineFillsFor } = await load({
      ENGINE_INGRESS_ACCOUNT_IDS: ` ${DEMO} , second-id ,`,
      ENGINE_INGRESS_GATEWAY_URL: "https://feed.example",
    });
    expect(engineFillsFor(DEMO)).toBe(true);
    expect(engineFillsFor("second-id")).toBe(true);
    expect(engineFillsFor(OTHER)).toBe(false);
  });
});

describe("fillThroughEngine declines to divert what it should not", () => {
  it("returns null for a non-MARKET order, so the web path keeps LIMIT and STOP", async () => {
    const { fillThroughEngine } = await load({
      ENGINE_INGRESS_ACCOUNT_IDS: DEMO,
      ENGINE_INGRESS_GATEWAY_URL: "https://feed.example",
    });
    const session = { accountId: DEMO, brokerId: "b" };
    for (const type of ["LIMIT", "STOP", undefined, "", null]) {
      expect(await fillThroughEngine({ symbol: "XAUUSD", side: "BUY", volume: "0.01", type }, session)).toBeNull();
    }
  });

  it("returns null for a malformed body rather than forwarding it", async () => {
    const { fillThroughEngine } = await load({
      ENGINE_INGRESS_ACCOUNT_IDS: DEMO,
      ENGINE_INGRESS_GATEWAY_URL: "https://feed.example",
    });
    const session = { accountId: DEMO, brokerId: "b" };
    expect(await fillThroughEngine(null, session)).toBeNull();
    expect(await fillThroughEngine({ type: "MARKET", side: "BUY", volume: "0.01" }, session)).toBeNull();
    expect(await fillThroughEngine({ type: "MARKET", symbol: "XAUUSD", side: "WRONG", volume: "0.01" }, session)).toBeNull();
  });
});

describe("fillThroughEngine forwards the session from the cookie OR the bearer header", () => {
  const MARKET = { symbol: "XAUUSD", side: "BUY", volume: "0.01", type: "MARKET" };
  const session = { accountId: DEMO, brokerId: "b" };

  async function forwarded(): Promise<string | null> {
    const { fillThroughEngine } = await load({ ENGINE_INGRESS_ACCOUNT_IDS: DEMO, ENGINE_INGRESS_GATEWAY_URL: "https://feed.example" });
    let sent: string | null = null;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent = new Headers(init.headers).get("cookie");
      return new Response(null, { status: 403 }); // refused before writing: carry on, so the result is null
    });
    expect(await fillThroughEngine(MARKET, session)).toBeNull();
    return sent;
  }

  it("the QoreTrader app's bearer token reaches the gateway (it sends no cookie)", async () => {
    jar.authorization = "Bearer app-token";
    expect(await forwarded()).toBe("vyx_trade_session=app-token");
  });

  it("the terminal's cookie still reaches the gateway", async () => {
    jar.cookie = "cookie-token";
    expect(await forwarded()).toBe("vyx_trade_session=cookie-token");
  });

  it("an empty cookie does not hide the bearer header", async () => {
    jar.cookie = "";
    jar.authorization = "Bearer app-token";
    expect(await forwarded()).toBe("vyx_trade_session=app-token");
  });

  it("no token at all: nothing is sent and the web path carries on", async () => {
    const { fillThroughEngine } = await load({ ENGINE_INGRESS_ACCOUNT_IDS: DEMO, ENGINE_INGRESS_GATEWAY_URL: "https://feed.example" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await fillThroughEngine(MARKET, session)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("engineIngressGatewayHost", () => {
  it("is the host only, and empty when unset", async () => {
    expect((await load({ ENGINE_INGRESS_GATEWAY_URL: "https://feed.example/x?y=1" })).engineIngressGatewayHost()).toBe("feed.example");
    expect((await load({ ENGINE_INGRESS_GATEWAY_URL: undefined })).engineIngressGatewayHost()).toBe("");
  });
});

describe("closes through the engine (owner 2026-11-12)", () => {
  const session = { accountId: DEMO, brokerId: "b" };
  const env = { ENGINE_INGRESS_ACCOUNT_IDS: DEMO, ENGINE_INGRESS_GATEWAY_URL: "https://feed.example" };
  type Sent = { url: string; cookie: string | null; broker: string | null; body: Record<string, unknown> };

  function gateway(answer: () => Response | Promise<Response>) {
    const sent: Sent[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      sent.push({ url, cookie: h.get("cookie"), broker: h.get("x-broker-id"), body: JSON.parse(String(init.body)) });
      return answer();
    });
    return sent;
  }

  it("a single close goes to /v1/positions/:id/close with the app's bearer session and the client's reference", async () => {
    const { closeThroughEngine } = await load(env);
    jar.authorization = "Bearer app-token";
    const sent = gateway(() => Response.json({ position: { id: "p1", status: "CLOSED" }, partial: false, balance: "990" }));
    const res = await closeThroughEngine("p1", { closePrice: "4100.5", maxSlippagePoints: 30, idempotencyKey: "k1" }, session);
    expect(sent).toEqual([
      {
        url: "https://feed.example/v1/positions/p1/close",
        cookie: "vyx_trade_session=app-token",
        broker: "b",
        body: { closePrice: "4100.5", maxSlippagePoints: "30", idempotencyKey: "k1" },
      },
    ]);
    expect(res?.status).toBe(200);
    expect(await res!.json()).toMatchObject({ partial: false, balance: "990", executedBy: "engine" });
  });

  it("a basket goes to /v1/positions/close-bulk in the web's own scope vocabulary", async () => {
    const { closeBulkThroughEngine } = await load(env);
    jar.cookie = "cookie-token";
    const sent = gateway(() => Response.json({ requested: 2, successful: 2, failed: 0, results: [] }));
    const res = await closeBulkThroughEngine({ scope: "SYMBOL", symbol: "XAUUSD", side: "BUY", positionIds: ["a", "b"] }, session);
    expect(sent[0].url).toBe("https://feed.example/v1/positions/close-bulk");
    expect(sent[0].cookie).toBe("vyx_trade_session=cookie-token");
    expect(sent[0].body).toEqual({ scope: "SYMBOL", symbol: "XAUUSD", side: "BUY", positionIds: ["a", "b"] });
    expect(await res!.json()).toMatchObject({ requested: 2, successful: 2, executedBy: "engine" });
  });

  it("a 409 (already closed / pending / replayed key) is the answer, not a fallback", async () => {
    const { closeThroughEngine, closeBulkThroughEngine } = await load(env);
    jar.cookie = "t";
    gateway(() => Response.json({ error: "position was already closed" }, { status: 409 }));
    const one = await closeThroughEngine("p1", { closePrice: "1" }, session);
    expect(one?.status).toBe(409);
    expect(await one!.json()).toEqual({ error: "position was already closed" });
    expect((await closeBulkThroughEngine({ scope: "ALL" }, session))?.status).toBe(409);
  });

  it("403, 503, 400, 502 and a timeout / network failure all fall back to the web path (null)", async () => {
    const { closeThroughEngine, closeBulkThroughEngine } = await load(env);
    jar.cookie = "t";
    for (const status of [403, 503, 400, 502, 500]) {
      gateway(() => Response.json({ error: "x" }, { status }));
      expect(await closeThroughEngine("p1", { closePrice: "1" }, session), String(status)).toBeNull();
      expect(await closeBulkThroughEngine({ scope: "ALL" }, session), String(status)).toBeNull();
    }
    gateway(() => {
      throw new Error("aborted");
    });
    expect(await closeThroughEngine("p1", { closePrice: "1" }, session)).toBeNull();
    expect(await closeBulkThroughEngine({ scope: "ALL" }, session)).toBeNull();
  });

  it("no session token: nothing is sent, the web path closes", async () => {
    const { closeThroughEngine } = await load(env);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await closeThroughEngine("p1", { closePrice: "1" }, session)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
