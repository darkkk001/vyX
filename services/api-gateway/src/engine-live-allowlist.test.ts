// THE LIVE-CUTOVER ALLOWLIST in the gateway, against the SHARED case matrix.
//
// lib/engine-live-allowlist-cases.json -- the same 324 cases the web (lib/engine-live-allowlist.test.ts)
// and the engine (order-management/tests/engine_live_allowlist.rs) are tested on, read by the same
// repo-relative path. Three implementations of one rule; one table that none of them owns.
// See docs/ENGINE-LIVE-ALLOWLIST.md.
//
// DORMANT: both columns default false, so engineIngressVerdict below is the old DEMO-only rule for
// every account in the database today, and the dormancy test proves that against the old rule verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { engineIngressVerdict, engineLiveAllowed } from "./routes/orders.js";

type Case = {
  riskAuthority: string | null;
  riskAuthorityDemoOnly: boolean | null;
  engineLiveAllowlistOn: boolean | null;
  accountMode: string | null;
  engineLiveEnabled: boolean | null;
  modeAllowed: boolean;
  owner: string;
};

const cases: Case[] = JSON.parse(
  readFileSync(new URL("../../../lib/engine-live-allowlist-cases.json", import.meta.url), "utf-8")
);
const ID = "the-account";
const LIST = [ID];

test("every shared case: the gateway admits exactly what the web and engine admit", () => {
  assert.equal(cases.length, 324, "the shared matrix changed: re-read it rather than quietly covering less");
  let allowed = 0;
  for (const [i, c] of cases.entries()) {
    const mode = c.accountMode ?? "";
    const v = engineIngressVerdict(ID, mode, LIST, c.engineLiveAllowlistOn === true, c.engineLiveEnabled === true);
    assert.equal(v.ok, c.modeAllowed,
      `case ${i}: mode=${mode} flag=${c.engineLiveAllowlistOn} entry=${c.engineLiveEnabled} -> ok=${v.ok}, the web says ${c.modeAllowed}`);
    if (c.modeAllowed) allowed++;
  }
  assert.ok(allowed > 0 && allowed < cases.length, `modeAllowed is constant across the matrix (${allowed}/${cases.length})`);
});

test("dormant: flag off, entry off, or not LIVE is byte-for-byte the old rule", () => {
  // verbatim from before the cutover (5aadf1df)
  const oldRule = (accountId: string, accountMode: string, list: string[]) => {
    if (list.length === 0) return false;
    if (!list.includes(accountId)) return false;
    if (accountMode !== "DEMO") return false;
    return true;
  };
  let checked = 0, differ = 0;
  for (const c of cases) {
    const mode = c.accountMode ?? "";
    const flag = c.engineLiveAllowlistOn === true, entry = c.engineLiveEnabled === true;
    const now = engineIngressVerdict(ID, mode, LIST, flag, entry).ok;
    const was = oldRule(ID, mode, LIST);
    if (!flag || !entry || mode !== "LIVE") { assert.equal(now, was, `flag=${flag} entry=${entry} mode=${mode}: changed while dormant`); checked++; }
    else if (now !== was) differ++;
  }
  assert.ok(checked > 250, `expected most of the matrix to be dormant, got ${checked}`);
  assert.ok(differ > 0, "the allowlist changes nothing even when fully on -- the rule is not wired");
});

test("a caller that passes no flags gets exactly the old rule (the defaults are false)", () => {
  assert.equal(engineIngressVerdict(ID, "DEMO", LIST).ok, true);
  assert.equal(engineIngressVerdict(ID, "LIVE", LIST).ok, false, "LIVE with no flags is refused, as it always was");
  assert.equal(engineIngressVerdict("someone-else", "DEMO", LIST).ok, false, "off the list is still refused");
  assert.equal(engineIngressVerdict(ID, "DEMO", []).ok, false, "an empty list is still 'nobody'");
});

test("the env list alone never admits a LIVE account", () => {
  assert.equal(engineIngressVerdict(ID, "LIVE", LIST, false, false).ok, false, "on the list, flag off, no entry");
  assert.equal(engineIngressVerdict(ID, "LIVE", LIST, true, false).ok, false, "flag on, no entry");
  assert.equal(engineIngressVerdict(ID, "LIVE", LIST, false, true).ok, false, "entry on, flag off");
  assert.equal(engineIngressVerdict(ID, "LIVE", LIST, true, true).ok, true, "both on -- the feature");
  assert.equal(engineLiveAllowed("DEMO", true, true), false, "a DEMO account is never 'live allowed'");
});

// ---- the scope is the list OR the columns (owner 2026-11-13) --------------------------------------
//
// Before this, an allowlisted LIVE account ALSO had to be pasted into ENGINE_INGRESS_ACCOUNT_IDS to be
// in scope. The env list stays the DEMO trial scope; live accounts are enrolled by the two columns.

test("an allowlisted LIVE account is in scope without being on the env list", () => {
  const demoOnlyList = ["demo-1"];
  const v = engineIngressVerdict("live-x", "LIVE", demoOnlyList, true, true);
  assert.equal(v.ok, true, v.ok ? "" : v.why);
});

test("the env list still works, and still admits nothing it does not name", () => {
  const list = ["demo-1"];
  assert.equal(engineIngressVerdict("demo-1", "DEMO", list, false, false).ok, true);
  assert.equal(engineIngressVerdict("demo-2", "DEMO", list, false, false).ok, false);
});

test("DORMANT: with both columns false the scope check is exactly the old membership test", () => {
  const list = ["demo-1"];
  for (const [id, mode] of [["demo-1", "DEMO"], ["demo-2", "DEMO"], ["live-x", "LIVE"], ["live-y", "LIVE"]] as const) {
    const now = engineIngressVerdict(id, mode, list, false, false).ok;
    const old = list.includes(id) && mode === "DEMO";
    assert.equal(now, old, `${id}/${mode}: widening must change nothing while nothing is enabled`);
  }
});

test("every half of the rule is required for an off-list LIVE account", () => {
  const list = ["demo-1"];
  assert.equal(engineIngressVerdict("live-x", "LIVE", list, true, false).ok, false, "broker on, account off");
  assert.equal(engineIngressVerdict("live-x", "LIVE", list, false, true).ok, false, "account on, broker off");
  assert.equal(engineIngressVerdict("live-x", "LIVE", list, false, false).ok, false, "neither");
  assert.equal(engineIngressVerdict("live-x", "LIVE", list, true, true).ok, true, "both");
});

test("widening the scope does not let the env list admit a LIVE account", () => {
  // the L2 Step 3 finding: a live id pasted onto the list is IN SCOPE by that paste, and must still be
  // refused by the DEMO-only rule, because its columns are false
  const pasted = ["live-pasted"];
  const v = engineIngressVerdict("live-pasted", "LIVE", pasted, false, false);
  assert.equal(v.ok, false);
  assert.match(v.ok ? "" : v.why, /DEMO accounts only/);
});
