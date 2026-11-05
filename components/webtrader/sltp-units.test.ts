import { describe, expect, it } from "vitest";
import { amountInputError, amountRefusalText, amountRowText, formatAmount, legForModify, legForOrder, pipSizeOf, pipsToPrice, plainPositive } from "./sltp-units";

describe("pips", () => {
  it("one pip follows the server's rule: 10^-(digits-1)", () => {
    expect(pipSizeOf(5)).toBeCloseTo(0.0001, 12);
    expect(pipSizeOf(3)).toBeCloseTo(0.01, 12);
    expect(pipSizeOf(2)).toBeCloseTo(0.1, 12);
    expect(pipSizeOf(0)).toBe(1);
  });
  it("a stop loss sits on the losing side and a take profit on the winning side, BUY and SELL", () => {
    const buy = { side: "BUY" as const, ref: 1.1, digits: 5 };
    const sell = { side: "SELL" as const, ref: 1.1, digits: 5 };
    expect(pipsToPrice({ ...buy, kind: "sl", pips: 20 })).toBe(1.098);
    expect(pipsToPrice({ ...buy, kind: "tp", pips: 20 })).toBe(1.102);
    expect(pipsToPrice({ ...sell, kind: "sl", pips: 20 })).toBe(1.102);
    expect(pipsToPrice({ ...sell, kind: "tp", pips: 20 })).toBe(1.098);
    expect(pipsToPrice({ side: "BUY", kind: "sl", ref: 4050, pips: 30, digits: 2 })).toBe(4047);
  });
});

describe("plain numbers only", () => {
  it("plainPositive refuses signs, exponents, hex, separators and zero", () => {
    expect(plainPositive("12.5")).toBe(12.5);
    expect(plainPositive(" 7 ")).toBe(7);
    for (const v of ["", "0", "0.0", "-1", "+1", "1e3", "0x10", "1,000", ".5", "5.", "NaN", "Infinity", "abc"]) expect(plainPositive(v), v).toBeNull();
  });
  it("amountInputError", () => {
    expect(amountInputError("50")).toBeNull();
    expect(amountInputError("1000000000")).toBeNull();
    expect(amountInputError("1000000001")).toBe("That amount is too large");
    expect(amountInputError("-5")).toBe("Enter an amount above 0");
    expect(amountInputError("")).toBe("Enter an amount above 0");
  });
});

describe("a new order's legs", () => {
  const base = { kind: "sl" as const, side: "BUY" as const, ref: 100.1, digits: 2 };
  it("price is exactly as before: empty is null, a number is the level", () => {
    expect(legForOrder({ ...base, unit: "price", raw: "" })).toEqual({ ok: true, wire: { price: null } });
    expect(legForOrder({ ...base, unit: "price", raw: "99.5" })).toEqual({ ok: true, wire: { price: 99.5 } });
    expect(legForOrder({ ...base, unit: "price", raw: "x" })).toEqual({ ok: false, error: "Enter a valid stop loss price" });
  });
  it("pips become a price from the reference, never an amount", () => {
    expect(legForOrder({ ...base, unit: "pips", raw: "10" })).toEqual({ ok: true, wire: { price: 99.1 } });
    expect(legForOrder({ ...base, unit: "pips", raw: "-3" })).toEqual({ ok: false, error: "Enter stop loss pips above 0" });
    expect(legForOrder({ ...base, kind: "tp", unit: "pips", raw: "10" })).toEqual({ ok: true, wire: { price: 101.1 } });
  });
  it("amount sends the amount text and no price", () => {
    expect(legForOrder({ ...base, unit: "amount", raw: "250.50" })).toEqual({ ok: true, wire: { amount: "250.50" } });
    expect(legForOrder({ ...base, unit: "amount", raw: "" })).toEqual({ ok: true, wire: { price: null } });
    expect(legForOrder({ ...base, unit: "amount", raw: "1e3" }).ok).toBe(false);
    expect(legForOrder({ ...base, unit: "amount", raw: "0" }).ok).toBe(false);
  });
});

describe("an existing position's legs", () => {
  const base = { kind: "tp" as const, side: "SELL" as const, ref: 100, digits: 2 };
  it("price: empty clears the price (as before); pips and amount leave an empty field alone", () => {
    expect(legForModify({ ...base, unit: "price", raw: "", existingAmount: null })).toEqual({ ok: true, wire: { price: null } });
    expect(legForModify({ ...base, unit: "pips", raw: "", existingAmount: null })).toEqual({ ok: true, wire: {} });
    expect(legForModify({ ...base, unit: "amount", raw: "", existingAmount: null })).toEqual({ ok: true, wire: {} });
  });
  it("an amount field that held an amount and was emptied clears it", () => {
    expect(legForModify({ ...base, unit: "amount", raw: "", existingAmount: "300" })).toEqual({ ok: true, wire: { amount: null } });
  });
  it("the net modal leaves every empty field alone", () => {
    for (const unit of ["price", "pips", "amount"] as const) expect(legForModify({ ...base, unit, raw: "", existingAmount: "300", keepWhenEmpty: true })).toEqual({ ok: true, wire: {} });
  });
  it("a typed value is the same as an order's", () => {
    expect(legForModify({ ...base, unit: "pips", raw: "5", existingAmount: null })).toEqual({ ok: true, wire: { price: 99.5 } });
    expect(legForModify({ ...base, unit: "amount", raw: "75", existingAmount: null })).toEqual({ ok: true, wire: { amount: "75" } });
  });
});

describe("amounts on screen", () => {
  it("formats to the cent", () => {
    expect(formatAmount("1234.5")).toBe("1,234.50");
    expect(formatAmount(0.8)).toBe("0.80");
    expect(formatAmount("x")).toBe("");
  });
  it("shows the server's sentence for an amount refusal, nothing for any other error", () => {
    const refusal = { body: { error: "x", clientReason: "INVALID_SLTP", message: "SL amount 10.00 USD is already reached (P/L -10.00 USD): it would close at once", amountCode: "AMOUNT_ALREADY_REACHED" } };
    expect(amountRefusalText(refusal)).toBe("SL amount 10.00 USD is already reached (P/L -10.00 USD): it would close at once");
    expect(amountRefusalText({ body: { clientReason: "INVALID_SLTP", message: "Invalid SL or TP" } })).toBeNull();
    expect(amountRefusalText(new Error("boom"))).toBeNull();
    expect(amountRefusalText(null)).toBeNull();
    expect(amountRowText({ amountCode: "AMOUNT_SLTP_NOT_AVAILABLE", message: "Amount take profit / stop loss is not available for this account yet" })).toBe("Amount take profit / stop loss is not available for this account yet");
  });
});
