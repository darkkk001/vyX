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
  /** Live cutover (owner 2026-11-11), DORMANT: the broker's engine-allowlist flag (Broker.engineLiveAllowlistOn). Missing = off. */
  engineLiveAllowlistOn?: boolean | null;
};

/** Live cutover (owner 2026-11-11): is this LIVE account engine-enabled through the allowlist? Exactly true for both the broker's flag
 *  (Broker.engineLiveAllowlistOn) and the account's entry (Account.engineLiveEnabled), and the account LIVE; anything missing, null or
 *  false = no. With the flag off or the list empty this is always false, which leaves every rule exactly as it was (the DEMO-only one).
 *  THE SAME RULE is engine/order-management/src/ingress.rs (mode_allowed) and authority.rs (RUST_OWNED_SQL); docs/ENGINE-LIVE-ALLOWLIST.md. */
export function engineLiveAllowed(broker: RiskAuthorityFields | null | undefined, accountMode: string | null | undefined, accountEngineLive: boolean | null | undefined): boolean {
  return accountMode === "LIVE" && broker?.engineLiveAllowlistOn === true && accountEngineLive === true;
}

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
export function riskOwnerOf(broker: RiskAuthorityFields | null | undefined, accountMode: string | null | undefined, accountEngineLive?: boolean | null): RiskOwner {
  if (!isRustAuthoritative(broker)) return "WEB";
  if (accountMode !== "DEMO" && accountMode !== "LIVE") return "WEB";
  const demoOnly = broker?.riskAuthorityDemoOnly !== false;
  // live cutover (dormant): a LIVE account explicitly on the allowlist of a broker whose flag is on also passes the demo-only scope
  return !demoOnly || accountMode === "DEMO" || engineLiveAllowed(broker, accountMode, accountEngineLive) ? "RUST" : "WEB";
}

/** The owner once the ENGINE'S LIVENESS is counted (the engine-down watchdog, docs/STAGE6-PLAN.md section 14): when the engine's heartbeat is stale
 *  (or there is none) the engine counts as down and nothing is RUST-owned, so every account falls back to WEB. `engineAlive` must be exactly true to
 *  keep an account with the engine. */
export function effectiveRiskOwner(broker: RiskAuthorityFields | null | undefined, accountMode: string | null | undefined, engineAlive: boolean | null | undefined, accountEngineLive?: boolean | null): RiskOwner {
  return engineAlive === true ? riskOwnerOf(broker, accountMode, accountEngineLive) : "WEB";
}
