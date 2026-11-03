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

None: the baseline is empty, so `deploy/check-migration-drift.sh` is exactly `migrate diff --exit-code` ("drift: none").
Any difference between the replayed migrations and `prisma/schema.prisma` fails Migrations CI. If one ever has to be
accepted for a while, put it in the baseline with `bash deploy/check-migration-drift.sh --update` and review it in the
same commit.

**Fixed 2026-11-03: the five items the baseline held** (owner approved all five; deploy/drift-reconcile-runbook.md):

| Object | Migrations built | Fix |
|---|---|---|
| `Account_groupId_fkey` | ON DELETE SET NULL (20260817050000_groups); groupId NOT NULL since stage3b | migration 20261103120000_drift_reconcile: RESTRICT (the group-delete race is a 409, no longer a 500) |
| `GroupSymbol.createdAt`, `GroupSymbolConfig.createdAt / updatedAt` | TIMESTAMP(3) | same migration: TIMESTAMPTZ(3), `USING ... AT TIME ZONE 'UTC'` (values unchanged) |
| `MirrorRule.killedAt` | TIMESTAMPTZ(3) | schema.prisma `@db.Timestamptz(3)` |
| `RiskEngineHeartbeat.beatAt` | default clock_timestamp() | schema.prisma `@default(dbgenerated("clock_timestamp()"))` |
| `Transaction.updatedAt` | DEFAULT CURRENT_TIMESTAMP | schema.prisma `@default(now()) @updatedAt` (the default stays) |

**Fixed 2026-11-02: the ticket sequences.** `Order.ticket` and `Deal.ticket` were modeled as
`@default(dbgenerated("nextval(...)"))`. Prisma introspects those columns as `autoincrement()`, so `migrate diff` (and
therefore `migrate dev` / `db push`) wanted to DROP `order_ticket_seq` and `deal_ticket_seq`, which would break every
new order and deal. Both are `@default(autoincrement())` now: the database is unchanged, the client is unchanged (the
database still assigns the ticket), and the diff no longer touches them. Still: never `prisma migrate dev` or
`db push` against a real database here.
