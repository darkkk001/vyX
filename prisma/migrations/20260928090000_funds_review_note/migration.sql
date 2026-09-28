-- Phase 2 batch 8 (issue 109): the reviewing admin's note on a deposit / withdrawal request gets its own column, so an
-- approve or reject never overwrites (or, with an empty note, erases) the trader's own request note. Additive only:
-- one nullable column, no existing value changes.
ALTER TABLE "Transaction" ADD COLUMN "reviewNote" TEXT;
