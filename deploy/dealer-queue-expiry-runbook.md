# Dealer queue expiry runbook (NOT RUN; daily-break window, owner go)

Branch `feat/dealer-queue-expiry`. Target: the LIVE database **ep-morning-glade** (credentials only in
`C:\vyx-secrets\env\D-vyX\.env.live`). Never `.env` / `.env.local`. Never `prisma migrate dev`. Never print either URL. Set BOTH
`DATABASE_URL` and `DIRECT_URL`. Windows psql: options first, `-d <url>` last.

What ships:

| Part | What | Live effect |
|---|---|---|
| Migration `20261102120000_dealer_queue_expiry` | `Broker.requoteExpirySeconds` (60), `Broker.offerExpirySeconds` (300), `Order.queuedAt` (nullable). Column adds only, metadata-only. | none by itself |
| Code | lib/order-expiry.ts: REQUOTED lapses 60 s after the requote, a MARKET order waiting for the dealer 300 s after `queuedAt`; CANCELLED + OFFER_EXPIRED | the first 5-minute sweep expires anything already past its window |
| Step 3, by hand, MANDATORY | `CREATE INDEX CONCURRENTLY "Order_status_type_idx"` | the sweep's "anything waiting?" query stops scanning Order |
| Step 4, by hand | `queuedAt` backfill for orders already waiting for the dealer | those rows get their last update as the queue time instead of the createdAt fallback |

## Order (every step is required; do not reorder)

1. **Migrate** (status, deploy, status). Columns only.
2. **Put the build live** (merge to main). Never before step 1: the startup schema guard (lib/schema-guard.ts) answers
   **503 to every request** while `20261102120000_dealer_queue_expiry` is missing from the database.
3. **Index, CONCURRENTLY, then verify `indisvalid = true`.** MANDATORY: the release is not done until this passes.
4. **Backfill** `queuedAt` (after step 3, so it is an index scan over a handful of rows, no lock on the table).
5. **Verify.**

Why the index and the backfill are not in the migration: a migration runs its statements while holding the ADD
COLUMN's ACCESS EXCLUSIVE lock; a plain CREATE INDEX or an UPDATE that scans Order inside it would block every Order
read and write for as long as the scan takes. CONCURRENTLY cannot run inside a transaction at all. The index is
therefore not in schema.prisma either: `prisma migrate diff` against live lists it as extra after step 3. Leave it.

## 0. Shell setup (Git Bash, from the checkout on this branch; nothing printed)

```bash
cd /c/vyx/web
export DATABASE_URL="$(grep '^DATABASE_URL=' /c/vyx-secrets/env/D-vyX/.env.live | cut -d= -f2- | tr -d '"')"
export DIRECT_URL="$(grep '^DIRECT_URL=' /c/vyx-secrets/env/D-vyX/.env.live | cut -d= -f2- | tr -d '"')"
echo "$DATABASE_URL" | grep -o 'ep-[a-z]*-[a-z]*' | head -1   # must print ep-morning-glade
echo "$DIRECT_URL"   | grep -o 'ep-[a-z]*-[a-z]*' | head -1   # must print ep-morning-glade
PSQL=/c/pg-scratch/pgsql/bin/psql.exe
```

Pre-check (read-only): how many offers are waiting right now (the first sweep after step 2 acts on these).

```bash
$PSQL -X -A -t -c "SELECT status, count(*) FROM \"Order\" WHERE type = 'MARKET' AND status IN ('PENDING','REQUOTED') GROUP BY status;" -d "$DIRECT_URL"
```

## 1. Migrate

```bash
npx prisma migrate status
npx prisma migrate deploy
npx prisma migrate status   # "Database schema is up to date"
```

## 2. Build live

Merge `feat/dealer-queue-expiry` to main (Vercel deploys main). Check one staff request answers normally (not 503).

## 3. Index (MANDATORY, then verify)

Run on its own, NOT inside BEGIN / a transaction (psql `-c` with one statement runs in autocommit):

```bash
$PSQL -X -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_status_type_idx" ON "Order" ("status", "type");' -d "$DIRECT_URL"
$PSQL -X -A -t -c "SELECT c.relname, i.indisvalid, i.indisready FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'Order_status_type_idx';" -d "$DIRECT_URL"
```

Pass = one row `Order_status_type_idx|t|t`. If `indisvalid` is `f` (a CONCURRENTLY build that failed leaves an INVALID
index), drop it and re-run:

```bash
$PSQL -X -c 'DROP INDEX CONCURRENTLY IF EXISTS "Order_status_type_idx";' -d "$DIRECT_URL"
```

## 4. Backfill queuedAt (after step 3)

```bash
$PSQL -X -c "UPDATE \"Order\" SET \"queuedAt\" = \"updatedAt\" WHERE type = 'MARKET' AND status = 'PENDING' AND \"queuedAt\" IS NULL;" -d "$DIRECT_URL"
```

Expect `UPDATE 0` or a handful (the orders waiting for the dealer that the sweep has not expired yet). Until it runs,
such a row's clock falls back to its createdAt (the earlier end: it expires sooner, never later).

## 5. Verify

```bash
# no waiting MARKET order without a queue time
$PSQL -X -A -t -c "SELECT count(*) FROM \"Order\" WHERE type = 'MARKET' AND status = 'PENDING' AND \"queuedAt\" IS NULL;" -d "$DIRECT_URL"   # 0
# the settings exist with the defaults
$PSQL -X -A -t -c "SELECT count(*) FILTER (WHERE \"requoteExpirySeconds\" = 60 AND \"offerExpirySeconds\" = 300), count(*) FROM \"Broker\";" -d "$DIRECT_URL"
# after the next 5-minute cron: anything past its window is CANCELLED + OFFER_EXPIRED
$PSQL -X -A -t -c "SELECT count(*) FROM \"AuditLog\" WHERE action = 'DEALING_ORDER_EXPIRED';" -d "$DIRECT_URL"
```

## Rollback

Code: revert the merge. Database (only after the code is reverted; the schema guard would 503 otherwise):

```sql
DROP INDEX CONCURRENTLY IF EXISTS "Order_status_type_idx";
ALTER TABLE "Order" DROP COLUMN "queuedAt";
ALTER TABLE "Broker" DROP COLUMN "offerExpirySeconds", DROP COLUMN "requoteExpirySeconds";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261102120000_dealer_queue_expiry';
```
