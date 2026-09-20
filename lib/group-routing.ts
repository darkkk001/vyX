import type { GroupType, GroupDealingMode, RoutingCategory, GroupModeRestriction } from "@prisma/client";

// The one place that translates between the new two-axis group shape
// (category + modeRestriction) and the single legacy `groupType` field that
// backoffice 1.0.9 -- the build in the field right now -- still sends and
// still renders. Stage 1 of docs/ACCOUNT-STRUCTURE-MIGRATION.md §1.4.
//
// Both directions live here so the groups POST and PATCH routes cannot
// drift apart, and so there is exactly one thing to delete when 1.0.10 is
// the only client left.

// COVERAGE is system-owned (lib/coverage.ts provisions it) and is never
// offered to, or accepted from, a client of this API. REVERSAL is optional
// per broker but is a perfectly ordinary choice for one that has a mirror
// book.
export const CLIENT_ROUTING_CATEGORIES: RoutingCategory[] = ["A_BOOK", "B_BOOK", "DEALING", "REVERSAL"];
export const MODE_RESTRICTIONS: GroupModeRestriction[] = ["ANY", "LIVE_ONLY", "DEMO_ONLY"];

export type GroupRouting = { category: RoutingCategory; modeRestriction: GroupModeRestriction };

type Existing = { category: RoutingCategory; modeRestriction: GroupModeRestriction } | null;

// What a 1.0.9 groupType means in the new model. LP is the only legacy
// value that maps to a real routing change; DEMO was never routing at all
// (it was a statement about MODE) so it becomes B_BOOK plus the DEMO_ONLY
// restriction, which is what the group always actually meant.
function fromLegacyGroupType(
  groupType: GroupType,
  dealingMode: GroupDealingMode,
  existing: Existing
): GroupRouting {
  // A legacy client cannot express REVERSAL or COVERAGE, so it must not be
  // able to destroy them either: a 1.0.9 PATCH that resends `DEALING` on a
  // group already classified as one of those keeps the classification.
  // (The plan only said "never write REVERSAL or COVERAGE from the legacy
  // field"; silently downgrading an existing one would have been the same
  // bug in the other direction.)
  const preserved = existing && (existing.category === "REVERSAL" || existing.category === "COVERAGE");

  if (groupType === "LP") {
    return { category: "A_BOOK", modeRestriction: "LIVE_ONLY" };
  }
  if (groupType === "DEMO") {
    return { category: preserved ? existing!.category : "B_BOOK", modeRestriction: "DEMO_ONLY" };
  }
  // DEALING (COVERAGE is not in the route's accepted list at all)
  const category: RoutingCategory = preserved
    ? existing!.category
    : dealingMode === "AUTO"
      ? "B_BOOK"
      : "DEALING";
  return { category, modeRestriction: existing?.modeRestriction ?? "ANY" };
}

// Reads whichever shape the caller sent. A body carrying `category` is a
// 1.0.10+/web client and wins outright; a body carrying only `groupType` is
// backoffice 1.0.9 and goes through the shim; a body with neither keeps
// what the row already has (create defaults to DEALING/ANY, the same
// default GroupType has today).
export function resolveGroupRouting(
  body: { category?: unknown; modeRestriction?: unknown; groupType?: unknown } | null,
  dealingMode: GroupDealingMode,
  existing: Existing = null
): GroupRouting {
  const rawCategory = body?.category;
  if (typeof rawCategory === "string" && CLIENT_ROUTING_CATEGORIES.includes(rawCategory as RoutingCategory)) {
    const category = rawCategory as RoutingCategory;
    const rawMode = body?.modeRestriction;
    const explicitMode =
      typeof rawMode === "string" && MODE_RESTRICTIONS.includes(rawMode as GroupModeRestriction)
        ? (rawMode as GroupModeRestriction)
        : null;

    // Practice money is never bridged to a liquidity provider, so an
    // A_BOOK group is LIVE_ONLY whatever the request said. The same rule
    // is enforced per account in lib/account-structure.ts; normalising it
    // here too keeps the stored row honest instead of relying on readers.
    if (category === "A_BOOK") return { category, modeRestriction: "LIVE_ONLY" };

    if (explicitMode) return { category, modeRestriction: explicitMode };

    // Moving a group OFF A_BOOK while saying nothing about mode: the
    // LIVE_ONLY that A_BOOK forced was never a deliberate choice, so it
    // does not follow the group to its new category.
    if (existing?.category === "A_BOOK") return { category, modeRestriction: "ANY" };

    return { category, modeRestriction: existing?.modeRestriction ?? "ANY" };
  }

  const rawType = body?.groupType;
  if (rawType === "LP" || rawType === "DEALING" || rawType === "DEMO") {
    return fromLegacyGroupType(rawType, dealingMode, existing);
  }

  return existing ?? { category: "DEALING", modeRestriction: "ANY" };
}

// The shadow value written alongside category/modeRestriction for this one
// release. Two readers still depend on it: backoffice 1.0.9 in the field
// (through the GET responses) and the dealing-desk paths that ask
// `groupType === "DEALING"`. Keeping it truthful is also what makes the
// rollback in §1.6 a pure code revert.
export function legacyGroupTypeFor(routing: GroupRouting): GroupType {
  if (routing.category === "COVERAGE") return "COVERAGE";
  if (routing.modeRestriction === "DEMO_ONLY") return "DEMO";
  if (routing.category === "A_BOOK") return "LP";
  return "DEALING";
}
