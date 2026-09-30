# web4 live migration runbook (NOT RUN; owner approval required)

Branch `web4`. One new migration: `20261003090000_economic_event_history` (one new, global table).
Target: the LIVE database **ep-morning-glade** (credentials only in `D:\VyXTrader-Tauri\vyX\.env.live`).
Never `.env` / `.env.local` (dead ep-flat-boat). Never `prisma migrate dev`. Never print either URL.
Set BOTH `DATABASE_URL` and `DIRECT_URL`.

## Order

1. Read-only pre-check.
2. `migrate status`, `migrate deploy`, `migrate status`.
3. Physical verify (table, keys; shadow role not granted the new table).
4. Deploy the `web4` code (it writes the table from the calendar refresh and the new cron, and the risk radar reads
   it). The code live today never touches the table.
5. After the deploy: the history starts empty. Trigger the collector once so it starts now, not at the next
   6-hourly tick (step 5 below), and confirm rows appear.

History note for the owner: the table only holds events seen from the deploy on (plus the rest of that week, since
the feed carries the whole Sunday-to-Saturday week). The news-trading flag looks back 30 days but never before the
history starts; until 30 days exist it judges the shorter window and the radar says `collectingHistory: true`.

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
SELECT to_regclass('public."EconomicEvent"') AS economic_event_exists;
SELECT id, "fetchedAt", jsonb_array_length("events"::jsonb) AS events_in_cached_week FROM "EconomicCalendarCache";
SELECT defaclrole::regrole, defaclacl FROM pg_default_acl WHERE defaclacl::text LIKE '%vyx_shadow_ro%';
SQL
```

Expected: last applied `20261002090000_notification_read_per_staff`; `credit_migration_applied = 0`;
`economic_event_exists` NULL; the cache row for the record; no default-privilege row naming `vyx_shadow_ro`.

## 2. Migrate

```bash
npx prisma migrate status     # expect exactly one pending: 20261003090000_economic_event_history
npx prisma migrate deploy
npx prisma migrate status     # expect "Database schema is up to date!"
```

## 3. Verify it landed (physical check)

```bash
$PSQL -X -P pager=off -d "$DIRECT_URL" <<'SQL'
SET default_transaction_read_only = on;
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'EconomicEvent' ORDER BY column_name;
SELECT indexname FROM pg_indexes WHERE tablename = 'EconomicEvent' ORDER BY 1;
SELECT COUNT(*) AS rows FROM "EconomicEvent";
SELECT has_table_privilege('vyx_shadow_ro', '"EconomicEvent"', 'SELECT') AS shadow_reads_new_table,
       has_table_privilege('vyx_shadow_ro', '"EconomicEvent"', 'INSERT,UPDATE,DELETE') AS shadow_writes_new_table,
       has_table_privilege('vyx_shadow_ro', '"Account"', 'INSERT,UPDATE,DELETE') AS shadow_can_write_account;
SQL
```

Expected: 9 columns (currency, eventAt timestamptz, firstSeenAt timestamptz, id, impact, source, sourceKey, title,
updatedAt timestamptz; all NOT NULL); indexes `EconomicEvent_currency_eventAt_idx`, `EconomicEvent_eventAt_idx`,
`EconomicEvent_pkey`, `EconomicEvent_sourceKey_key`; 0 rows; `f`, `f`, `f`.

## 4. Vercel cron

`vercel.json` adds `/api/internal/economic-events` every 6 hours (`20 */6 * * *`), authorised by the existing
`CRON_SECRET` (the same one swap-rollover uses; nothing new to set). Confirm after the deploy that the project shows
three crons.

## 5. Start the history now (after the deploy)

Call the collector once with the cron secret (value not printed; read it from Vercel env into a shell variable), or
open the terminal's news panel once (the calendar refresh records too). Then:

```bash
$PSQL -X -P pager=off -d "$DIRECT_URL" -c 'SELECT COUNT(*) AS high_impact_events, MIN("eventAt"), MAX("eventAt"), MIN("firstSeenAt") FROM "EconomicEvent"'
```

Expected: a non-zero count spanning the current week.

## Migration SQL (exact statements)

```sql
CREATE TABLE IF NOT EXISTS "EconomicEvent" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventAt" TIMESTAMPTZ(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "EconomicEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "EconomicEvent_sourceKey_key" ON "EconomicEvent"("sourceKey");
CREATE INDEX IF NOT EXISTS "EconomicEvent_eventAt_idx" ON "EconomicEvent"("eventAt");
CREATE INDEX IF NOT EXISTS "EconomicEvent_currency_eventAt_idx" ON "EconomicEvent"("currency", "eventAt");
```

Additive only. Global table: no broker id, nothing broker-specific.

## Rollback

The old code never reads the table. If it must go (the recorded history is lost):

```sql
DROP TABLE IF EXISTS "EconomicEvent";
DELETE FROM _prisma_migrations WHERE migration_name = '20261003090000_economic_event_history';
```
