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
