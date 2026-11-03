# Migration-drift reconcile runbook (NOT RUN; daily-break window, owner go)

Branch `fix/migration-drift-reconcile`. Target: the LIVE database **ep-morning-glade** (credentials only in
`C:\vyx-secrets\env\D-vyX\.env.live`). Never `.env` / `.env.local`. Never `prisma migrate dev`. Never print either URL. Set BOTH
`DATABASE_URL` and `DIRECT_URL`. Windows psql: options first, `-d <url>` last.

What ships (owner approved all 5 items, 2026-11-03; the former deploy/known-drift.sql baseline):

| Item | What | Live effect |
|---|---|---|
| 1. Migration `20261103120000_drift_reconcile` | `Account_groupId_fkey` ON DELETE SET NULL -> RESTRICT | deleting a group that got an account between the route's count and the delete answers 409 GROUP_IN_USE instead of a 500 (P2011). Any other delete: unchanged |
| 2. Same migration | `GroupSymbol.createdAt`, `GroupSymbolConfig.createdAt / updatedAt` TIMESTAMP(3) -> TIMESTAMPTZ(3), `USING ... AT TIME ZONE 'UTC'` | values unchanged (stored UTC wall clock read as UTC); both tables rewritten under ACCESS EXCLUSIVE |
| 3. schema.prisma only | `MirrorRule.killedAt @db.Timestamptz(3)` (the database already has it) | none |
| 4. schema.prisma only | `RiskEngineHeartbeat.beatAt @default(dbgenerated("clock_timestamp()"))` (the database already has it) | none |
| 5. schema.prisma only | `Transaction.updatedAt @default(now()) @updatedAt` (the database DEFAULT stays; never drop it) | none |

No Order, Deal, Position or money column is touched. deploy/known-drift.sql is empty: Migrations CI is now a plain
"no drift" check.

Locks (item 1 and 2 run in one migration transaction, so all of them are held until it commits; expected well under a
second, step 1's `rows` line shows the sizes): `Account` and `Group` (the FK is dropped and re-added, which checks every Account row once),
`GroupSymbol` and `GroupSymbolConfig` (rewritten). Order and account writes that touch `Account` wait for that moment;
the engine's pricing reads `GroupSymbolConfig`. Hence the daily break (20:59-22:00 UTC). No reader selects the
converted timestamp columns (engine ask_markup.rs / pricing.rs and the gateway's client-ask.ts list their columns; the
web goes through the pooler with pgbouncer=true, so no cached plans).

## Order (every step is required; do not reorder)

1. **Verify live (read-only)** matches what the replayed migrations build (step 1 below). Any difference: STOP.
2. **Migrate** (status, deploy, status). `migrate status` must list ONLY `20261103120000_drift_reconcile` as pending.
3. **Put the build live** (merge to main). Never before step 2: the startup schema guard (lib/schema-guard.ts) answers
   **503 to every request** while `20261103120000_drift_reconcile` is missing from the database.
4. **Verify** (step 4 below).

## 0. Shell setup (Git Bash, from the checkout on this branch; nothing printed)

```bash
cd /c/vyx/web
export DATABASE_URL="$(grep '^DATABASE_URL=' /c/vyx-secrets/env/D-vyX/.env.live | cut -d= -f2- | tr -d '"')"
export DIRECT_URL="$(grep '^DIRECT_URL=' /c/vyx-secrets/env/D-vyX/.env.live | cut -d= -f2- | tr -d '"')"
echo "$DATABASE_URL" | grep -o 'ep-[a-z]*-[a-z]*' | head -1   # must print ep-morning-glade
echo "$DIRECT_URL"   | grep -o 'ep-[a-z]*-[a-z]*' | head -1   # must print ep-morning-glade
PSQL=/c/pg-scratch/pgsql/bin/psql.exe
```

## 1. Verify live BEFORE (read-only; may run any time, not only in the break)

The fix was tested on a database built by replaying the migrations, never on live. This proves live has the same
definitions, so the fix does there what it did on scratch (an out-of-band change on live would not show in the replay).

```bash
$PSQL -X -A -t -c "SELECT 'fk', conname, confdeltype, confupdtype, convalidated FROM pg_constraint WHERE conname = 'Account_groupId_fkey';" -d "$DIRECT_URL"
$PSQL -X -A -t -c "SELECT 'col', table_name, column_name, data_type, datetime_precision, coalesce(column_default, '-') FROM information_schema.columns WHERE table_schema = 'public' AND (table_name, column_name) IN (('GroupSymbol','createdAt'),('GroupSymbolConfig','createdAt'),('GroupSymbolConfig','updatedAt'),('MirrorRule','killedAt'),('RiskEngineHeartbeat','beatAt'),('Transaction','updatedAt')) ORDER BY 2, 3;" -d "$DIRECT_URL"
$PSQL -X -A -t -c "SELECT 'rows', (SELECT count(*) FROM \"GroupSymbol\"), (SELECT count(*) FROM \"GroupSymbolConfig\"), (SELECT count(*) FROM \"Account\");" -d "$DIRECT_URL"
```

Pass = exactly (what the replayed chain builds before this migration):

```
fk|Account_groupId_fkey|n|c|t
col|GroupSymbol|createdAt|timestamp without time zone|3|CURRENT_TIMESTAMP
col|GroupSymbolConfig|createdAt|timestamp without time zone|3|CURRENT_TIMESTAMP
col|GroupSymbolConfig|updatedAt|timestamp without time zone|3|-
col|MirrorRule|killedAt|timestamp with time zone|3|-
col|RiskEngineHeartbeat|beatAt|timestamp with time zone|3|clock_timestamp()
col|Transaction|updatedAt|timestamp with time zone|3|CURRENT_TIMESTAMP
```

(`n` = ON DELETE SET NULL, `c` = ON UPDATE CASCADE, `t` = validated.) The `rows` line is only the size of what gets
rewritten / checked (expected: hundreds to low thousands). Any other line, a missing line, or the FK already `r`: STOP
and report; do not migrate.

Right before step 2, no long transaction may be open (the migration would queue behind it and every Account write
would queue behind the migration):

```bash
$PSQL -X -A -t -c "SELECT pid, state, now() - xact_start AS open_for FROM pg_stat_activity WHERE xact_start < now() - interval '30 seconds' AND pid <> pg_backend_pid();" -d "$DIRECT_URL"
```

Pass = no rows.

## 2. Migrate (daily break 20:59-22:00 UTC)

```bash
npx prisma migrate status    # pending: ONLY 20261103120000_drift_reconcile (anything else pending: STOP, that release has its own runbook)
npx prisma migrate deploy
npx prisma migrate status    # "Database schema is up to date"
```

## 3. Build live

Merge `fix/migration-drift-reconcile` to main (Vercel deploys main). Check one staff request answers normally (not 503).

## 4. Verify AFTER

Re-run the two queries of step 1. Pass = exactly:

```
fk|Account_groupId_fkey|r|c|t
col|GroupSymbol|createdAt|timestamp with time zone|3|CURRENT_TIMESTAMP
col|GroupSymbolConfig|createdAt|timestamp with time zone|3|CURRENT_TIMESTAMP
col|GroupSymbolConfig|updatedAt|timestamp with time zone|3|-
col|MirrorRule|killedAt|timestamp with time zone|3|-
col|RiskEngineHeartbeat|beatAt|timestamp with time zone|3|clock_timestamp()
col|Transaction|updatedAt|timestamp with time zone|3|CURRENT_TIMESTAMP
```

Optional, read-only: the full diff of live against the schema is now only what live has on purpose outside Prisma
(e.g. `Order_status_type_idx` from the dealer-queue-expiry runbook, the engine's own tables), none of the 5 items:

```bash
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script
```

## Revert (only if the migration must be undone; values survive both ways)

```sql
ALTER TABLE "Account" DROP CONSTRAINT "Account_groupId_fkey";
ALTER TABLE "Account" ADD CONSTRAINT "Account_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GroupSymbol" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "GroupSymbolConfig" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3) USING "updatedAt" AT TIME ZONE 'UTC';
```

The web build expects the migration (schema guard), so a revert also needs the previous build live first.

## Tested on scratch (127.0.0.1:5499, Asia/Karachi session time zone, 2026-11-03)

- Replay of the 116 earlier migrations, seed, then `migrate deploy` of this one: applied.
- Item 1: deleting a group that still has an account: before = P2011 (not caught, 500); after = P2003, and the route
  test "an account assigned between the count and the delete still answers 409" passes (6/6). With the old SET NULL FK
  restored, that test fails with `Null constraint violation on the fields: (groupId)`.
- Item 2: `GroupSymbol.createdAt` 2026-11-02 12:34:56.789, `GroupSymbolConfig.createdAt / updatedAt`
  2026-11-02 12:34:56.789 / 2026-11-03 01:02:03.456 read back identical (+00) after the conversion.
- `prisma migrate diff` replayed DB -> schema.prisma: empty; `deploy/check-migration-drift.sh`: "drift: none"; an
  unreachable database still fails the check.
