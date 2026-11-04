import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfigCoalescer, TRADER_HIDDEN_SCOPES } from "./config-coalesce.js";

// Live reference data (owner 2026-10-29): a burst of ConfigChanged events coalesces to one per broker and scope per second, the last change kept.
function fakeTimers() {
  let now = 0;
  const due: { at: number; fn: () => void }[] = [];
  return {
    timers: { now: () => now, setTimeout: (fn: () => void, ms: number) => { due.push({ at: now + ms, fn }); return 0; } },
    advance(ms: number) { now += ms; for (const d of due.splice(0).sort((a, b) => a.at - b.at)) { if (d.at <= now) d.fn(); else due.push(d); } },
  };
}

test("the first event goes at once, a burst inside the window becomes ONE trailing send of the newest", () => {
  const f = fakeTimers();
  const c = createConfigCoalescer(1000, f.timers);
  const sent: string[] = [];
  c("b1|symbols", () => sent.push("e1"));
  c("b1|symbols", () => sent.push("e2"));
  c("b1|symbols", () => sent.push("e3"));
  assert.deepEqual(sent, ["e1"]);
  f.advance(999);
  assert.deepEqual(sent, ["e1"]);
  f.advance(1);
  assert.deepEqual(sent, ["e1", "e3"]);
});

test("another broker or another scope is never held back", () => {
  const f = fakeTimers();
  const c = createConfigCoalescer(1000, f.timers);
  const sent: string[] = [];
  c("b1|symbols", () => sent.push("a"));
  c("b2|symbols", () => sent.push("b"));
  c("b1|groups", () => sent.push("c"));
  assert.deepEqual(sent, ["a", "b", "c"]);
});

test("after a quiet window the next event goes at once again", () => {
  const f = fakeTimers();
  const c = createConfigCoalescer(1000, f.timers);
  const sent: string[] = [];
  c("k", () => sent.push("1"));
  f.advance(1500);
  c("k", () => sent.push("2"));
  assert.deepEqual(sent, ["1", "2"]);
});

test("staff and LP changes are hidden from traders", () => {
  assert.ok(TRADER_HIDDEN_SCOPES.has("permissions"));
  assert.ok(TRADER_HIDDEN_SCOPES.has("lps"));
  assert.ok(!TRADER_HIDDEN_SCOPES.has("symbols"));
});
