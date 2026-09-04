import { GroupDealingMode } from "@prisma/client";

// Forward-compatible subset of the Auto Dealing design in
// REALTIME-SYNC-AND-DEALING-BRIEF §9 -- enum names kept consistent with
// it deliberately. Shared by both places that decide whether a MARKET
// order (or a resting order's trigger fill) reaches the manual dealing
// queue: app/api/trade/orders/route.ts and
// app/api/trade/orders/[id]/fill/route.ts. Previously duplicated inline
// in both files; extracted here once a group-level override was needed,
// so both call sites can't drift and the decision itself is unit-testable
// without spinning up either route. Also now the single source of truth
// for "is this a dealer-managed account" used by the dealer-awareness
// feature (lib/dealer-activity.ts) -- see that file's own note on the
// 2026-09-04 bug this fixed: Group.groupType alone is NOT the right
// signal (it's a book-routing classification most groups default to,
// unrelated to whether the dealer actually reviews this group's orders).
//
// INHERIT (default) = zero behavior change, the original three-way OR
// still decides. AUTO = always bypass the queue for this group,
// regardless of broker/group/desk settings (still subject to margin gate
// and server price -- this only skips manual review, not trade
// validity). MANUAL = always queue for this group, even if nothing else
// would have. Both AUTO and MANUAL are explicit per-group overrides an
// admin chose deliberately -- the broker-wide dealingDeskAutoFillOn
// switch below never touches a group that set either.
export function resolveWantsDealingQueue(params: {
  groupDealingMode: GroupDealingMode;
  brokerDealingModeOn: boolean;
  groupForceDealingMode: boolean;
  groupTypeIsDealing: boolean;
  // Dealer desk ON/OFF (2026-09-04) -- Broker.dealingDeskAutoFillAt != null.
  // Only relaxes review for a DEALING-type group sitting at the INHERIT
  // default (see groupTypeIsDealing below); never affects a group with an
  // explicit MANUAL/AUTO override (those already returned above), and
  // never affects a non-dealing-type group either (unrelated to this
  // switch -- that's what brokerDealingModeOn/groupForceDealingMode are
  // for). Defaults to false so every existing call site that hasn't been
  // updated to pass it keeps today's exact behavior.
  dealingDeskAutoFillOn?: boolean;
}): boolean {
  if (params.groupDealingMode === "MANUAL") return true;
  if (params.groupDealingMode === "AUTO") return false;
  if (params.groupTypeIsDealing && params.dealingDeskAutoFillOn) return false;
  return params.brokerDealingModeOn || params.groupForceDealingMode || params.groupTypeIsDealing;
}

// Shared "is this account's group actually dealer-managed right now"
// check -- the correct definition for the dealer-awareness feature
// (lib/dealer-activity.ts), reusing this file's own canonical routing
// decision instead of a separate, wrong proxy. A group with
// groupType=DEALING but dealingMode=AUTO (a legitimate, common
// configuration -- book-routing and manual-review are independent
// concerns) is NOT dealer-managed; this returns false for it, where the
// old `groupType === "DEALING"` check incorrectly returned true.
export function isDealingManagedAccount(params: {
  group: { dealingMode: GroupDealingMode; forceDealingMode: boolean; groupType: string } | null | undefined;
  brokerDealingModeOn: boolean;
  dealingDeskAutoFillOn?: boolean;
}): boolean {
  return resolveWantsDealingQueue({
    groupDealingMode: params.group?.dealingMode ?? "INHERIT",
    brokerDealingModeOn: params.brokerDealingModeOn,
    groupForceDealingMode: !!params.group?.forceDealingMode,
    groupTypeIsDealing: params.group?.groupType === "DEALING",
    dealingDeskAutoFillOn: params.dealingDeskAutoFillOn,
  });
}
