# D4 + slippage batch runbook (NOT RUN; owner approval required)

Branch `d4-slippage`. Target: the LIVE database **ep-morning-glade** (credentials only in `.env.live`).
Never `.env` / `.env.local` (dead ep-flat-boat). Never `prisma migrate dev`. Never print either URL. Set BOTH
`DATABASE_URL` and `DIRECT_URL`.

What ships:

| Part | What | Live effect |
|---|---|---|
| Migration `20261004090000_broker_slippage_points` | `Broker.defaultMaxSlippagePoints` (nullable) | none until the data step; readers fall back to pips x 10 |
| Data step `deploy/d4-slippage-backfill.sql` | points = pips x 10, audited per broker | 0 brokers today (preview section 7) |
| Code | D4 resolver (account-type levels removed everywhere), slippage in points | 0 effective pricing changes (preview section 4) |

## Order

1. Re-run the read-only preview (`deploy/d4-slippage-preview.sql`). Stop if any "changes" count in section 4 is not 0,
   if 4b lists rows, or if section 7 differs from what you pass as `expected_brokers`.
2. Migrate (status, deploy, status).
3. Physical verify of the column.
4. The data step, in ONE transaction with guards (dry-run first with ROLLBACK).
5. Verify the data.
6. Deploy the `d4-slippage` web code.

The migration is additive. The code reads the new column with a fallback, so any order of steps 2-6 is safe, but
this is the order to use.

## 0. Shell setup (Git Bash, from the worktree; nothing printed)

```bash
cd /d/vyx-step2
export DATABASE_URL="$(grep '^DATABASE_URL=' /d/VyXTrader-Tauri/vyX/.env.live | cut -d= -f2- | tr -d '"')"
export DIRECT_URL="$(grep '^DIRECT_URL=' /d/VyXTrader-Tauri/vyX/.env.live | cut -d= -f2- | tr -d '"')"
echo "$DATABASE_URL" | grep -o 'ep-[a-z]*-[a-z]*' | head -1   # must print ep-morning-glade
echo "$DIRECT_URL"   | grep -o 'ep-[a-z]*-[a-z]*' | head -1   # must print ep-morning-glade
PSQL=/d/pg-scratch/pgsql/bin/psql.exe
```

## 1. Pre-check (read-only)

```bash
$PSQL -X -P pager=off -d "$DIRECT_URL" -f deploy/d4-slippage-preview.sql
$PSQL -X -P pager=off -d "$DIRECT_URL" <<'SQL'
SET default_transaction_read_only = on;
SELECT migration_name FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 3;
SELECT COUNT(*) AS credit_migration_applied FROM _prisma_migrations WHERE migration_name = '20260928150000_credit_and_trading_rights';
SELECT column_name FROM information_schema.columns WHERE table_name = 'Broker' AND column_name = 'defaultMaxSlippagePoints';
SQL
```

Expected: section 4 all zeros and 4b empty; last migration `20261003090000_economic_event_history`;
`credit_migration_applied = 0`; the new column absent.

## 2. Migrate

```bash
npx prisma migrate status   # exactly one pending: 20261004090000_broker_slippage_points
npx prisma migrate deploy
npx prisma migrate status   # "Database schema is up to date!"
```

## 3. Verify the column

```bash
$PSQL -X -P pager=off -d "$DIRECT_URL" -c "SET default_transaction_read_only = on" \
  -c "SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable FROM information_schema.columns WHERE table_name = 'Broker' AND column_name = 'defaultMaxSlippagePoints'" \
  -c "SELECT has_column_privilege('vyx_shadow_ro', '\"Broker\"', 'defaultMaxSlippagePoints', 'SELECT') AS shadow_reads_it, has_table_privilege('vyx_shadow_ro', '\"Broker\"', 'INSERT,UPDATE,DELETE') AS shadow_writes_broker"
```

Expected: `numeric(10,2)`, nullable; `shadow_reads_it = f` (a new column is not in the role's column grants);
`shadow_writes_broker = f`.

## 4. Data step (one transaction, guarded, audited)

`expected_brokers` = section 7's `brokers_with_cap` from step 1 (0 on 2026-09-30).

The script:
- refuses if any enabled symbol has 0 digits (x10 would not be exact for it);
- converts only brokers whose points are still NULL;
- refuses a broker whose points disagree with pips x 10;
- aborts if the count differs from `expected_brokers`;
- writes one `RISK_LIMITS_UPDATED` audit row per converted broker, with `newValue.source` "owner-approved direct
  write 2026-09-30 D4/slippage: max slippage pips -> points (x10)";
- re-checks that every capped broker now has exactly pips x 10.

It is idempotent: a rerun converts nothing.

```bash
# dry run: the same script with COMMIT -> ROLLBACK
sed 's/^COMMIT;$/ROLLBACK;/' deploy/d4-slippage-backfill.sql > /tmp/d4-dry.sql
$PSQL -X -d "$DIRECT_URL" -v expected_brokers=0 -f /tmp/d4-dry.sql      # expect NOTICE "ok: 0 brokers converted", ROLLBACK
# the write
$PSQL -X -d "$DIRECT_URL" -v expected_brokers=0 -f deploy/d4-slippage-backfill.sql   # expect NOTICE "ok: ...", COMMIT
```

Tested locally on 3 seeded brokers: a wrong expected count aborts with nothing written, the right count converts
2.5 → 25 and 5 → 50 with 3 audit rows, and a rerun writes nothing.

## 5. Verify the data

```bash
$PSQL -X -P pager=off -d "$DIRECT_URL" -c "SET default_transaction_read_only = on" \
  -c "SELECT subdomain, \"defaultMaxSlippagePips\", \"defaultMaxSlippagePoints\" FROM \"Broker\" ORDER BY 1" \
  -c "SELECT count(*) FROM \"AuditLog\" WHERE \"newValue\"->>'source' LIKE '%D4/slippage%'"
```

Expected: points = pips x 10 wherever pips is set; audit rows = `expected_brokers`.

## 6. Deploy the web code

Push `d4-slippage` and let Vercel deploy. Then smoke-test:
- `/api/trade/prices` for a Futurix account: markups match before the deploy (no type level);
- a market order and a close, with and without a SLIPPAGE MAX, accepted or refused as before;
- backoffice DEAL max slippage still shows (the API returns `defaultMaxSlippagePips` = points / 10 for 1.0.58).

## Rollback

- **Code:** redeploy the previous production commit. The new column is ignored by it.
- **Data:** `UPDATE "Broker" SET "defaultMaxSlippagePoints" = NULL WHERE "defaultMaxSlippagePoints" IS NOT NULL;`
  Readers fall back to pips x 10, so nothing changes in behaviour. Keep the audit rows; add one noting the rollback.
- **Column:** `ALTER TABLE "Broker" DROP COLUMN IF EXISTS "defaultMaxSlippagePoints";` plus
  `DELETE FROM _prisma_migrations WHERE migration_name = '20261004090000_broker_slippage_points';`
  Only after the code rollback.
- **AccountType / AccountTypeSymbolConfig:** untouched by this batch, so nothing to roll back.
