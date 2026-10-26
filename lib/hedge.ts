import "server-only";
import { after } from "next/server";
import { Prisma, type BookType, type Deal, type OrderSide, type RoutingCategory } from "@prisma/client";
import { hedgeRouteOf } from "@/lib/hedge-route";
import { publishBridgeNudge } from "@/lib/nats";

type Tx = Prisma.TransactionClient;

// QoreBridge M5 (docs/qorebridge/00-current-state.md, "Integration points" and "Close-side hooks"): fill first, then
// hedge. The client is filled exactly as before; every deal on an A-book position also leaves one HedgeIntent row,
// written in the deal's own transaction (a committed deal always has its intent, a rolled-back one never does).
// QoreBridge claims the rows and hedges them at the LP; nothing here waits for it.
//
// The web is the only writer of intents. Every web open goes through writeOpenDealInTx and every web close through
// closePositionInTx, so those two (plus the reverse-in-place flip, the void of an open position and the engine-close
// step of lib/post-close.ts) are the only callers.
//
// A-book = the position's OWN copy of its group's category at open (Position.groupCategoryAtOpen, stamped by a DB
// trigger), never the account's current group: moving an account between groups never hedges or un-hedges open
// positions, and COVERAGE legs (bookType A_BOOK too) are the broker's own cover, not client flow, so they never hedge.

export type HedgeDeal = Pick<Deal, "id" | "brokerId" | "accountId" | "positionId" | "side" | "entry" | "reason" | "volume" | "price">;

export function isHedgedCategory(category: RoutingCategory | null | undefined): boolean {
  return category === "A_BOOK";
}

// what hedgeRouteOf needs from a position, read in the same query as the intent's own fields
const HEDGE_ROUTE_SELECT = { groupCategoryAtOpen: true, bookType: true, accountId: true, broker: { select: { coverageAccountId: true } } } as const;
type RouteRow = { groupCategoryAtOpen: RoutingCategory | null; bookType: BookType; accountId: string; broker: { coverageAccountId: string | null }; account: { group: { category: RoutingCategory } | null } };
const routeOf = (p: RouteRow) =>
  hedgeRouteOf({ groupCategoryAtOpen: p.groupCategoryAtOpen, bookType: p.bookType, onHedgeAccount: p.accountId === p.broker.coverageAccountId || p.account.group?.category === "COVERAGE" });

/** One intent for a deal just written in this transaction, when its position is A-book client flow. `categoryAtOpen`
 *  is the position's groupCategoryAtOpen when the caller already read it: anything but A_BOOK returns at once, so a
 *  B-book deal costs no query. Idempotent per deal (dealId is unique). Returns whether an intent was written. */
export async function hedgeDealInTx(tx: Tx, deal: HedgeDeal, categoryAtOpen?: RoutingCategory | null): Promise<boolean> {
  if (categoryAtOpen !== undefined && !isHedgedCategory(categoryAtOpen)) return false;
  // a hedge leg is never hedged again (lib/hedge-route.ts), whichever group its account sits in
  if (deal.reason === "COVERAGE") return false;
  const position = await tx.position.findUniqueOrThrow({
    where: { id: deal.positionId },
    select: { ...HEDGE_ROUTE_SELECT, account: { select: { groupId: true, group: { select: { category: true } } } }, symbol: { select: { name: true } } },
  });
  if (routeOf(position) !== "LIQUIDITY_PROVIDER") return false;
  // INOUT is reserved for netting accounts, which no A-book group has: refuse loudly rather than hedge the wrong way
  if (deal.entry === "INOUT") throw new Error(`hedge: INOUT deal ${deal.id} on an A-book position is not supported`);
  const written = await tx.hedgeIntent.createMany({
    data: [
      {
        brokerId: deal.brokerId,
        accountId: deal.accountId,
        positionId: deal.positionId,
        dealId: deal.id,
        groupId: position.account.groupId,
        symbol: position.symbol.name,
        side: deal.side,
        volume: deal.volume,
        clientPrice: deal.price,
        kind: deal.entry === "IN" ? "OPEN" : "CLOSE",
        reason: deal.reason,
      },
    ],
    skipDuplicates: true,
  });
  if (written.count > 0) scheduleBridgeNudge(deal.brokerId);
  return written.count > 0;
}

/** An OPEN A-book position voided (it disappears as if it never existed): its hedge comes off, a VOID intent on the
 *  opposite side for the volume still open. Call it after the void claimed the row (the claim makes it once). Voiding
 *  a CLOSED trade needs no hedge action: the hedge was reduced when it closed. */
export async function hedgeVoidInTx(tx: Tx, position: { id: string; brokerId: string; accountId: string; side: OrderSide; volume: Prisma.Decimal }): Promise<boolean> {
  const p = await tx.position.findUniqueOrThrow({
    where: { id: position.id },
    select: { ...HEDGE_ROUTE_SELECT, account: { select: { groupId: true, group: { select: { category: true } } } }, symbol: { select: { name: true } } },
  });
  if (routeOf(p) !== "LIQUIDITY_PROVIDER") return false;
  await tx.hedgeIntent.create({
    data: {
      brokerId: position.brokerId,
      accountId: position.accountId,
      positionId: position.id,
      dealId: null,
      groupId: p.account.groupId,
      symbol: p.symbol.name,
      side: position.side === "BUY" ? "SELL" : "BUY",
      volume: position.volume,
      clientPrice: null,
      kind: "VOID",
      reason: null,
    },
  });
  scheduleBridgeNudge(position.brokerId);
  return true;
}

// The wake-up goes out after the response (next/server `after`), i.e. after the request's transaction committed, so the
// bridge never claims before the row is visible. A rolled-back transaction leaves one harmless extra nudge (the bridge
// polls and finds nothing). Outside a request (tests, scripts) there is no nudge: the bridge's poll finds the row.
// Several intents of one request (a bulk close) wake the bridge once.
const lastNudge = new Map<string, number>();
const NUDGE_DEDUPE_MS = 20;

export function scheduleBridgeNudge(brokerId: string): void {
  try {
    after(async () => {
      const now = Date.now();
      if (now - (lastNudge.get(brokerId) ?? 0) < NUDGE_DEDUPE_MS) return;
      lastNudge.set(brokerId, now);
      await publishBridgeNudge(brokerId);
    });
  } catch {
    // no request scope
  }
}
