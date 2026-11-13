import { beforeEach, describe, expect, it } from "vitest";
import { clientInstanceId, isMine, markOwn, noteEventOrigin, resetClientInstanceForTests } from "@/lib/client-instance";
import { parseClientOrigin, stampOrigin, withClientOrigin } from "@/lib/client-origin";

// Order sounds by origin (owner 2026-11-13, option C): one tab sounds only for what it caused.
describe("WebTrader tab: isMine", () => {
  beforeEach(() => resetClientInstanceForTests("tabAAAA1111aaaa"));

  it("an event this tab caused is mine; another tab's or one with no origin is not", () => {
    noteEventOrigin({ type: "PositionClosed", position_id: "p1", origin_client_id: "tabAAAA1111aaaa" } as never);
    noteEventOrigin({ type: "PositionClosed", position_id: "p2", origin_client_id: "tabBBBB2222bbbb" } as never);
    noteEventOrigin({ type: "PositionClosed", position_id: "p3" } as never);
    noteEventOrigin({ type: "PositionClosed", position_id: "p4", origin_client_id: null } as never);
    expect([isMine("p1"), isMine("p2"), isMine("p3"), isMine("p4"), isMine("unknown")]).toEqual([true, false, false, false, false]);
  });

  it("this tab's own action is mine even when the event names nobody (the engine path)", () => {
    markOwn("p9");
    noteEventOrigin({ type: "PositionClosed", position_id: "p9" } as never);
    expect(isMine("p9")).toBe(true);
  });

  it("an order event's nested position counts too", () => {
    noteEventOrigin({ type: "OrderFilled", order_id: "o1", position: { id: "p5" }, origin_client_id: "tabAAAA1111aaaa" } as never);
    expect(isMine("o1")).toBe(true); expect(isMine("p5")).toBe(true);
  });

  it("a tab id is a valid server-side client id", () => {
    resetClientInstanceForTests();
    expect(parseClientOrigin(clientInstanceId())).toBe(clientInstanceId());
  });
});

describe("server: stampOrigin", () => {
  it("stamps the request's client, keeps an explicit one (also null), and adds nothing outside a client request", () => {
    expect(withClientOrigin("clientAAAA1111aaaa", () => stampOrigin({ broker_id: "b" }))).toEqual({ broker_id: "b", origin_client_id: "clientAAAA1111aaaa" });
    expect(withClientOrigin("clientAAAA1111aaaa", () => stampOrigin({ broker_id: "b", origin_client_id: "clientBBBB2222bbbb" }))).toEqual({ broker_id: "b", origin_client_id: "clientBBBB2222bbbb" });
    expect(withClientOrigin("clientAAAA1111aaaa", () => stampOrigin({ broker_id: "b", origin_client_id: null }))).toEqual({ broker_id: "b", origin_client_id: null });
    expect(stampOrigin({ broker_id: "b" })).toEqual({ broker_id: "b" });
  });

  it("accepts only plausible ids", () => {
    expect(parseClientOrigin("clientAAAA1111aaaa")).toBe("clientAAAA1111aaaa");
    for (const bad of ["", "short", "<script>x</script>", "a".repeat(65), "has space 12345", null, undefined]) expect(parseClientOrigin(bad as never)).toBeNull();
  });
});
