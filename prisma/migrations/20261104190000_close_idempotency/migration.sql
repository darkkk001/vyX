-- CLOSE IDEMPOTENCY: the client's own key on the close's ledger row.
--
-- THE GAP THIS FILLS. The OPEN path got this in 20261103210000: the client's key goes into
-- "Order".idempotencyKey, UNIQUE (accountId, idempotencyKey) makes a second fill of the same key
-- impossible, and a LOST ANSWER becomes a lookup -- the caller asks "did my open land?" by key and gets
-- the committed order back. A CLOSE has no equivalent, here or in the web: the web's close route uses
-- `idempotencyKey` only on its dealer-queue branch, where queueCloseInTx writes an "Order" row and that
-- same unique index applies. A direct close (every demo close, and every engine close) writes no Order
-- row at all, so its only protection is the engine's compare-and-set -- `close_position_full`'s UPDATE
-- requires `status = OPEN AND volume = expected`. That genuinely stops a DOUBLE close. It does nothing
-- for a lost answer: the caller cannot tell "closed, answer lost" from "never arrived", which is the
-- exact ambiguity the open path's key exists to remove.
--
-- WHY THE LEDGER ROW IS THE RIGHT ARTEFACT. A close's durable, one-per-close record is its TRADE_PNL
-- "Transaction" (referenceType 'Position', referenceId = the position), written inside the close's own
-- transaction next to the OUT "Deal". Keying that row means the constraint and the close commit or roll
-- back together -- the same property that makes the open path's guarantee a constraint rather than an
-- agreement between two services.
--
-- The alternative considered and rejected: write a closing "Order" row (as the dealer-queue branch does)
-- and reuse the existing unique index, needing no migration at all. Rejected because it would put an
-- extra FILLED order in every client's order history for every close -- a visible change to what
-- /api/trade/orders returns, to fix something invisible.
--
-- NULLABLE, AND WHY A PLAIN UNIQUE INDEX IS ENOUGH. Every one of the 7,969 existing rows, and every
-- transaction that is not a keyed close (deposits, swaps, commissions, adjustments), carries NULL.
-- Postgres treats NULLs as DISTINCT in a unique index, so any number of them coexist; only two real
-- keys can collide. No partial index, no backfill, and `@@unique` in schema.prisma says exactly this --
-- so the schema and the database do not drift.
--
-- ADDITIVE AND SAFE TO LAND EARLY: nothing writes the column until an engine build does, and an engine
-- that does not know about it keeps working unchanged.

ALTER TABLE "Transaction" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Transaction_accountId_idempotencyKey_key"
  ON "Transaction"("accountId", "idempotencyKey");
