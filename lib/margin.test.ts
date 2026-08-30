import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { requiredMarginFor, checkPreTradeMargin } from "@/lib/margin";

// Phase 0 money-risk patch (docs/ROADMAP.md item 2) -- these two
// functions are deliberately kept in lockstep with
// engine/risk/src/lib.rs's required_margin/check_free_margin so both
// execution paths (legacy Next.js and the Rust engine) reject the same
// order for the same reason. The three cases below use that Rust file's
// own test fixture numbers verbatim (required_margin_standard_lot_1_to_100,
// rejects_when_free_margin_insufficient, accepts_when_free_margin_sufficient)
// so a future change to either side's formula that breaks parity fails a
// test on sight instead of silently diverging.

describe("requiredMarginFor (parity with engine/risk/src/lib.rs's required_margin)", () => {
  it("matches the Rust fixture: 1 lot EURUSD, contract size 100,000, price 1.10000, leverage 100", () => {
    const m = requiredMarginFor(new Prisma.Decimal(1), new Prisma.Decimal(100000), new Prisma.Decimal("1.10000"), 100);
    expect(m.toString()).toBe("1100");
  });
});

describe("checkPreTradeMargin (parity with engine/risk/src/lib.rs's check_free_margin at marginCallLevel=100)", () => {
  // At marginCallLevel=100, projectedLevel < 100 is exactly
  // free-margin(equity-usedMargin) < required -- Rust's own inequality.
  it("rejects with INSUFFICIENT_MARGIN when Rust's own fixture rejects (equity 1000, used 500, required 600)", () => {
    const result = checkPreTradeMargin({
      equity: new Prisma.Decimal(1000),
      usedMargin: new Prisma.Decimal(500),
      requiredMargin: new Prisma.Decimal(600),
      marginCallLevel: new Prisma.Decimal(100),
    });
    expect(result).toBe("INSUFFICIENT_MARGIN");
  });

  it("accepts when Rust's own fixture accepts (equity 1000, used 200, required 600)", () => {
    const result = checkPreTradeMargin({
      equity: new Prisma.Decimal(1000),
      usedMargin: new Prisma.Decimal(200),
      requiredMargin: new Prisma.Decimal(600),
      marginCallLevel: new Prisma.Decimal(100),
    });
    expect(result).toBeNull();
  });

  it("honors a broker/group's own configured margin-call level, not just Rust's hardcoded 100", () => {
    // Same numbers as the "accepts" case above (free margin 800 >= 600,
    // so Rust's binary check_free_margin would pass) -- but a broker
    // that's configured a stricter 150% call level should still reject,
    // since 1000 / (200+600) * 100 = 125 < 150.
    const result = checkPreTradeMargin({
      equity: new Prisma.Decimal(1000),
      usedMargin: new Prisma.Decimal(200),
      requiredMargin: new Prisma.Decimal(600),
      marginCallLevel: new Prisma.Decimal(150),
    });
    expect(result).toBe("INSUFFICIENT_MARGIN");
  });

  it("a flat account (no existing usedMargin) is gated purely on the new order's own required margin", () => {
    const accepted = checkPreTradeMargin({
      equity: new Prisma.Decimal(1000),
      usedMargin: new Prisma.Decimal(0),
      requiredMargin: new Prisma.Decimal(500),
      marginCallLevel: new Prisma.Decimal(100),
    });
    expect(accepted).toBeNull(); // 1000/500*100 = 200 >= 100

    const rejected = checkPreTradeMargin({
      equity: new Prisma.Decimal(1000),
      usedMargin: new Prisma.Decimal(0),
      requiredMargin: new Prisma.Decimal(1500),
      marginCallLevel: new Prisma.Decimal(100),
    });
    expect(rejected).toBe("INSUFFICIENT_MARGIN"); // 1000/1500*100 = 66.67 < 100
  });
});
