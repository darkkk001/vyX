// The bulk close's selection is the one place in that route where a mistake is silent and expensive:
// nothing errors if "close my losing positions" closes the winning ones, the trader just finds out
// later. So every rule it applies is pinned here on a table, with no database and no engine.
//
// The cases are chosen for the mistakes that are actually available to make: classifying off the RAW
// tick instead of the account's marked price, re-sorting the basket, letting `positionIds` widen the
// selection instead of narrowing it, and dropping a position that could not be priced instead of
// reporting it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "decimal.js";
import { bulkErrorFor, rawPnl, selectBulkBasket, type BulkTarget, type Live } from "./bulk-select.js";

const D = (v: string | number) => new Decimal(v);

function pos(over: Partial<BulkTarget> & { id: string }): BulkTarget {
  return {
    side: "BUY",
    volume: D(1),
    openPrice: D(1000),
    closePendingOrderId: null,
    symbolName: "XAUUSD",
    digits: 2,
    contractSize: D(100),
    ...over,
  };
}

const prices = (m: Record<string, [number, number]>): Map<string, Live> =>
  new Map(Object.entries(m).map(([k, [bid, ask]]) => [k, { bid: D(bid), ask: D(ask) }]));

/** The real markup rule is client-ask.ts's; this stands in for it with a flat, visible offset so a test
 *  can state "the marked price differs from the raw tick" without re-testing the markup itself. */
const markedBy = (offset: number) => (p: BulkTarget, live: Live) =>
  p.side === "BUY" ? live.bid.sub(offset) : live.ask.add(offset);
const markedRaw = (p: BulkTarget, live: Live) => (p.side === "BUY" ? live.bid : live.ask);

test("ALL selects every open position and keeps the given order", () => {
  const open = [pos({ id: "c" }), pos({ id: "a" }), pos({ id: "b" })];
  const sel = selectBulkBasket(open, { scope: "ALL" }, prices({ XAUUSD: [1010, 1011] }), markedRaw);

  // the order is the SETTLE order -- each close's balanceBefore is the previous one's balanceAfter, and
  // negative-balance protection depends on which position is last, so re-sorting changes the ledger
  assert.deepEqual(sel.order, ["c", "a", "b"]);
  assert.deepEqual(
    sel.closable.map((c) => c.position.id),
    ["c", "a", "b"]
  );
  assert.deepEqual(sel.refusals, []);
});

test("SYMBOL selects only that symbol; side narrows within the scope", () => {
  const open = [
    pos({ id: "gold-buy", symbolName: "XAUUSD", side: "BUY" }),
    pos({ id: "gold-sell", symbolName: "XAUUSD", side: "SELL" }),
    pos({ id: "eur", symbolName: "EURUSD" }),
  ];
  const px = prices({ XAUUSD: [1010, 1011], EURUSD: [1.1, 1.1001] });

  const bySymbol = selectBulkBasket(open, { scope: "SYMBOL", symbol: "XAUUSD" }, px, markedRaw);
  assert.deepEqual(bySymbol.order, ["gold-buy", "gold-sell"]);

  const bySymbolAndSide = selectBulkBasket(open, { scope: "SYMBOL", symbol: "XAUUSD", side: "SELL" }, px, markedRaw);
  assert.deepEqual(bySymbolAndSide.order, ["gold-sell"]);

  const allSells = selectBulkBasket(open, { scope: "ALL", side: "SELL" }, px, markedRaw);
  assert.deepEqual(allSells.order, ["gold-sell"]);
});

test("positionIds narrows and cannot widen -- a foreign id selects nothing", () => {
  const open = [pos({ id: "mine-1" }), pos({ id: "mine-2" })];
  const px = prices({ XAUUSD: [1010, 1011] });

  const narrowed = selectBulkBasket(open, { scope: "ALL", positionIds: ["mine-2"] }, px, markedRaw);
  assert.deepEqual(narrowed.order, ["mine-2"]);

  // THE OWNERSHIP PROPERTY: the selection starts from this account's own open positions, so an id that
  // is not in that list cannot be added by asking for it. That is what makes this route unusable as a
  // probe for another account's position ids -- the answer is empty, not a refusal that confirms.
  const foreign = selectBulkBasket(open, { scope: "ALL", positionIds: ["someone-elses-position"] }, px, markedRaw);
  assert.deepEqual(foreign.order, []);
  assert.deepEqual(foreign.closable, []);
});

test("PROFIT / LOSS split both sides, with flat counting as profit", () => {
  // BUY opened at 1000: profitable when the close price is above it. SELL opened at 1000: profitable
  // below it. One snapshot, so one of each falls on each side.
  const open = [
    pos({ id: "buy-up", side: "BUY", openPrice: D(1000) }),
    pos({ id: "buy-down", side: "BUY", openPrice: D(1020) }),
    pos({ id: "sell-up", side: "SELL", openPrice: D(1000) }),
    pos({ id: "sell-down", side: "SELL", openPrice: D(1020) }),
    pos({ id: "flat", side: "BUY", openPrice: D(1010) }),
  ];
  const px = prices({ XAUUSD: [1010, 1010] }); // bid == ask, so BUY and SELL price the same

  const profit = selectBulkBasket(open, { scope: "PROFIT" }, px, markedRaw);
  assert.deepEqual(profit.order, ["buy-up", "sell-down", "flat"], "zero P&L is not a loss");

  const loss = selectBulkBasket(open, { scope: "LOSS" }, px, markedRaw);
  assert.deepEqual(loss.order, ["buy-down", "sell-up"]);

  // and the two are a partition of the positions that could be classified at all
  assert.equal(profit.order.length + loss.order.length, open.length);
});

test("PROFIT / LOSS classifies off the ACCOUNT'S marked price, not the raw tick", () => {
  // This is the mistake worth a test of its own, and it is the same one the single close route made in
  // its first cut: using the raw bid/ask instead of the account's marked price. A BUY opened at 1000
  // with a raw bid of 1001 is 1 point up; with a 2-point markup against it the account's bid is 999, so
  // the trader closing it REALIZES A LOSS. "Close profitable" must not select it.
  const open = [pos({ id: "marginal", side: "BUY", openPrice: D(1000) })];
  const px = prices({ XAUUSD: [1001, 1002] });

  const rawProfit = selectBulkBasket(open, { scope: "PROFIT" }, px, markedRaw);
  assert.deepEqual(rawProfit.order, ["marginal"], "at the raw bid it is up, so the fixture is meaningful");

  const markedProfit = selectBulkBasket(open, { scope: "PROFIT" }, px, markedBy(2));
  assert.deepEqual(markedProfit.order, [], "at the account's bid it is down -- not a profitable position");

  const markedLoss = selectBulkBasket(open, { scope: "LOSS" }, px, markedBy(2));
  assert.deepEqual(markedLoss.order, ["marginal"]);
});

test("a position with no fresh tick is reported, never dropped -- including under PROFIT / LOSS", () => {
  const open = [
    pos({ id: "priced", symbolName: "XAUUSD" }),
    pos({ id: "unpriced", symbolName: "USTEC" }),
  ];
  const px = prices({ XAUUSD: [1010, 1011] }); // USTEC absent: stale feed, or a closed session

  const all = selectBulkBasket(open, { scope: "ALL" }, px, markedRaw);
  assert.deepEqual(all.order, ["priced", "unpriced"]);
  assert.deepEqual(all.refusals, [{ positionId: "unpriced", error: "no live price" }]);
  assert.deepEqual(
    all.closable.map((c) => c.position.id),
    ["priced"],
    "an unpriced position must never be sent to the engine"
  );

  // Under PROFIT / LOSS it cannot be classified at all -- and must STILL come back with a reason. A
  // trader who asked to close their losers and sees nothing about a position has been told something
  // false about it.
  const loss = selectBulkBasket(open, { scope: "LOSS" }, px, markedRaw);
  assert.ok(loss.order.includes("unpriced"));
  assert.deepEqual(loss.refusals, [{ positionId: "unpriced", error: "no live price" }]);
});

test("a close already queued for the dealer is refused, not raced", () => {
  const open = [pos({ id: "free" }), pos({ id: "pending", closePendingOrderId: "order-77" })];
  const sel = selectBulkBasket(open, { scope: "ALL" }, prices({ XAUUSD: [1010, 1011] }), markedRaw);

  assert.deepEqual(sel.order, ["free", "pending"]);
  assert.deepEqual(sel.refusals, [{ positionId: "pending", error: "CLOSE_PENDING" }]);
  assert.deepEqual(
    sel.closable.map((c) => c.position.id),
    ["free"]
  );
});

test("order is exactly the refusals plus the closable, with no position counted twice", () => {
  // The route assembles its answer by walking `order` and looking each id up, so a position that is in
  // `order` but in neither list would answer "no answer", and one in both would be reported twice.
  const open = [
    pos({ id: "ok-1" }),
    pos({ id: "pending", closePendingOrderId: "o1" }),
    pos({ id: "unpriced", symbolName: "USTEC" }),
    pos({ id: "ok-2" }),
    pos({ id: "out-of-scope", symbolName: "EURUSD" }),
  ];
  const sel = selectBulkBasket(
    open,
    { scope: "SYMBOL", symbol: "XAUUSD" },
    prices({ XAUUSD: [1010, 1011], EURUSD: [1.1, 1.1001] }),
    markedRaw
  );

  const accounted = [...sel.refusals.map((r) => r.positionId), ...sel.closable.map((c) => c.position.id)];
  assert.deepEqual([...sel.order].sort(), [...accounted].sort());
  assert.equal(new Set(accounted).size, accounted.length, "no position may appear in both lists");
  assert.ok(!sel.order.includes("out-of-scope"), "a position outside the scope gets no result row at all");
  assert.ok(!sel.order.includes("unpriced"), "a different symbol is out of scope before it is priced");
});

test("rawPnl is the client's own screen formula: price diff x contract size x volume", () => {
  // 0.50 lots of a 100-contract symbol, BUY 1000 -> 1010 = 10 x 100 x 0.5
  const p = pos({ id: "x", side: "BUY", openPrice: D(1000), volume: D("0.5"), contractSize: D(100) });
  assert.equal(rawPnl(p, D(1010)).toString(), "500");
  // the SELL is the same magnitude with the sign flipped
  assert.equal(rawPnl({ ...p, side: "SELL" }, D(1010)).toString(), "-500");
});

test("engine statuses map to the error strings a client already handles", () => {
  assert.equal(bulkErrorFor("ALREADY_CLOSED"), "already closed");
  assert.equal(bulkErrorFor("NOT_OPEN"), "already closed");
  assert.equal(bulkErrorFor("NOT_FOUND"), "position not found");
  assert.equal(bulkErrorFor("NO_CONVERSION_RATE"), "NO_CONVERSION_RATE");
  // an unknown status passes through as itself rather than becoming a wrong-but-familiar string
  assert.equal(bulkErrorFor("SOMETHING_NEW"), "SOMETHING_NEW");
});
