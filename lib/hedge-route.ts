import type { BookType, RoutingCategory } from "@prisma/client";

// Which way a client position is hedged (owner 2026-10-26). There are two routes and a position takes at most one:
//   LIQUIDITY_PROVIDER  an A-book group's position: every deal leaves a HedgeIntent row (lib/hedge.ts) that QoreBridge
//                       fills at the liquidity provider. Never the hedge account. (The value a broker reads: brokers
//                       never see bridge names.)
//   HEDGE_ACCOUNT   the broker's own book (B_BOOK / DEALING / REVERSAL groups): a leg on the broker's hedge (coverage)
//                   account, by hand (BOOK NOW / HEDGE ALL, any of these groups) or automatically on the fill (auto-hedge,
//                   DEALING groups only). Never QoreBridge.
//   NONE            the hedge account's own legs (COVERAGE), and any position whose two stamps disagree.
//
// The route is read from the position's own stamps, never the account's group today: groupCategoryAtOpen (the group's
// category when it opened, set by a DB trigger, what lib/hedge.ts keys QoreBridge on) and bookType (set by the order route
// from the same category). They are written apart, so a group changed mid-order can leave them disagreeing: category
// A_BOOK with bookType B_BOOK is still LIQUIDITY_PROVIDER (its intents are written), so the hedge account must refuse it. bookType
// A_BOOK under any other category is NONE: QoreBridge does not see it and the hedge account must not take it either.
// A position from before the category stamp (null) is judged by its bookType alone, as before.
// A position ON the broker's hedge account is a hedge leg, whatever its stamps say (owner 2026-10-26): its legs carry
// bookType A_BOOK, and an account sitting in an A-book group would otherwise send its legs to QoreBridge, hedging the
// hedge. `onHedgeAccount` (the account is Broker.coverageAccountId, or its group is COVERAGE) wins over everything.
export type HedgeRoute = "LIQUIDITY_PROVIDER" | "HEDGE_ACCOUNT" | "NONE";

export function hedgeRouteOf(position: { groupCategoryAtOpen: RoutingCategory | null; bookType: BookType; onHedgeAccount?: boolean }): HedgeRoute {
  if (position.onHedgeAccount) return "NONE";
  if (position.groupCategoryAtOpen === "A_BOOK") return "LIQUIDITY_PROVIDER";
  if (position.groupCategoryAtOpen === "COVERAGE" || position.bookType !== "B_BOOK") return "NONE";
  return "HEDGE_ACCOUNT";
}

/** The route a group's new positions take, for the Liquidity screen's line per group. */
export function hedgeRouteOfCategory(category: RoutingCategory): HedgeRoute {
  if (category === "A_BOOK") return "LIQUIDITY_PROVIDER";
  return category === "COVERAGE" ? "NONE" : "HEDGE_ACCOUNT";
}

/** Whether a fill is hedged automatically on the hedge account (auto-hedge, owner 2026-09-26: DEALING groups only). */
export function autoHedgesOnFill(category: RoutingCategory | null | undefined): boolean {
  return category === "DEALING";
}
