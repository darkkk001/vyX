import { describe, expect, it } from "vitest";
import { resolveWantsDealingQueue } from "@/lib/dealing-routing";

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
