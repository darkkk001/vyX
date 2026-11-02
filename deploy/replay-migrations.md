# Replaying the migration chain on an empty database (Bug #2, 2026-11-02)

For CI, disaster recovery and any new environment. **Never** for the live database: it already has every migration.

```bash
# from the web repo root; both URLs = the EMPTY target (localhost, or REPLAY_ALLOW_REMOTE=1 for a brand-new DR / env DB)
export DATABASE_URL=...; export DIRECT_URL=...
bash deploy/replay-migrations.sh        # every migration from zero; refuses a non-empty target
bash deploy/check-migration-drift.sh    # the replayed DB vs prisma/schema.prisma, against deploy/known-drift.sql
```

CI runs both on every change under `prisma/` (`.github/workflows/migrations-ci.yml`, postgres:16 service container).

## Why plain `prisma migrate deploy` fails on an empty database

`20260921160000_stage3a_group_the_ungrouped` is a data-only migration written for production: it assigns groups to 18
named production accounts and aborts if any of them is missing (`aborting: 18 listed account(s) do not exist on the
named broker`, migration.sql:145). On an empty database they never exist. It creates no schema, so the replay script
marks it applied without running it (`prisma migrate resolve --applied`), then runs `prisma migrate deploy` for the
rest. The migration file is NOT edited: it is applied on production and its checksum must not change.

Verified on a fresh scratch database: 116/116 migrations recorded, `migrate status` up to date, no other migration
fails.

## Known drift (deploy/known-drift.sql)

What the replayed migrations build differs from `prisma/schema.prisma` in a few places. Live applied the same
migrations, so it very likely has the same drift. These are owner decisions and are NOT fixed yet:

| Object | Migrations build | schema.prisma says |
|---|---|---|
| `Account_groupId_fkey` | ON DELETE SET NULL (20260817050000_groups) | RESTRICT (groupId is NOT NULL since stage3b) |
| `GroupSymbol.createdAt`, `GroupSymbolConfig.createdAt / updatedAt` | TIMESTAMP(3) | TIMESTAMPTZ(3) |
| `MirrorRule.killedAt` | TIMESTAMPTZ(3) | TIMESTAMP(3) |
| `RiskEngineHeartbeat.beatAt` | default clock_timestamp() | now() |
| `Transaction.updatedAt` | DEFAULT CURRENT_TIMESTAMP | @updatedAt (no default) |

`deploy/check-migration-drift.sh` passes while the diff equals this baseline exactly and fails on anything else. After
fixing an item (a migration and / or a schema change), rerun the replay and `bash deploy/check-migration-drift.sh
--update`, and review the smaller baseline in the same commit. An empty baseline = `migrate diff --exit-code`.

**Fixed 2026-11-02: the ticket sequences.** `Order.ticket` and `Deal.ticket` were modeled as
`@default(dbgenerated("nextval(...)"))`. Prisma introspects those columns as `autoincrement()`, so `migrate diff` (and
therefore `migrate dev` / `db push`) wanted to DROP `order_ticket_seq` and `deal_ticket_seq`, which would break every
new order and deal. Both are `@default(autoincrement())` now: the database is unchanged, the client is unchanged (the
database still assigns the ticket), and the diff no longer touches them. Still: never `prisma migrate dev` or
`db push` against a real database here.
