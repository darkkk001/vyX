import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimitOrders, rateLimitStats, checkRateLimitLocal } from "./rate-limit.js";

// The close route used to share the opens' budget (both called rateLimitOrders(30, 60), both keying
// `order:<accountId>`), so a basket of opens followed by its closes spent one 30-request allowance twice
// and the tail of the closes was refused. These tests pin the two properties that fix depends on:
// different bucket names are genuinely independent allowances, and the default name is still "order" so
// no existing call site silently changed budget.

type Captured = { status: number | null; body: unknown; headers: Record<string, string>; nexted: boolean };

function run(mw: ReturnType<typeof rateLimitOrders>, accountId: string): Promise<Captured> {
  const cap: Captured = { status: null, body: null, headers: {}, nexted: false };
  const req = {
    session: { accountId },
    method: "POST",
    originalUrl: "/v1/positions/abc/close",
    headers: {},
  } as never;
  const res = {
    statusCode: 200,
    setHeader(k: string, v: string) {
      cap.headers[k] = v;
    },
    status(code: number) {
      cap.status = code;
      return {
        json(payload: unknown) {
          cap.body = payload;
        },
      };
    },
  } as never;
  return Promise.resolve(mw(req, res, () => void (cap.nexted = true))).then(() => cap);
}

test("two bucket names are independent budgets", async () => {
  const acct = "acct-independent-1";
  const opens = rateLimitOrders(2, 60, "order");
  const closes = rateLimitOrders(2, 60, "close");

  // spend the whole opens allowance
  assert.equal((await run(opens, acct)).nexted, true);
  assert.equal((await run(opens, acct)).nexted, true);
  const refusedOpen = await run(opens, acct);
  assert.equal(refusedOpen.nexted, false);
  assert.equal(refusedOpen.status, 429);

  // closes must be untouched by that -- this is the whole point of the change
  const firstClose = await run(closes, acct);
  assert.equal(firstClose.nexted, true, "a close must not be refused because opens exhausted their budget");
  assert.equal((await run(closes, acct)).nexted, true);
});

test("the default bucket is still 'order', so existing call sites keep their key", () => {
  const acct = "acct-default-bucket";
  // consume the "order" bucket directly, then assert the defaulted middleware sees the same bucket
  assert.equal(checkRateLimitLocal(`order:${acct}`, 1, 60).allowed, true);
  const again = checkRateLimitLocal(`order:${acct}`, 1, 60);
  assert.equal(again.allowed, false, "same key, limit 1, second call refused");
});

test("a refused request is counted per bucket in rateLimitStats", async () => {
  const before = rateLimitStats().rateLimited;
  const beforeTotal = before.total;
  const beforeBucket = before.byBucket["unit-test-bucket"] ?? 0;

  const acct = "acct-counter-1";
  const mw = rateLimitOrders(1, 60, "unit-test-bucket");
  assert.equal((await run(mw, acct)).nexted, true);
  const refused = await run(mw, acct);
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.body, { error: "too many order requests, slow down" });

  const after = rateLimitStats().rateLimited;
  assert.equal(after.byBucket["unit-test-bucket"], beforeBucket + 1, "the bucket's own counter advanced by one");
  assert.equal(after.total, beforeTotal + 1, "the total advanced by one");
});

test("the remaining header is set on both the allowed and the refused answer", async () => {
  const acct = "acct-header-1";
  const mw = rateLimitOrders(1, 60, "header-bucket");
  const ok = await run(mw, acct);
  assert.equal(ok.headers["X-RateLimit-Remaining"], "0");
  const refused = await run(mw, acct);
  assert.equal(refused.headers["X-RateLimit-Remaining"], "0");
  assert.equal(refused.status, 429);
});

test("no session falls through rather than refusing (requireTraderSession already 401'd)", async () => {
  const mw = rateLimitOrders(0, 60, "nosession-bucket");
  const cap: { nexted: boolean } = { nexted: false };
  const req = { session: undefined, method: "POST", originalUrl: "/x", headers: {} } as never;
  const res = { statusCode: 200, setHeader() {}, status() { return { json() {} }; } } as never;
  await Promise.resolve(mw(req, res, () => void (cap.nexted = true)));
  assert.equal(cap.nexted, true);
});

test("the close budget is large enough for a realistic bulk close", async () => {
  const acct = "acct-bulk-close";
  const closes = rateLimitOrders(600, 60, "close-bulk");
  // 60 closes in one basket -- far more than a trader holds open, and well inside the budget
  for (let i = 0; i < 60; i += 1) {
    const r = await run(closes, acct);
    assert.equal(r.nexted, true, `close ${i + 1} of 60 must not be refused`);
  }
});
