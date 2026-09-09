-- Emergency page real controls: broker-wide close-only mode, and a
-- per-group full trading halt (Group.tradingRestriction can only narrow
-- to one side -- BUY_ONLY/SELL_ONLY -- it has no value for "stop this
-- group entirely without halting the whole broker"). Both nullable
-- timestamps, same on/off-via-timestamp shape as Broker.tradingHaltedAt
-- (null = off, set = on; the timestamp is the audit-trail entry point).
-- Hand-picked, not applied verbatim from `prisma migrate diff` -- same
-- reasoning as every other migration in this project.

-- AlterTable
ALTER TABLE "Broker" ADD COLUMN "closeOnlyAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Group" ADD COLUMN "tradingHaltedAt" TIMESTAMPTZ(3);
