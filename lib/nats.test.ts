import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This module used to open a direct NATS connection from inside the
// Vercel serverless function -- confirmed (via `vercel env ls
// production`) that NATS_URL was never even set there, so every publish
// silently failed from day one. Rewritten to POST to the API Gateway's
// new /internal/events relay instead (services/api-gateway/src/index.ts),
// a process that actually has a working NATS connection. These tests
// pin the new HTTP contract with a mocked fetch -- no real network/NATS
// involved, matching this repo's existing convention of not standing up
// real infra for a unit test.

describe("publishTradingEvent (HTTP relay to the gateway)", () => {
  const originalEnv = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.GATEWAY_URL = "https://gateway.test";
    process.env.INTERNAL_SERVICE_SECRET = "test-secret";
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("POSTs to GATEWAY_URL/internal/events with the shared secret header and the resolved NATS subject", async () => {
    const { publishTradingEvent } = await import("@/lib/nats");
    await publishTradingEvent("OrderFilled", { order_id: "o1", account_id: "a1", broker_id: "b1", price: "4442.6" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gateway.test/internal/events");
    expect(init.method).toBe("POST");
    expect(init.headers["x-internal-secret"]).toBe("test-secret");
    const body = JSON.parse(init.body);
    expect(body.subject).toBe("order.filled");
    expect(body.payload).toMatchObject({ type: "OrderFilled", order_id: "o1", account_id: "a1", broker_id: "b1", price: "4442.6" });
  });

  it("resolves the correct subject per event type", async () => {
    const { publishTradingEvent } = await import("@/lib/nats");
    const cases: [string, string][] = [
      ["OrderAccepted", "order.accepted"],
      ["OrderRejected", "order.rejected"],
      ["OrderCancelled", "order.cancelled"],
      ["OrderRequoted", "order.requoted"],
      ["DealingQueued", "dealing.queued"],
      ["PositionClosed", "position.closed"],
      ["PositionModified", "position.modified"],
    ];
    for (const [type, subject] of cases) {
      fetchMock.mockClear();
      await publishTradingEvent(type as never, { broker_id: "b1" });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.subject).toBe(subject);
    }
  });

  it("never throws when the gateway is unreachable -- a publish failure must never affect the caller's own trade/dealing action", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    const { publishTradingEvent } = await import("@/lib/nats");
    await expect(publishTradingEvent("OrderFilled", { broker_id: "b1" })).resolves.toBeUndefined();
  });

  it("never throws when the gateway responds with a non-2xx status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const { publishTradingEvent } = await import("@/lib/nats");
    await expect(publishTradingEvent("OrderFilled", { broker_id: "b1" })).resolves.toBeUndefined();
  });
});
