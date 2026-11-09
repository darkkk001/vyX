// L2 Step 3 — the ingress scope is the ONLY thing standing between the engine's order path and a live
// account, so it is proved here rather than asserted in a comment.
//
// Why it is the only thing: the engine connects to Neon as `neondb_owner`, so the Stage 7 privilege
// check (`verify_order_path_pool`) passes on ownership alone -- it cannot refuse a live account. The
// account-level scoping is the boundary.
//
// These are the gateway's half (layer 1 of three). The engine repeats both conditions itself
// (order_management::ingress, with its own tests) and `main.rs` refuses to start the order half at all
// without a list, which is where the fail-closed decision lives.

import assert from "node:assert/strict";
import { test } from "node:test";

import { engineIngressVerdict } from "./routes/orders.js";

const DEMO = "cmvzzzovp000nl208tujjh7l4"; // Futurix 50005725, the designated DEMO account
const LIVE = "cmv7liveaccountidexample";

test("an unset or empty allow-list allows NOBODY", () => {
  // the whole point of fail-closed: a deploy that forgets the variable turns ingress OFF.
  // The second case is a variable set to blanks, parsed the way production parses it (trim, then drop
  // the empties) -- `.filter(Boolean)` alone would keep "  ", which is why the trim is not optional.
  const asProductionParses = (raw: string) => raw.split(",").map((x) => x.trim()).filter(Boolean);
  for (const list of [[], asProductionParses(""), asProductionParses("  ,  ")]) {
    const v = engineIngressVerdict(DEMO, "DEMO", list);
    assert.equal(v.ok, false);
    assert.match((v as { why: string }).why, /not enabled/);
  }
});

test("only the designated account passes", () => {
  assert.equal(engineIngressVerdict(DEMO, "DEMO", [DEMO]).ok, true);

  const other = engineIngressVerdict(LIVE, "DEMO", [DEMO]);
  assert.equal(other.ok, false, "an account absent from the list must be refused");
  assert.match((other as { why: string }).why, /not served/);

  // no prefix / suffix near-miss slips through
  assert.equal(engineIngressVerdict(DEMO + "x", "DEMO", [DEMO]).ok, false);
  assert.equal(engineIngressVerdict(DEMO.slice(0, -1), "DEMO", [DEMO]).ok, false);
  assert.equal(engineIngressVerdict("", "DEMO", [DEMO]).ok, false);
});

test("a LIVE account on the list is STILL refused", () => {
  // the list is a human artefact; accountMode comes from the database. This is the condition that
  // holds when someone pastes the wrong id, which is the realistic failure -- not a forged request.
  for (const mode of ["LIVE", "live", "", "DEMO_SANDBOX", "Demo"]) {
    const v = engineIngressVerdict(LIVE, mode, [LIVE]);
    assert.equal(v.ok, false, `accountMode ${JSON.stringify(mode)} must not pass`);
    assert.match((v as { why: string }).why, /DEMO accounts only/);
  }
  // and the designated account itself, if it were ever switched to live, stops being served
  assert.equal(engineIngressVerdict(DEMO, "LIVE", [DEMO]).ok, false);
});

test("both conditions are required, in either order of failure", () => {
  // absent from the list AND live: refused, and the reason names the list first (the cheaper check)
  const v = engineIngressVerdict(LIVE, "LIVE", [DEMO]);
  assert.equal(v.ok, false);
  assert.match((v as { why: string }).why, /not served/);
});
