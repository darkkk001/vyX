// Whether an A_BOOK group has a liquidity provider it can actually route orders to.
//
// Owner decision (2026-09-26, Phase 2 batch 2): until an LP is connected, an A_BOOK group takes no accounts
// (lib/account-structure.ts, app/api/portal/groups). Orders no longer ask (QoreBridge M5, fill first then hedge:
// lib/dealing-routing.ts fills A_BOOK and lib/hedge.ts leaves the intent); whether accounts may join an A_BOOK group
// with hedging pending is open question 11 of docs/qorebridge/00-current-state.md, so this stays NO for now.
export function isLpConnected(_group?: { category?: string } | null): boolean {
  return false;
}
