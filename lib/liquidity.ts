// Whether an A_BOOK group has a liquidity provider it can actually route orders to.
//
// No LP bridge exists yet (LiquidityProvider rows are contact / pipeline records; LpRoutingRule is stored but never
// read, see docs/audit/2026-09-24 LP/ROUTE lines), so the answer is always NO. Owner decision (2026-09-26, Phase 2
// batch 2): until an LP is connected, an A_BOOK group takes no accounts (lib/account-structure.ts) and no orders
// (lib/dealing-routing.ts orderRoute -> NO_LP). When the bridge is built, this is the one place that learns the
// group's connection state.
export function isLpConnected(_group?: { category?: string } | null): boolean {
  return false;
}
