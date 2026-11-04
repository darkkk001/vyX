import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  AMOUNT_NOT_AVAILABLE_TEXT, amountRefusalBody, amountRefusedForAuthority, amountsReachedError, amountTrigger, bothUnitsError, floatingPnlAt, legWrite,
  parseAmount, parseAmountLegs, setsAnAmount,
} from "@/lib/amount-sltp";
import { clientRefusal } from "@/lib/client-reason";

const D = (v: string | number) => new Prisma.Decimal(v);
const pos = (side: "BUY" | "SELL", open: string, sl: string | null, tp: string | null) => ({ side, openPrice: D(open), volume: D(1), contractSize: D(100), slAmount: sl ? D(sl) : null, tpAmount: tp ? D(tp) : null });

describe("parseAmount", () => {
  it("not sent / cleared / a positive number to the cent", () => {
    expect(parseAmount(undefined, "SL")).toEqual({ ok: true, value: undefined });
    expect(parseAmount(null, "SL")).toEqual({ ok: true, value: null });
    expect(parseAmount("", "SL")).toEqual({ ok: true, value: null });
    expect((parseAmount("12.345", "TP") as { value: Prisma.Decimal }).value.toFixed(2)).toBe("12.35");
    expect((parseAmount(7, "TP") as { value: Prisma.Decimal }).value.toFixed(2)).toBe("7.00");
    expect((parseAmount("1000000000", "TP") as { value: Prisma.Decimal }).value.toFixed(2)).toBe("1000000000.00");
  });
  it("refuses every hostile shape", () => {
    for (const v of ["NaN", "Infinity", "-Infinity", "-1", "0", "0.001", "0x1F", "1e5", "1E5", ".5", "5.", "1_000", "1,5", "abc", "1000000000.01", "99999999999999999999", NaN, Infinity, -3, 1e21, true, {}, [], [1], () => 1]) {
      expect(parseAmount(v, "SL").ok, String(v)).toBe(false);
    }
  });
});

describe("one unit per leg", () => {
  it("bothUnitsError", () => {
    expect(bothUnitsError("90", "5", "SL")).toBe("SL: set a price or an amount, not both");
    expect(bothUnitsError(null, "5", "SL")).toBeNull();
    expect(bothUnitsError("90", null, "TP")).toBeNull();
    expect(bothUnitsError("", "", "TP")).toBeNull();
    expect(bothUnitsError(undefined, 5, "TP")).toBeNull();
  });
  it("parseAmountLegs carries the code", () => {
    expect(parseAmountLegs({ slPrice: "1", slAmount: "2" })).toMatchObject({ ok: false, code: "AMOUNT_BOTH_UNITS" });
    expect(parseAmountLegs({ tpAmount: "-2" })).toMatchObject({ ok: false, code: "AMOUNT_INVALID" });
    const ok = parseAmountLegs({ slAmount: "5", tpAmount: null }) as { ok: true; slAmount: Prisma.Decimal; tpAmount: null };
    expect(ok.slAmount.toFixed(2)).toBe("5.00");
    expect(ok.tpAmount).toBeNull();
    expect(setsAnAmount({ slAmount: undefined, tpAmount: null })).toBe(false);
    expect(setsAnAmount({ slAmount: D(1), tpAmount: undefined })).toBe(true);
    expect(parseAmountLegs(null)).toEqual({ ok: true, slAmount: undefined, tpAmount: undefined });
  });
  it("legWrite: a price clears the amount, an amount clears the price, null clears only itself, nothing leaves it", () => {
    expect(legWrite("90", undefined)).toEqual({ price: "90", amount: null });
    expect(legWrite(undefined, D(5))).toEqual({ price: null, amount: D(5) });
    expect(legWrite(null, undefined)).toEqual({ price: null, amount: undefined });
    expect(legWrite(undefined, null)).toEqual({ price: undefined, amount: null });
    expect(legWrite(undefined, undefined)).toEqual({ price: undefined, amount: undefined });
  });
});

describe("floating P/L and the trigger (gross, SL first)", () => {
  it("BUY and SELL, both directions, exact edges", () => {
    // 1 lot x 100: a 1.00 move is 100.00
    expect(floatingPnlAt(pos("BUY", "100", null, null), D("99"), D(1)).toFixed(2)).toBe("-100.00");
    expect(floatingPnlAt(pos("SELL", "100", null, null), D("99"), D(1)).toFixed(2)).toBe("100.00");
    expect(floatingPnlAt(pos("BUY", "150", null, null), D("149"), D("0.008")).toFixed(2)).toBe("-0.80");
    const buy = pos("BUY", "100", "100", "200");
    expect(amountTrigger(buy, D("99.01"), D(1))).toBeNull();
    expect(amountTrigger(buy, D("99"), D(1))).toBe("stop_loss");
    expect(amountTrigger(buy, D("101.99"), D(1))).toBeNull();
    expect(amountTrigger(buy, D("102"), D(1))).toBe("take_profit");
    const sell = pos("SELL", "100", "100", "200");
    expect(amountTrigger(sell, D("100.99"), D(1))).toBeNull();
    expect(amountTrigger(sell, D("101"), D(1))).toBe("stop_loss");
    expect(amountTrigger(sell, D("98.01"), D(1))).toBeNull();
    expect(amountTrigger(sell, D("98"), D(1))).toBe("take_profit");
    expect(amountTrigger(pos("BUY", "100", null, null), D("1"), D(1))).toBeNull();
    // SL first when both are met
    expect(amountTrigger(pos("BUY", "100", "1", "1"), D("99"), D(1))).toBe("stop_loss");
  });
  it("amountsReachedError names the leg, the amount and the P/L", () => {
    expect(amountsReachedError(pos("BUY", "100", "10", null), D("99.9"), D(1), "USD")).toBe("SL amount 10.00 USD is already reached (P/L -10.00 USD): it would close at once");
    expect(amountsReachedError(pos("BUY", "100", "10.01", null), D("99.9"), D(1), "USD")).toBeNull();
    expect(amountsReachedError(pos("SELL", "110", null, "990"), D("100.1"), D(1), "EUR")).toMatch(/^TP amount 990\.00 EUR is already reached/);
  });
});

describe("RUST authority", () => {
  const rust = { riskAuthority: "RUST", riskAuthorityDemoOnly: true };
  it("refuses a RUST-owned account only, and ENGINE_AMOUNT_SLTP=1 lifts it", () => {
    expect(amountRefusedForAuthority(rust, "DEMO", {})).toBe(true);
    expect(amountRefusedForAuthority(rust, "LIVE", {})).toBe(false); // demo-only: the live account is WEB-owned
    expect(amountRefusedForAuthority({ ...rust, riskAuthorityDemoOnly: false }, "LIVE", {})).toBe(true);
    expect(amountRefusedForAuthority({ riskAuthority: "WEB", riskAuthorityDemoOnly: false }, "LIVE", {})).toBe(false);
    expect(amountRefusedForAuthority(null, "DEMO", {})).toBe(false);
    expect(amountRefusedForAuthority(rust, "DEMO", { ENGINE_AMOUNT_SLTP: "1" })).toBe(false);
    expect(amountRefusedForAuthority(rust, "DEMO", { ENGINE_AMOUNT_SLTP: "0" })).toBe(true);
    expect(amountRefusedForAuthority(rust, "DEMO", { ENGINE_AMOUNT_SLTP: "true" })).toBe(true);
  });
});

describe("what a client sees", () => {
  it("an amount refusal keeps clientReason INVALID_SLTP and carries its own sentence and code", () => {
    const body = amountRefusalBody("AMOUNT_SLTP_NOT_AVAILABLE", AMOUNT_NOT_AVAILABLE_TEXT);
    expect(clientRefusal(body)).toEqual({ error: AMOUNT_NOT_AVAILABLE_TEXT, clientReason: "INVALID_SLTP", message: AMOUNT_NOT_AVAILABLE_TEXT, amountCode: "AMOUNT_SLTP_NOT_AVAILABLE" });
  });
  it("an unknown amountCode, or an internal text, is not passed through", () => {
    const out = clientRefusal({ error: "secret internal", amountCode: "SOMETHING_ELSE", amountMessage: "leak" });
    expect(out).not.toHaveProperty("amountCode");
    expect(JSON.stringify(out)).not.toContain("leak");
  });
});
