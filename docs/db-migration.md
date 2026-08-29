# Database Migration: Prisma Postgres → Neon (Frankfurt)

Moves the entire live database — every table, both Prisma-managed
(`prisma/schema.prisma`) and Rust-owned (`engine/migrations/*.sql`,
`orders`/`positions`/`ledger_entries`) — from the current host
(`db.prisma.io`, Prisma's own managed Postgres) to a Neon project in the
Frankfurt region, for lower latency to the Contabo VPS (London) than
whatever region `db.prisma.io` currently runs in.

**This is a full physical dump/restore, not a schema-only migration.**
`pg_dump`/`pg_restore` operate on the raw database regardless of which
tool created a given table, so this captures Prisma-managed and
Rust-owned tables identically in one pass — there is no separate step
needed for the Rust side.

## 0. Prerequisites

- A Neon project already created in the **Frankfurt (eu-central-1)**
  region, with both connection strings noted:
  - **Pooled** (for Vercel and the gateway) — the one with
    `-pooler` in the hostname.
  - **Direct/non-pooled** (for the Rust engine) — no `-pooler`.
- `pg_dump`/`pg_restore` installed locally or on whichever machine runs
  the migration (matching or newer major version than both source and
  target Postgres — check with `pg_dump --version`).
- **Never paste either connection string into chat, a commit, or a log
  file.** Two ways to give them to `deploy/migrate.ps1`, in priority
  order (an already-set shell variable wins over the file, so a one-off
  override never requires editing anything):
  1. `$env:SOURCE_DATABASE_URL` / `$env:TARGET_DATABASE_URL` set in your
     own shell for the duration of the migration, unset when done.
  2. `SOURCE_DATABASE_URL=...` / `TARGET_DATABASE_URL=...` lines added to
     the repo's own `.env` (the same file `DATABASE_URL`/`DIRECT_URL`
     already live in) — confirmed gitignored (`.gitignore`'s `.env*`
     pattern) and never tracked, so this is a safe, persistent place for
     both rather than re-typing them into a shell every session.
  Either way, this doc and `deploy/migrate.ps1` only ever reference them
  as `$env:SOURCE_DATABASE_URL` / `$env:TARGET_DATABASE_URL` — never a
  literal value.
- `SOURCE_DATABASE_URL` must be the **direct** (non-Accelerate) Prisma
  connection string — the `.env` var named `DIRECT_URL`, not
  `DATABASE_URL` (`DATABASE_URL` is a `prisma+postgres://` Accelerate
  proxy URL; `pg_dump` needs a real `postgres://` libpq connection, which
  `DIRECT_URL` already is).

## 1. Dump the source

```powershell
$env:SOURCE_DATABASE_URL = "postgres://...direct-prisma-url..."
pg_dump "$env:SOURCE_DATABASE_URL" --no-owner --format=custom --file=vyxtrader.backup
```

`--no-owner`: the dump's role names won't exist on Neon (Prisma's
internal role, not something you control there) — without this,
`pg_restore` fails trying to `ALTER ... OWNER TO` a role Neon has never
heard of. `--format=custom` (not plain SQL) so `pg_restore` can do a
single-transaction, dependency-ordered restore and report per-object
errors cleanly.

## 2. Restore into Neon

```powershell
$env:TARGET_DATABASE_URL = "postgres://...neon-direct-url.../<db>?sslmode=require"
pg_restore --no-owner --dbname="$env:TARGET_DATABASE_URL" vyxtrader.backup
```

## 3. `prisma migrate deploy` check

```powershell
$env:DATABASE_URL = "$env:TARGET_DATABASE_URL"
npx prisma migrate status
```

Expected: **"Database schema is up to date"**. The dump/restore already
carried `_prisma_migrations` over as a regular table (it's just another
table in the `public` schema) — this single ledger tracks both
`prisma/migrations/*` and the Rust-owned `engine/migrations/*.sql` files
together (confirmed in `docs/architecture.md`'s own migration-history-gap
incident: every migration from both directories gets recorded into the
same `_prisma_migrations` table), so this one check covers the whole
schema, not just the Prisma-authored half. If it reports pending
migrations instead, the restore is incomplete — do not proceed to step 6
until this is clean.

## 4. Sequence reset

**Not applicable to this schema.** Checked directly: there are zero
`SERIAL`/`BIGSERIAL`/`GENERATED ... AS IDENTITY` columns anywhere in
either `prisma/schema.prisma` or `engine/migrations/*.sql` — every
primary key across the whole database (Prisma-managed and Rust-owned
alike) is a client-generated `TEXT`/`cuid()`-style id. There are no
Postgres sequences to fall out of sync after a restore. Kept as its own
numbered step here (rather than silently dropped) so a future schema
change that *does* introduce a serial column doesn't silently skip this —
re-check this claim if a migration ever adds one.

## 5. Row-count verification per table

```powershell
# Run against BOTH source and target, compare the two outputs by eye
# (or diff them) -- every row count must match exactly.
$query = @"
SELECT schemaname, relname AS table_name, n_live_tup AS approx_row_count
FROM pg_stat_user_tables
ORDER BY relname;
"@
psql "$env:SOURCE_DATABASE_URL" -c $query
psql "$env:TARGET_DATABASE_URL" -c $query
```

`n_live_tup` is an estimate refreshed by autovacuum/analyze, not a live
`COUNT(*)` — for the final go/no-go, `deploy/migrate.ps1`'s `-Verify`
step instead runs an exact `SELECT COUNT(*)` per table (see below); the
`pg_stat_user_tables` query above is only a fast eyeball check while
you're working interactively.

## 6. `DATABASE_URL` swap

Three places, each with a **different** connection string shape:

| Where | Value | Why |
|---|---|---|
| Vercel production env (`DATABASE_URL`) | Neon **pooled** URL | The Next.js app makes many short-lived serverless-function connections — exactly what a pooler is for. |
| Contabo `start-engine.cmd` (`DATABASE_URL`) | Neon **direct/non-pooled** URL | The whole point of this migration (`docs/market-data.md` §7) — the engine's LivePrice/Candle flush loops are a tight, frequent-small-write path; a pooler adds latency/contention there a long-lived process doesn't need to pay. |
| Contabo `start-gateway.cmd` (`DATABASE_URL`) | Neon **pooled** URL | The gateway's own queries (`services/api-gateway/src/db.ts`) are on-demand REST/WS handlers, not a tick loop — pooled is fine, same reasoning as Vercel. |

```powershell
# Vercel (run from the repo root, requires the Vercel CLI already logged in)
npx vercel env rm DATABASE_URL production
npx vercel env add DATABASE_URL production
# (paste the Neon POOLED url when prompted -- never as a command-line arg,
# which would land in shell history)
```

Contabo: edit `start-engine.cmd`'s `DATABASE_URL` line to the Neon
**direct** URL, `start-gateway.cmd`'s to the Neon **pooled** URL, then
restart both services (engine first, then gateway — same order
`deploy/contabo-deploy.ps1` already uses).

## Rollback

This is a dump + restore, not a destructive move — **the source
(`db.prisma.io`) is never modified, touched, or deleted at any point**.
Rollback is just reverting `DATABASE_URL` back to the original Prisma
connection string in all three places above and restarting the two
Contabo services. No data written to Neon *after* the cutover (new
trades, ticks, etc.) carries over on a rollback — this is a point-in-time
cutover, not ongoing replication, so treat the rollback window as "before
real traffic starts hitting Neon," not "any time later."

## `deploy/migrate.ps1`

Automates steps 1, 2, and 5 (dump → restore → row-count verify) with a
`-DryRun` switch that runs `pg_dump`/`pg_restore` in list-only/no-op modes
to sanity-check connectivity and object counts without writing anything
to the target. Does **not** automate step 6 (the `DATABASE_URL` swap) —
that touches Vercel and two live Contabo services and stays a deliberate,
separate action after you've reviewed this script's own verification
output.
