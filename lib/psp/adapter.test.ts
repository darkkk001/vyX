import { describe, expect, it, vi, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import {
  resolvePspAdapter,
  manualPspAdapter,
  mockPspAdapter,
  nextPspStatusOnMark,
  nextPspStatusOnApprove,
  estimatePspFee,
} from "@/lib/psp/adapter";

const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  vi.stubEnv("NODE_ENV", originalNodeEnv ?? "test");
});

describe("resolvePspAdapter", () => {
  it("returns MANUAL when nothing is requested", () => {
    expect(resolvePspAdapter(undefined)).toBe(manualPspAdapter);
  });

  it("returns MOCK when explicitly requested outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(resolvePspAdapter("MOCK")).toBe(mockPspAdapter);
  });

  // The exploit this guards against: a real trader's request body is
  // attacker-controlled input. Without this, sending pspAdapter: "MOCK"
  // would make a deposit show "CREDITED" before any admin ever reviewed
  // it -- misleading, even though it can't move real balance on its own.
  it("refuses MOCK in production regardless of what's requested", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(resolvePspAdapter("MOCK")).toBe(manualPspAdapter);
  });

  it("ignores an unrecognized value and falls back to MANUAL", () => {
    expect(resolvePspAdapter("SOMETHING_ELSE")).toBe(manualPspAdapter);
  });
});

describe("manualPspAdapter", () => {
  it("deposit requests start PENDING with no confirmations reported", () => {
    const result = manualPspAdapter.requestDeposit({ amount: new Prisma.Decimal("100"), methodType: "BANK_TRANSFER" });
    expect(result.pspStatus).toBe("PENDING");
    expect(result.confirmations).toBeNull();
    expect(result.pspReference).toMatch(/^MAN-/);
  });

  it("withdrawal requests start REQUESTED", () => {
    const result = manualPspAdapter.requestWithdrawal({
      amount: new Prisma.Decimal("50"),
      methodType: "USDT_TRC20",
      destinationAddress: "T-fake-address",
    });
    expect(result.pspStatus).toBe("REQUESTED");
    expect(result.pspReference).toMatch(/^MAN-/);
  });
});

describe("mockPspAdapter", () => {
  it("deposit requests are immediately CREDITED, tagged as MOCK", () => {
    const result = mockPspAdapter.requestDeposit({ amount: new Prisma.Decimal("100"), methodType: "BTC" });
    expect(result.pspStatus).toBe("CREDITED");
    expect(result.pspReference).toMatch(/^MOCK-/);
  });

  it("withdrawal requests are immediately PAID, tagged as MOCK", () => {
    const result = mockPspAdapter.requestWithdrawal({
      amount: new Prisma.Decimal("50"),
      methodType: "ETH",
      destinationAddress: "0xfake",
    });
    expect(result.pspStatus).toBe("PAID");
    expect(result.pspReference).toMatch(/^MOCK-/);
  });
});

describe("nextPspStatusOnMark / nextPspStatusOnApprove", () => {
  it("mark always advances a withdrawal to APPROVED", () => {
    expect(nextPspStatusOnMark()).toBe("APPROVED");
  });

  it("approve advances a deposit to CREDITED and a withdrawal to PAID", () => {
    expect(nextPspStatusOnApprove("DEPOSIT")).toBe("CREDITED");
    expect(nextPspStatusOnApprove("WITHDRAWAL")).toBe("PAID");
  });
});

describe("estimatePspFee", () => {
  it("combines percent and fixed fee", () => {
    const fee = estimatePspFee({ feePercent: "1.5", feeFixed: "2" }, new Prisma.Decimal("1000"));
    // 1.5% of 1000 = 15, + 2 fixed = 17
    expect(fee.toString()).toBe("17");
  });

  it("is zero when both components are zero", () => {
    const fee = estimatePspFee({ feePercent: "0", feeFixed: "0" }, new Prisma.Decimal("500"));
    expect(fee.toString()).toBe("0");
  });
});
