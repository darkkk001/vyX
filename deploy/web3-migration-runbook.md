# web3 live migration runbook (NOT RUN; owner approval required)

Branch `web3`. One new migration: `20261002090000_notification_read_per_staff` (one new table).
Target: the LIVE database **ep-morning-glade** (credentials only in `D:\VyXTrader-Tauri\vyX\.env.live`).
Never `.env` / `.env.local` (they point at the dead ep-flat-boat). Never `prisma migrate dev`. Never print either URL.
Set BOTH `DATABASE_URL` and `DIRECT_URL` (prisma migrate uses `DIRECT_URL`).

## Order

1. Read-only pre-check. Stop if anything differs from "expected".
2. `migrate status`, `migrate deploy`, `migrate status`.
3. Physical verify (table, keys, FKs; shadow role not granted the new table).
4. Only then deploy the `web3` code. The code live today never reads the new table, so step 2 is safe with the old
   code; the new code must not go live before step 3 (its notification reads/writes use the table).

Behaviour change the owner should know at deploy: from this deploy on, "mark read" / "mark all read" in the
backoffice marks for the person only. Notifications already marked read before the deploy (shared `readAt`) stay
read for everyone; everything unread stays unread for each staff member until they read it.

## 0. Shell setup (Git Bash, from the worktree; nothing printed)

```bash
cd /d/vyx-step2
export DATABASE_URL="$(grep '^DATABASE_URL=' /d/VyXTrader-Tauri/vyX/.env.live | cut -d= -f2- | tr -d '"')"
export DIRECT_URL="$(grep '^DIRECT_URL=' /d/VyXTrader-Tauri/vyX/.env.live | cut -d= -f2- | tr -d '"')"
echo "$DATABASE_URL" | grep -o 'ep-[a-z]*-[a-z]*' | head -1   # must print ep-morning-glade
echo "$DIRECT_URL"   | grep -o 'ep-[a-z]*-[a-z]*' | head -1   # must print ep-morning-glade
PSQL=/d/pg-scratch/pgsql/bin/psql.exe
```

## 1. Read-only pre-check

```bash
$PSQL -X -P pager=off -d "$DIRECT_URL" <<'SQL'
SET default_transaction_read_only = on;
SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 3;
SELECT COUNT(*) AS credit_migration_applied FROM _prisma_migrations WHERE migration_name = '20260928150000_credit_and_trading_rights';
SELECT to_regclass('public."NotificationRead"') AS notification_read_exists;
-- rows the new rule reads (nothing is rewritten)
SELECT COUNT(*) AS staff_notifications, COUNT(*) FILTER (WHERE "readAt" IS NULL) AS staff_unread
  FROM "Notification" WHERE "accountId" IS NULL;
SELECT COUNT(*) AS staff FROM "AdminUser" WHERE "brokerId" IS NOT NULL;
-- would the shadow role get the new table through default privileges? (expect 0 rows)
SELECT defaclrole::regrole, defaclacl FROM pg_default_acl WHERE defaclacl::text LIKE '%vyx_shadow_ro%';
SQL
```

Expected: last applied `20261001090000_lead_assignee_and_partner_suspend`; `credit_migration_applied = 0`;
`notification_read_exists` empty (NULL); counts for the record; no default-privilege row naming `vyx_shadow_ro`.

## 2. Migrate

```bash
npx prisma migrate status     # expect exactly one pending: 20261002090000_notification_read_per_staff
npx prisma migrate deploy
npx prisma migrate status     # expect "Database schema is up to date!"
```

Anything else pending, drift or a failed migration: STOP, do not deploy.

## 3. Verify it landed (physical check)

```bash
$PSQL -X -P pager=off -d "$DIRECT_URL" <<'SQL'
SET default_transaction_read_only = on;
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'NotificationRead' ORDER BY ordinal_position;
SELECT conname, contype, confdeltype FROM pg_constraint WHERE conrelid = '"NotificationRead"'::regclass ORDER BY conname;
SELECT indexname FROM pg_indexes WHERE tablename = 'NotificationRead' ORDER BY 1;
SELECT COUNT(*) AS rows FROM "NotificationRead";
-- the shadow engine's read-only role: no access to the new table, still no write on money tables
SELECT has_table_privilege('vyx_shadow_ro', '"NotificationRead"', 'SELECT') AS shadow_reads_new_table,
       has_table_privilege('vyx_shadow_ro', '"NotificationRead"', 'INSERT,UPDATE,DELETE') AS shadow_writes_new_table,
       has_table_privilege('vyx_shadow_ro', '"Account"', 'INSERT,UPDATE,DELETE') AS shadow_can_write_account;
SQL
```

Expected: 3 columns (`notificationId` text NO, `adminId` text NO, `readAt` timestamptz NO default
CURRENT_TIMESTAMP); constraints `NotificationRead_pkey` (p), `NotificationRead_adminId_fkey` (f, `c` cascade),
`NotificationRead_notificationId_fkey` (f, `c`); indexes `NotificationRead_adminId_idx`, `NotificationRead_pkey`;
0 rows; `f`, `f`, `f`.

## Migration SQL (exact statements)

```sql
CREATE TABLE IF NOT EXISTS "NotificationRead" (
    "notificationId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("notificationId", "adminId")
);
CREATE INDEX IF NOT EXISTS "NotificationRead_adminId_idx" ON "NotificationRead"("adminId");
-- guarded DO block: FK NotificationRead_notificationId_fkey -> "Notification"(id) ON DELETE CASCADE
--                   FK NotificationRead_adminId_fkey        -> "AdminUser"(id)    ON DELETE CASCADE
```

Additive only: a new empty table; no existing row or column changes.

## Rollback

The old code never reads the table, so it keeps working with the table present. If the table must go (only before
anyone relies on per-staff read marks, which are lost):

```sql
DROP TABLE IF EXISTS "NotificationRead";
DELETE FROM _prisma_migrations WHERE migration_name = '20261002090000_notification_read_per_staff';
```
