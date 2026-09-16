-- Dealer coverage: a system group type for the broker's B-book hedge
-- (coverage) account. Books A_BOOK (see lib/group-pricing.ts's
-- resolveBookType). Kept in its own migration, applied before anything
-- can reference the value: Postgres forbids USING a new enum value in the
-- same transaction that adds it, and Prisma runs each migration in one
-- transaction -- so the ADD VALUE lands and commits here, and the coverage
-- provisioning code (a later, separate request at runtime) is free to use
-- it. Hand-written (never `prisma migrate dev` on this DB).

-- AlterEnum
ALTER TYPE "GroupType" ADD VALUE 'COVERAGE';
