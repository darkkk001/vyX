import { describe, expect, it } from "vitest";
import { orderRoute, resolveWantsDealingQueue, isDealingManagedAccount, deskIsOn } from "@/lib/dealing-routing";
import { checkAccountStructure } from "@/lib/account-structure";

// Routing by the group's category (owner decision 2026-09-26, Phase 2 batch 2). The retired inputs (Group.dealingMode,
// forceDealingMode outside DEALING, Broker.dealingModeAt, the legacy groupType) no longer exist in the signature.
const g = (category: "A_BOOK" | "B_BOOK" | "DEALING" | "REVERSAL" | "COVERAGE", forceDealingMode = false) => ({ category, forceDealingMode });

describe("orderRoute: one rule per category", () => {
  it.each([
    // category, alwaysSendToDealer, desk ON, desk OFF
    ["B_BOOK", false, "FILL", "FILL"],
    ["B_BOOK", true, "FILL", "FILL"], // the dealer option means nothing outside DEALING
    ["DEALING", false, "QUEUE", "FILL"],
    ["DEALING", true, "QUEUE", "QUEUE"], // "Always send to dealer": queued even with the desk off
    ["REVERSAL", false, "FILL", "FILL"],
    ["REVERSAL", true, "FILL", "FILL"],
    ["A_BOOK", false, "NO_LP", "NO_LP"], // no liquidity provider connected yet
    ["COVERAGE", false, "SYSTEM", "SYSTEM"],
  ] as const)("%s (always to dealer: %s): desk on -> %s, desk off -> %s", (category, always, deskOnRoute, deskOffRoute) => {
    expect(orderRoute(g(category, always), true)).toBe(deskOnRoute);
    expect(orderRoute(g(category, always), false)).toBe(deskOffRoute);
  });

  it("an account with no group routes like B_BOOK", () => {
    expect(orderRoute(null, true)).toBe("FILL");
  });

  it("queue / dealer-managed are exactly route === QUEUE; NO_LP and SYSTEM are never queued (a close must not strand)", () => {
    for (const [group, deskOn, queued] of [
      [g("DEALING"), true, true],
      [g("DEALING"), false, false],
      [g("B_BOOK"), true, false],
      [g("A_BOOK"), true, false],
      [g("COVERAGE"), true, false],
    ] as const) {
      expect(resolveWantsDealingQueue({ group, deskOn })).toBe(queued);
      expect(isDealingManagedAccount({ group, deskOn })).toBe(queued);
    }
  });

  it("the desk switch: ON = Broker.dealingDeskAutoFillAt null", () => {
    expect(deskIsOn({ dealingDeskAutoFillAt: null })).toBe(true);
    expect(deskIsOn({ dealingDeskAutoFillAt: new Date() })).toBe(false);
    expect(deskIsOn(null)).toBe(false);
  });
});

describe("accounts into an A_BOOK group without a connected LP are refused", () => {
  it("a LIVE account gets the LP message; a DEMO account keeps its more specific refusal", () => {
    const live = checkAccountStructure({ accountMode: "LIVE", group: { category: "A_BOOK", modeRestriction: "LIVE_ONLY" } });
    expect(live?.code).toBe("LP_NOT_CONNECTED");
    expect(live?.message).toMatch(/no liquidity provider is connected/);
    expect(checkAccountStructure({ accountMode: "DEMO", group: { category: "A_BOOK", modeRestriction: "LIVE_ONLY" } })?.code).toBe("DEMO_IN_LIVE_MONEY_GROUP");
    expect(checkAccountStructure({ accountMode: "LIVE", group: { category: "B_BOOK", modeRestriction: "ANY" } })).toBeNull();
    expect(checkAccountStructure({ accountMode: "LIVE", group: { category: "COVERAGE", modeRestriction: "LIVE_ONLY" } })?.code).toBe("COVERAGE_GROUP_RESERVED");
  });
});
