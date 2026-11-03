-- Migration-drift reconcile (owner approved 2026-11-03; deploy/known-drift.sql items 1 and 2). Items 3-5 of that baseline
-- are schema.prisma annotations only (MirrorRule.killedAt, RiskEngineHeartbeat.beatAt, Transaction.updatedAt): the
-- database already has what the migrations built, so nothing about them is here. Afterwards the replayed chain equals
-- schema.prisma exactly and deploy/known-drift.sql is empty.
--
-- 1. Account_groupId_fkey: ON DELETE SET NULL (20260817050000_groups) -> RESTRICT. Account.groupId has been NOT NULL
--    since 20260921170000_stage3b, so SET NULL can never succeed: deleting a group that still has an account failed with
--    a NOT NULL violation (Prisma P2011), which the group-delete route does not catch (a 500). With RESTRICT it is an FK
--    violation (P2003), caught, so the intended 409 GROUP_IN_USE. Nothing else changes: the delete was refused before too.
--    Re-adding the constraint checks every Account row once (small table, brief lock on Account and Group).
-- 2. GroupSymbol.createdAt, GroupSymbolConfig.createdAt / updatedAt: TIMESTAMP(3) -> TIMESTAMPTZ(3) like every other
--    table. Prisma has always written UTC wall-clock into these columns, so the stored values are read AS UTC,
--    explicitly: without USING, Postgres would read them in the session time zone (UTC on Neon, but -5 h in an
--    Asia/Karachi session). Rewrites both tables (small) under ACCESS EXCLUSIVE; the engine's pricing reads GroupSymbol,
--    so this runs in the daily break (deploy/drift-reconcile-runbook.md). No Order / Deal / money column is touched.
-- Revert:
--   ALTER TABLE "Account" DROP CONSTRAINT "Account_groupId_fkey";
--   ALTER TABLE "Account" ADD CONSTRAINT "Account_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
--   ALTER TABLE "GroupSymbol" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3) USING "createdAt" AT TIME ZONE 'UTC';
--   ALTER TABLE "GroupSymbolConfig" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3) USING "createdAt" AT TIME ZONE 'UTC',
--     ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "Account" DROP CONSTRAINT "Account_groupId_fkey";
ALTER TABLE "Account" ADD CONSTRAINT "Account_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GroupSymbol" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "GroupSymbolConfig"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
