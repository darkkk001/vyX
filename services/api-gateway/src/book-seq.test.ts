// node --import tsx --test src/*.test.ts   (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBookSubject, newBookSeqState, stampBookEvent, BOOK_SEQ_SUBJECT } from "./book-seq.js";

test("book subjects are order.* / position.* / account.* / config.changed only", () => {
  for (const s of ["order.filled", "order.cancelled", "position.modified", "position.closed_bulk", "account.balance", "account.updated", "config.changed"]) {
    assert.equal(isBookSubject(s), true, s);
  }
  for (const s of ["dealing.queued", "dealing.activity", "margin.call", "price.tick.XAUUSD", "cfg.alerts.b1", "config.other", "orders.x"]) {
    assert.equal(isBookSubject(s), false, s);
  }
});

test("book events get the gateway's epoch and a +1 sequence; the rest of the payload is unchanged", () => {
  const st = newBookSeqState();
  const a = stampBookEvent(st, "position.modified", { type: "PositionModified", position_id: "p1", broker_id: "b1" });
  const b = stampBookEvent(st, "order.filled", { type: "OrderFilled", order_id: "o1", broker_id: "b1", price: "4300.12" });
  assert.deepEqual(a.payload, { type: "PositionModified", position_id: "p1", broker_id: "b1", book_epoch: st.epoch, book_seq: 1 });
  assert.deepEqual(b.payload, { type: "OrderFilled", order_id: "o1", broker_id: "b1", price: "4300.12", book_epoch: st.epoch, book_seq: 2 });
  assert.deepEqual(a.marker, { book_epoch: st.epoch, book_seq: 1, subject: "position.modified" });
  assert.deepEqual(b.marker, { book_epoch: st.epoch, book_seq: 2, subject: "order.filled" });
  assert.equal(BOOK_SEQ_SUBJECT, "book.seq");
});

test("other subjects pass through untouched and do not advance the sequence", () => {
  const st = newBookSeqState();
  const payload = { type: "DealingQueued", order_id: "o1", broker_id: "b1" };
  const r = stampBookEvent(st, "dealing.queued", payload);
  assert.equal(r.payload, payload, "the very same object");
  assert.equal(r.marker, null);
  assert.equal(stampBookEvent(st, "margin.call", { type: "MarginCall", broker_id: "b1" }).marker, null);
  assert.equal(stampBookEvent(st, "account.balance", { type: "BalanceChanged", broker_id: "b1" }).marker?.book_seq, 1, "the first book event is 1");
});

test("each gateway boot has its own epoch", () => {
  assert.notEqual(newBookSeqState().epoch, newBookSeqState().epoch);
});
