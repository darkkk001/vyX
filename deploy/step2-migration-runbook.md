# Step 2 live migration runbook (NOT RUN; owner approval required)

Branch `step2/web`. One new migration: `20261001090000_lead_assignee_and_partner_suspend`.
Target: the LIVE database **ep-morning-glade** (credentials only in `D:\VyXTrader-Tauri\vyX\.env.live`).
Never `.env` / `.env.local` (they point at the dead ep-flat-boat). Never `prisma migrate dev`.
Never print either URL. Set BOTH `DATABASE_URL` and `DIRECT_URL` (prisma migrate uses `DIRECT_URL`).

## Order

1. Read-only pre-check (below). Stop if anything differs from "expected".
2. `migrate status`, then `migrate deploy` (this migration only is pending).
3. Verify the columns physically exist (CLAUDE.md "Deployment safety").
4. Only then deploy the `step2/web` code to Vercel. The migration is additive (nullable columns + one FK), so the
   code live today keeps working after step 2; the new code must not go live before step 3 (it selects the new
   columns and would fail with P2022).

## 0. Shell setup (Git Bash, from the step 2 worktree; nothing printed)

```bash
cd /d/vyx-step2
export DATABASE_URL="$(grep '^DATABASE_URL=' /d/VyXTrader-Tauri/vyX/.env.live | cut -d= -f2- | tr -d '"')"
export DIRECT_URL="$(grep '^DIRECT_URL=' /d/VyXTrader-Tauri/vyX/.env.live | cut -d= -f2- | tr -d '"')"
# prove the target without printing the secret: must print ep-morning-glade twice
echo "$DATABASE_URL" | grep -o 'ep-[a-z]*-[a-z]*' | head -1
echo "$DIRECT_URL"   | grep -o 'ep-[a-z]*-[a-z]*' | head -1
PSQL=/d/pg-scratch/pgsql/bin/psql.exe
```

## 1. Read-only pre-check

```bash
$PSQL -X -P pager=off -d "$DIRECT_URL" <<'SQL'
SET default_transaction_read_only = on;
-- the ledger: last applied migration must be 20260928090000_funds_review_note; the held credit migration must NOT be applied
SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 3;
SELECT COUNT(*) AS credit_migration_applied FROM _prisma_migrations WHERE migration_name = '20260928150000_credit_and_trading_rights';
-- the new columns must not exist yet
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND ((table_name = 'Account' AND column_name IN ('ibSuspendedAt', 'ibSuspendedById'))
    OR (table_name = 'Lead' AND column_name = 'assignedAdminId'));
-- rows the migration touches (it rewrites none; ADD COLUMN on these tables)
SELECT (SELECT COUNT(*) FROM "Account") AS accounts, (SELECT COUNT(*) FROM "Lead") AS leads,
       (SELECT COUNT(*) FROM "AdminUser") AS staff,
       (SELECT COUNT(DISTINCT "ibAccountId") FROM "IbRelationship") AS partners;
SQL
```

Expected: last applied `20260928090000_funds_review_note`; `credit_migration_applied = 0`; no rows from the
information_schema query; the counts for the record (accounts, leads, staff, partners).

## 2. Migrate

```bash
npx prisma migrate status     # expect exactly one pending: 20261001090000_lead_assignee_and_partner_suspend
npx prisma migrate deploy     # applies it; prints the NOTICE "partners suspended ... 0; leads assigned ... 0"
npx prisma migrate status     # expect "Database schema is up to date!"
```

If `migrate status` lists anything else as pending, or reports drift/failed migrations: STOP, do not deploy.

## 3. Verify it landed (physical check, not the ledger)

```bash
$PSQL -X -P pager=off -d "$DIRECT_URL" <<'SQL'
SET default_transaction_read_only = on;
SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_schema = 'public' AND ((table_name = 'Account' AND column_name IN ('ibSuspendedAt', 'ibSuspendedById'))
    OR (table_name = 'Lead' AND column_name = 'assignedAdminId')) ORDER BY 1, 2;
SELECT conname, confdeltype FROM pg_constraint WHERE conname = 'Lead_assignedAdminId_fkey';
SELECT COUNT(*) FILTER (WHERE "ibSuspendedAt" IS NOT NULL) AS suspended FROM "Account";
SELECT COUNT(*) FILTER (WHERE "assignedAdminId" IS NOT NULL) AS assigned FROM "Lead";
-- the shadow engine's read-only role keeps its column grants (new columns are simply not granted to it)
SELECT has_table_privilege('vyx_shadow_ro', '"Account"', 'INSERT,UPDATE,DELETE') AS shadow_can_write_account;
SQL
```

Expected: 3 rows (`timestamp with time zone` YES, `text` YES, `text` YES); the FK with `confdeltype = n`
(SET NULL); suspended 0; assigned 0; `shadow_can_write_account = f`.

## Migration SQL (exact file content)

`prisma/migrations/20261001090000_lead_assignee_and_partner_suspend/migration.sql`:

```sql
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
```

(Comments in the file omitted here.) Additive only: nullable columns with no default, so Postgres adds them without
rewriting the table; the FK validates against an all-NULL column (instant).

## Rollback (only if the code deploy must be abandoned; the old code ignores these columns)

Not needed for the old code to keep working. If the columns must go:

```sql
ALTER TABLE "Lead" DROP CONSTRAINT IF EXISTS "Lead_assignedAdminId_fkey";
ALTER TABLE "Lead" DROP COLUMN IF EXISTS "assignedAdminId";
ALTER TABLE "Account" DROP COLUMN IF EXISTS "ibSuspendedById";
ALTER TABLE "Account" DROP COLUMN IF EXISTS "ibSuspendedAt";
DELETE FROM _prisma_migrations WHERE migration_name = '20261001090000_lead_assignee_and_partner_suspend';
```

(Only while no partner is suspended and no lead is assigned; otherwise that state is lost.)
