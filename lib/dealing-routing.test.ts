import { describe, expect, it } from "vitest";
import { resolveWantsDealingQueue, isDealingManagedAccount } from "@/lib/dealing-routing";

// Reverse-mirror hook gap follow-up: Futurix's "Reverse" group was left at
// its default groupType=DEALING (see prisma/schema.prisma's own comment on
// why that's the default), which routes every order to the manual dealing
// queue -- fatal for a strategy that depends on instant fills. This is the
// group-level override that lets a group stay correctly groupType=DEALING
// for book accounting while still bypassing the queue.

describe("resolveWantsDealingQueue -- INHERIT (default, zero behavior change)", () => {
  it("queues when the broker-wide dealing mode is on", () => {
    expect(
      resolveWantsDealingQueue({ groupDealingMode: "INHERIT", brokerDealingModeOn: true, groupForceDealingMode: false, groupTypeIsDealing: false })
    ).toBe(true);
  });

  it("queues when the group's own forceDealingMode is on", () => {
    expect(
      resolveWantsDealingQueue({ groupDealingMode: "INHERIT", brokerDealingModeOn: false, groupForceDealingMode: true, groupTypeIsDealing: false })
    ).toBe(true);
  });

  it("queues when the group's groupType is DEALING", () => {
    expect(
      resolveWantsDealingQueue({ groupDealingMode: "INHERIT", brokerDealingModeOn: false, groupForceDealingMode: false, groupTypeIsDealing: true })
    ).toBe(true);
  });

  it("does not queue when none of the three legacy conditions are set", () => {
    expect(
      resolveWantsDealingQueue({ groupDealingMode: "INHERIT", brokerDealingModeOn: false, groupForceDealingMode: false, groupTypeIsDealing: false })
    ).toBe(false);
  });
});

describe("resolveWantsDealingQueue -- AUTO (always bypass, regardless of anything else)", () => {
  it("never queues even when every legacy condition is on", () => {
    expect(
      resolveWantsDealingQueue({ groupDealingMode: "AUTO", brokerDealingModeOn: true, groupForceDealingMode: true, groupTypeIsDealing: true })
    ).toBe(false);
  });

  it("never queues when nothing else is on either (the ordinary case)", () => {
    expect(
      resolveWantsDealingQueue({ groupDealingMode: "AUTO", brokerDealingModeOn: false, groupForceDealingMode: false, groupTypeIsDealing: false })
    ).toBe(false);
  });

  it("this is the fix: a group that is correctly groupType=DEALING for book accounting still auto-fills under AUTO", () => {
    expect(
      resolveWantsDealingQueue({ groupDealingMode: "AUTO", brokerDealingModeOn: false, groupForceDealingMode: false, groupTypeIsDealing: true })
    ).toBe(false);
  });
});

describe("resolveWantsDealingQueue -- MANUAL (always queue, regardless of anything else)", () => {
  it("always queues even when every legacy condition is off", () => {
    expect(
      resolveWantsDealingQueue({ groupDealingMode: "MANUAL", brokerDealingModeOn: false, groupForceDealingMode: false, groupTypeIsDealing: false })
    ).toBe(true);
  });

  it("always queues when every legacy condition is also on (redundant, still true)", () => {
    expect(
      resolveWantsDealingQueue({ groupDealingMode: "MANUAL", brokerDealingModeOn: true, groupForceDealingMode: true, groupTypeIsDealing: true })
    ).toBe(true);
  });
});

describe("resolveWantsDealingQueue -- dealingDeskAutoFillOn (2026-09-04)", () => {
  it("bypasses the queue for an INHERIT, groupType=DEALING group when the desk switch is off", () => {
    expect(
      resolveWantsDealingQueue({
        groupDealingMode: "INHERIT",
        brokerDealingModeOn: false,
        groupForceDealingMode: false,
        groupTypeIsDealing: true,
        dealingDeskAutoFillOn: true,
      })
    ).toBe(false);
  });

  it("does not affect a group whose own dealingMode is explicitly MANUAL", () => {
    expect(
      resolveWantsDealingQueue({
        groupDealingMode: "MANUAL",
        brokerDealingModeOn: false,
        groupForceDealingMode: false,
        groupTypeIsDealing: true,
        dealingDeskAutoFillOn: true,
      })
    ).toBe(true);
  });

  it("does not affect a group whose own dealingMode is explicitly AUTO (already false either way)", () => {
    expect(
      resolveWantsDealingQueue({
        groupDealingMode: "AUTO",
        brokerDealingModeOn: false,
        groupForceDealingMode: false,
        groupTypeIsDealing: true,
        dealingDeskAutoFillOn: true,
      })
    ).toBe(false);
  });

  it("does not affect a non-dealing-type group (the switch only ever relaxes DEALING-type groups)", () => {
    expect(
      resolveWantsDealingQueue({
        groupDealingMode: "INHERIT",
        brokerDealingModeOn: true,
        groupForceDealingMode: false,
        groupTypeIsDealing: false,
        dealingDeskAutoFillOn: true,
      })
    ).toBe(true);
  });

  it("defaults to off (undefined) with zero behavior change for callers that haven't been updated", () => {
    expect(
      resolveWantsDealingQueue({
        groupDealingMode: "INHERIT",
        brokerDealingModeOn: false,
        groupForceDealingMode: false,
        groupTypeIsDealing: true,
      })
    ).toBe(true);
  });
});

describe("isDealingManagedAccount -- the 2026-09-04 bug fix", () => {
  it("is false for a groupType=DEALING group whose own dealingMode is AUTO (the actual reported bug: a 'B-Book' group)", () => {
    expect(
      isDealingManagedAccount({
        group: { groupType: "DEALING", dealingMode: "AUTO", forceDealingMode: false },
        brokerDealingModeOn: false,
      })
    ).toBe(false);
  });

  it("is true for a groupType=DEALING group at the INHERIT default", () => {
    expect(
      isDealingManagedAccount({
        group: { groupType: "DEALING", dealingMode: "INHERIT", forceDealingMode: false },
        brokerDealingModeOn: false,
      })
    ).toBe(true);
  });

  it("is false for an account with no group at all", () => {
    expect(isDealingManagedAccount({ group: null, brokerDealingModeOn: false })).toBe(false);
  });

  it("is true for any group when the broker-wide dealingModeAt is on", () => {
    expect(
      isDealingManagedAccount({
        group: { groupType: "LP", dealingMode: "INHERIT", forceDealingMode: false },
        brokerDealingModeOn: true,
      })
    ).toBe(true);
  });

  it("respects the dealer desk switch for a groupType=DEALING/INHERIT group", () => {
    expect(
      isDealingManagedAccount({
        group: { groupType: "DEALING", dealingMode: "INHERIT", forceDealingMode: false },
        brokerDealingModeOn: false,
        dealingDeskAutoFillOn: true,
      })
    ).toBe(false);
  });
});
