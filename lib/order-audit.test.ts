import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { orderAuditFields, describeOrderAuditEvent } from "@/lib/order-audit";

// Broker feedback items 14+15 -- lib/order-audit.ts is the one place
// every order-lifecycle AuditLog write and every trader-Logs-tab message
// funnels through, so these are worth pinning directly rather than only
// through the route tests that call them.

describe("orderAuditFields", () => {
  it("always includes order number, account number, symbol, side, type, and lots", () => {
    const fields = orderAuditFields({ id: "cabc123order", side: "BUY", type: "LIMIT", volume: new Prisma.Decimal("0.10") }, "XAUUSD", "700123");
    expect(fields).toEqual({
      orderNumber: "cabc123order",
      accountNumber: "700123",
      symbol: "XAUUSD",
      side: "BUY",
      type: "LIMIT",
      lots: "0.1",
    });
  });

  it("accepts a plain string volume too (not just Decimal)", () => {
    const fields = orderAuditFields({ id: "x", side: "SELL", type: "MARKET", volume: "2.50" }, "EURUSD", "1");
    expect(fields.lots).toBe("2.50");
  });
});

describe("describeOrderAuditEvent", () => {
  const identity = { orderNumber: "cabc12345678", accountNumber: "700123", symbol: "XAUUSD", side: "BUY", type: "LIMIT", lots: "0.10" };

  it("ORDER_PLACED includes the entry price and SL/TP when set", () => {
    const msg = describeOrderAuditEvent("ORDER_PLACED", {}, { ...identity, requestedPrice: "4360.00", slPrice: "4350.00", tpPrice: "4380.00", status: "PENDING" });
    expect(msg).toContain("XAUUSD BUY 0.10");
    expect(msg).toContain("#12345678");
    expect(msg).toContain("4360.00");
    expect(msg).toContain("SL 4350.00");
    expect(msg).toContain("TP 4380.00");
  });

  it("ORDER_PLACED omits SL/TP when neither was set", () => {
    const msg = describeOrderAuditEvent("ORDER_PLACED", {}, { ...identity, requestedPrice: "4360.00" });
    expect(msg).not.toMatch(/SL|TP/);
  });

  it("ORDER_MODIFIED shows old -> new only for the field that actually changed", () => {
    const msg = describeOrderAuditEvent(
      "ORDER_MODIFIED",
      { ...identity, slPrice: "4350.00" },
      { ...identity, slPrice: "4345.00" }
    );
    expect(msg).toContain("slPrice 4350.00 → 4345.00");
    expect(msg).not.toContain("requestedPrice");
  });

  it("ORDER_TRIGGERED_AND_FILLED shows both the original request and the actual fill", () => {
    const msg = describeOrderAuditEvent(
      "ORDER_TRIGGERED_AND_FILLED",
      { ...identity, requestedPrice: "4360.00" },
      { triggerPrice: "4360.10", filledPrice: "4360.20", status: "FILLED" }
    );
    expect(msg).toContain("4360.20");
    expect(msg).toContain("requested 4360.00");
  });

  it("TRADER_CANCELLED_PENDING_ORDER identifies the order without needing anything else", () => {
    const msg = describeOrderAuditEvent("TRADER_CANCELLED_PENDING_ORDER", { ...identity, status: "PENDING" }, { status: "CANCELLED", cancelledBy: "CLIENT" });
    expect(msg).toContain("XAUUSD BUY 0.10");
    expect(msg).toContain("#12345678");
  });

  it("returns null for an action this Logs tab has no line for, instead of throwing", () => {
    expect(describeOrderAuditEvent("SOME_UNRELATED_ACTION", {}, {})).toBeNull();
  });
});
