import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn() }));
import { closeReasonFromDeal, closeReasonFromNote } from "@/lib/dealer-activity";

// Deal model step 4, reader dealer_activity: the close reason from Deal.reason (lib/dealer-activity.ts).
describe("close reason from the deal", () => {
  it("maps every DealReason", () => {
    expect(closeReasonFromDeal("SL")).toBe("STOP_LOSS");
    expect(closeReasonFromDeal("TP")).toBe("TAKE_PROFIT");
    expect(closeReasonFromDeal("STOP_OUT")).toBe("STOP_OUT");
    expect(closeReasonFromDeal("MIRROR")).toBe("MIRROR");
    expect(closeReasonFromDeal("COVERAGE")).toBe("COVERAGE");
    expect(closeReasonFromDeal("ADMIN")).toBe("ADMIN");
    expect(closeReasonFromDeal("REVERSE")).toBe("ADMIN");
    for (const r of ["CLIENT", "DEALER", "BULK", "CLOSE_BY", "EXPIRY"] as const) expect(closeReasonFromDeal(r)).toBe("MANUAL");
  });
  it("agrees with the note parser, except the staff reverse its prefix list missed", () => {
    expect(closeReasonFromNote("Dealer close (at market)")).toBe(closeReasonFromDeal("DEALER"));
    expect(closeReasonFromNote("Stop loss hit (automatic)")).toBe(closeReasonFromDeal("SL"));
    // live 2026-10-22: the only difference over every closed position
    expect(closeReasonFromNote("Reversed by admin @ 4438.33")).toBe("MANUAL");
    expect(closeReasonFromDeal("REVERSE")).toBe("ADMIN");
  });
});
