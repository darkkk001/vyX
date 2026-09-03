-- Position.lastSwapAt: idempotency key for the daily swap rollover job
-- (lib/swap-rollover.ts) -- mirrors engine/order-management's own
-- positions.last_swap_at column and claim semantics exactly, on the
-- legacy Prisma-owned Position table. Nullable, no backfill needed: NULL
-- means "never charged," same as every existing OPEN position today.

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "lastSwapAt" TIMESTAMPTZ(3);
