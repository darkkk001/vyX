// Rust cutover Stage 6: who acts on an account's risk (SL / TP, stop-out, margin call).
//
// Pure helpers on the Broker fields. WEB is the fallback for anything missing or unrecognised, so a broker row read
// before the migration, a partial select, or a future enum value never hands risk to the engine by accident.
// Not wired into any evaluator yet.

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

/** Per-account owner: RUST only when the broker is RUST AND (not demo-only, or the account is DEMO).
 *  A missing demo-only value counts as demo-only (the safer, narrower scope). */
export function riskOwnerOf(broker: RiskAuthorityFields | null | undefined, accountMode: "DEMO" | "LIVE"): RiskOwner {
  if (!isRustAuthoritative(broker)) return "WEB";
  const demoOnly = broker?.riskAuthorityDemoOnly !== false;
  return !demoOnly || accountMode === "DEMO" ? "RUST" : "WEB";
}
