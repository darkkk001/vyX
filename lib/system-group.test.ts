import { describe, expect, it } from "vitest";
import { groupHasAccountsMessage, isSystemGroup } from "@/lib/system-group";

describe("system group (platform-created, never deletable)", () => {
  it("is the hedge group and the starter Dealing group", () => {
    expect(isSystemGroup({ category: "COVERAGE", name: "Dealer Coverage (system)" })).toBe(true);
    expect(isSystemGroup({ category: "DEALING", name: "Dealing" })).toBe(true);
    expect(isSystemGroup({ category: "DEALING", name: "VIP desk" })).toBe(false);
    expect(isSystemGroup({ category: "B_BOOK", name: "Standard" })).toBe(false);
    expect(isSystemGroup({ category: "B_BOOK", name: "Dealing" })).toBe(false);
  });
  it("says how many accounts to move", () => {
    expect(groupHasAccountsMessage(12)).toBe("This group has 12 accounts. Move them first.");
    expect(groupHasAccountsMessage(1)).toBe("This group has 1 account. Move it first.");
  });
});
