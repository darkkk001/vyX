import { GroupDealingMode } from "@prisma/client";

// Forward-compatible subset of the Auto Dealing design in
// REALTIME-SYNC-AND-DEALING-BRIEF §9 -- enum names kept consistent with
// it deliberately. Shared by both places that decide whether a MARKET
// order (or a resting order's trigger fill) reaches the manual dealing
// queue: app/api/trade/orders/route.ts and
// app/api/trade/orders/[id]/fill/route.ts. Previously duplicated inline
// in both files; extracted here once a group-level override was needed,
// so both call sites can't drift and the decision itself is unit-testable
// without spinning up either route.
//
// INHERIT (default) = zero behavior change, the original three-way OR
// still decides. AUTO = always bypass the queue for this group,
// regardless of broker/group settings (still subject to margin gate and
// server price -- this only skips manual review, not trade validity).
// MANUAL = always queue for this group, even if nothing else would have.
export function resolveWantsDealingQueue(params: {
  groupDealingMode: GroupDealingMode;
  brokerDealingModeOn: boolean;
  groupForceDealingMode: boolean;
  groupTypeIsDealing: boolean;
}): boolean {
  if (params.groupDealingMode === "MANUAL") return true;
  if (params.groupDealingMode === "AUTO") return false;
  return params.brokerDealingModeOn || params.groupForceDealingMode || params.groupTypeIsDealing;
}
