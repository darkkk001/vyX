-- Client-facing account plan per group (owner 2026-10-23): Group.name is internal ("Dealing", "Reverse"...); clients see
-- displayName as accountPlan. Additive: every existing group gets the default "Standard" (Postgres fills the column on
-- ADD COLUMN ... DEFAULT, no row rewrite on PG 11+). Brokers rename per group in the backoffice.
-- Revert: ALTER TABLE "Group" DROP COLUMN "displayName";
ALTER TABLE "Group" ADD COLUMN "displayName" TEXT NOT NULL DEFAULT 'Standard';
