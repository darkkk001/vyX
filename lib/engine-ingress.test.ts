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
