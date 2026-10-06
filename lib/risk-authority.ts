// Rust cutover Stage 6: who acts on an account's risk (SL / TP, stop-out, margin call, resting-order triggers).
//
// Pure helpers on the Broker fields. WEB is the fallback for anything missing or unrecognised, so a broker row read
// before the migration, a partial select, or a future enum value never hands risk to the engine by accident.
//
// THE rule, in three places that must agree: this file, engine/order-management/src/authority.rs (risk_owner_of and its
// SQL form RUST_OWNED_SQL). lib/risk-authority-cases.json is the case matrix both implementations are tested on
// (scripts/stage6/gen-risk-authority-cases.mjs writes it). The DB side (who may act, checked inside the acting
// transaction) is lib/risk-owner.ts.

export type RiskOwner = "WEB" | "RUST";

export type RiskAuthorityFields = {
  riskAuthority?: string | null;
  riskAuthorityDemoOnly?: boolean | null;
};

/** The broker's authority, WEB unless it is exactly "RUST". */
export function getRiskAuthority(broker: RiskAuthorityFields | null | undefined): RiskOwner {
  return broker?.riskAuthority === "RUST" ? "RUST" : "WEB";
}

/** True when the broker's authority is RUST (ignoring the demo-only scope). */
export function isRustAuthoritative(broker: RiskAuthorityFields | null | undefined): boolean {
  return getRiskAuthority(broker) === "RUST";
}

/** Per-account owner: RUST only when the broker is RUST AND the account mode is a known one AND (the broker is not
 *  demo-only, or the account is DEMO). A missing demo-only value counts as demo-only (the safer, narrower scope); a
 *  missing or unknown account mode is WEB. */
export function riskOwnerOf(broker: RiskAuthorityFields | null | undefined, accountMode: string | null | undefined): RiskOwner {
  if (!isRustAuthoritative(broker)) return "WEB";
  if (accountMode !== "DEMO" && accountMode !== "LIVE") return "WEB";
  const demoOnly = broker?.riskAuthorityDemoOnly !== false;
  return !demoOnly || accountMode === "DEMO" ? "RUST" : "WEB";
}

/** The owner once the ENGINE'S LIVENESS is counted (the engine-down watchdog, docs/STAGE6-PLAN.md section 14): when the engine's heartbeat is stale
 *  (or there is none) the engine counts as down and nothing is RUST-owned, so every account falls back to WEB. `engineAlive` must be exactly true to
 *  keep an account with the engine. */
export function effectiveRiskOwner(broker: RiskAuthorityFields | null | undefined, accountMode: string | null | undefined, engineAlive: boolean | null | undefined): RiskOwner {
  return engineAlive === true ? riskOwnerOf(broker, accountMode) : "WEB";
}
