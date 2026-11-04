# Drift reconcile: Account(Type)SymbolConfig symbolId FK CASCADE -> RESTRICT (NOT RUN; daily break, owner go)

Branch `fix/fk-symbol-restrict-reconcile`. Migration `20261105100000_fk_symbol_restrict_reconcile`. Target: the LIVE database
**ep-morning-glade** (credentials only in `C:\vyx-secrets\env\D-vyX\.env.live`). Never `.env` / `.env.local`. Never `prisma migrate dev`.
Never print either URL. Set BOTH `DATABASE_URL` and `DIRECT_URL`. Windows psql: options first, `-d <url>` last.

## What ships
- On live, `AccountSymbolConfig_symbolId_fkey` and `AccountTypeSymbolConfig_symbolId_fkey` are ON DELETE CASCADE, changed out of band.
- The schema (a required relation without onDelete = Restrict) and the creating migration (20260907120000_pricing_engine_new_tables_and_flag) say ON DELETE RESTRICT ON UPDATE CASCADE.
- The migration drops and re-adds both FKs exactly as created.
- Live effect: deleting a Symbol that still has an account or account-type override is refused (23503) instead of silently deleting the override rows. Nothing else changes.
- Locks: brief ACCESS EXCLUSIVE on both tables (0 rows each on 2026-11-05) and a share lock on "Symbol" while the FK is validated. Well under a second; daily break.

## Order (every step required; do not reorder)
1. Verify live, read-only (any time).
2. Daily break (22:00-23:00 UTC in winter): `prisma migrate status` must list ONLY `20261105100000_fk_symbol_restrict_reconcile` pending (plus any other migration the owner has approved for the same window), then `prisma migrate deploy`.
3. Put the build live (merge to main) only AFTER step 2. The schema guard (lib/schema-guard.ts) answers 503 while an expected migration is missing from the database.
4. Verify after.

## 0. Shell (Git Bash, from a checkout of this branch; nothing printed)
```bash
export DATABASE_URL="$(grep '^DATABASE_URL=' /c/vyx-secrets/env/D-vyX/.env.live | cut -d= -f2- | tr -d '"')"
export DIRECT_URL="$(grep '^DIRECT_URL=' /c/vyx-secrets/env/D-vyX/.env.live | cut -d= -f2- | tr -d '"')"
echo "$DIRECT_URL" | grep -o 'ep-[a-z]*-[a-z]*' | head -1   # must print ep-morning-glade
PSQL=/c/pg-scratch/pgsql/bin/psql.exe
```

## 1. Verify live BEFORE (read-only)
```bash
PGOPTIONS='-c default_transaction_read_only=on' $PSQL -X -A -t -c "SELECT 'fk', conname, confdeltype, confupdtype, convalidated FROM pg_constraint WHERE conname IN ('AccountSymbolConfig_symbolId_fkey','AccountTypeSymbolConfig_symbolId_fkey') ORDER BY 2;" -d "$DIRECT_URL"
PGOPTIONS='-c default_transaction_read_only=on' $PSQL -X -A -t -c "SELECT 'rows', (SELECT count(*) FROM \"AccountSymbolConfig\"), (SELECT count(*) FROM \"AccountTypeSymbolConfig\");" -d "$DIRECT_URL"
```
Pass = exactly (as seen 2026-11-05):
```
fk|AccountSymbolConfig_symbolId_fkey|c|c|t
fk|AccountTypeSymbolConfig_symbolId_fkey|c|c|t
```
(`c` = CASCADE, `t` = validated.) If either already reads `r`, the migration is still safe (drop and re-add the same definition), but STOP and report: someone changed live again. The `rows` line is the size checked (0 and 0 on 2026-11-05).
Right before step 2, no long transaction: `SELECT pid, state, now() - xact_start FROM pg_stat_activity WHERE xact_start < now() - interval '30 seconds' AND pid <> pg_backend_pid();` must return no rows.

## 4. Verify AFTER
The same fk query must print `r|c|t` for both.

## Rollback
Not expected. To restore the out-of-band state: the same two ALTERs with ON DELETE CASCADE. That would be drift again, so it needs the owner's go.

## Tested (2026-11-05, local scratch Postgres)
- Replay per deploy/replay-migrations.sh (stage3a marked applied, the rest deployed) on an empty database: both FKs `r|c|t`, and `prisma migrate diff --from-url <replayed> --to-schema-datamodel prisma/schema.prisma --script` is EMPTY. deploy/known-drift.sql stays empty.
- Live drift simulated: the chain without this migration, both FKs set to CASCADE (`c|c|t`). Applying this migration gives `r|c|t`, and the diff shows nothing for these tables.
