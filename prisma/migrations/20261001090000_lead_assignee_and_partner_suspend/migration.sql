-- Step 2 (owner 2026-09-30). Additive only: two nullable columns on "Account", one nullable column + FK on "Lead".
-- Every existing row keeps today's behaviour (NULL = not suspended / unassigned). No data is rewritten.
--
-- 1. IB "Suspend partner": "Account"."ibSuspendedAt" / "ibSuspendedById" on the partner's own account.
--    NULL = the partner is not suspended (every partner today).
-- 2. CRM "Assign to staff": "Lead"."assignedAdminId" -> "AdminUser"(id), ON DELETE SET NULL (removing a staff row
--    un-assigns the lead, never deletes it). NULL = unassigned (every lead today).

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "ibSuspendedAt" TIMESTAMPTZ(3);
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "ibSuspendedById" TEXT;

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "assignedAdminId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_assignedAdminId_fkey') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedAdminId_fkey"
      FOREIGN KEY ("assignedAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
DECLARE s INT; l INT;
BEGIN
  SELECT COUNT(*) INTO s FROM "Account" WHERE "ibSuspendedAt" IS NOT NULL;
  SELECT COUNT(*) INTO l FROM "Lead" WHERE "assignedAdminId" IS NOT NULL;
  RAISE NOTICE 'partners suspended after migration: % (expect 0); leads assigned: % (expect 0)', s, l;
END $$;
