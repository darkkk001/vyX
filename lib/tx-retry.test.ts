import { describe, expect, it, vi } from "vitest";
import { isRetryableTxError, withDeadlockRetry } from "@/lib/tx-retry";

const deadlock = () => Object.assign(new Error("Raw query failed. Code: `40P01`. Message: `deadlock detected`"), { code: "P2010", meta: { code: "40P01" } });
const noSleep = async () => {};

describe("withDeadlockRetry", () => {
  it("recognises deadlock and serialization errors however Prisma wraps them", () => {
    expect(isRetryableTxError(deadlock())).toBe(true);
    expect(isRetryableTxError({ code: "P2034" })).toBe(true);
    expect(isRetryableTxError(new Error("ERROR: deadlock detected"))).toBe(true);
    expect(isRetryableTxError(new Error("could not serialize access (40001)"))).toBe(true);
    expect(isRetryableTxError(new Error("Unique constraint failed"))).toBe(false);
    expect(isRetryableTxError(null)).toBe(false);
  });
  it("retries a deadlock and returns the later success", async () => {
    const run = vi.fn().mockRejectedValueOnce(deadlock()).mockResolvedValueOnce("ok");
    expect(await withDeadlockRetry(run, { sleep: noSleep })).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("gives up after 2 retries and rethrows the deadlock", async () => {
    const run = vi.fn().mockRejectedValue(deadlock());
    await expect(withDeadlockRetry(run, { sleep: noSleep })).rejects.toThrow(/deadlock/);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("never retries any other error", async () => {
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withDeadlockRetry(run, { sleep: noSleep })).rejects.toThrow("boom");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
