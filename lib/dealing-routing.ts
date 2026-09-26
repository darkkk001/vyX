import type { RoutingCategory } from "@prisma/client";
import { isLpConnected } from "@/lib/liquidity";

// Where a client's order goes: ONE rule, by the group's routing CATEGORY (owner decision 2026-09-26, Phase 2 batch 2).
// Every open and close path asks this: app/api/trade/orders (MARKET), the pending-order trigger (lib/pending-trigger.ts),
// the client close / close-by / close-bulk (lib/queued-close.ts), the desk-switch flush
// (app/api/manage/dealing-desk-toggle), and "is this account dealer-managed right now" for the dealer activity feed.
//
//   B_BOOK       auto-fill, never queued
//   DEALING      queued for the dealer while the desk is ON (Broker.dealingDeskAutoFillAt null), auto-filled while it
//                is OFF -- unless the group's "Always send to dealer" option (Group.forceDealingMode) is set: then
//                queued even with the desk off. That option exists for DEALING groups only.
//   REVERSAL     auto-fill; the copy rule (lib/mirror.ts) mirrors it
//   A_BOOK       bridged to a liquidity provider: until one is connected (lib/liquidity.ts) orders are REFUSED
//   COVERAGE     system (the broker's own hedge account): client orders never route here
//
// Retired (owner, same date): Group.dealingMode (MANUAL / AUTO / INHERIT), Group.forceDealingMode on any category but
// DEALING, and the broker-wide Broker.dealingModeAt. The columns stay; nothing routes on them any more. Before this,
// routing read the legacy Group.groupType, which is "DEALING" for B_BOOK and DEALING alike, so choosing between them
// changed nothing.

export type RoutingGroup = { category: RoutingCategory; forceDealingMode: boolean };
export type OrderRoute = "FILL" | "QUEUE" | "NO_LP" | "SYSTEM";

// `error` is the sentence a client shows as-is; `code` is what a client keys on (the same { error, code } shape the
// volume refusals use).
export const LP_NOT_CONNECTED = {
  error: "Orders can't be placed yet: this account's group is routed to a liquidity provider and none is connected. Contact your broker.",
  code: "LP_NOT_CONNECTED",
} as const;
export const SYSTEM_ACCOUNT_ORDER = {
  error: "This is the broker's system coverage account; client orders can't be placed on it.",
  code: "SYSTEM_ACCOUNT",
} as const;

/** `deskOn` = the dealer desk is ON (Broker.dealingDeskAutoFillAt == null). A missing group routes like B_BOOK. */
export function orderRoute(group: RoutingGroup | null | undefined, deskOn: boolean): OrderRoute {
  switch (group?.category ?? "B_BOOK") {
    case "DEALING":
      return deskOn || !!group?.forceDealingMode ? "QUEUE" : "FILL";
    case "A_BOOK":
      return isLpConnected(group) ? "FILL" : "NO_LP";
    case "COVERAGE":
      return "SYSTEM";
    default:
      return "FILL"; // B_BOOK, REVERSAL
  }
}

/** The broker row's dealer-desk switch, as the routing rule reads it. */
export function deskIsOn(broker: { dealingDeskAutoFillAt: Date | null } | null | undefined): boolean {
  return broker != null && broker.dealingDeskAutoFillAt == null;
}

/** Does an order (open, or a client's close) from this group wait for a dealer? */
export function resolveWantsDealingQueue(params: { group: RoutingGroup | null | undefined; deskOn: boolean }): boolean {
  return orderRoute(params.group, params.deskOn) === "QUEUE";
}

/** "Is this account dealer-managed right now" -- the dealer-awareness feed's definition (lib/dealer-activity.ts). */
export function isDealingManagedAccount(params: { group: RoutingGroup | null | undefined; deskOn: boolean }): boolean {
  return resolveWantsDealingQueue(params);
}
