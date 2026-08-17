# Database

**Implementation status:** the `orders`/`positions`/`ledger_entries`
schema in §2-3 exists as a real migration
(`engine/migrations/20260813000000_trading_core_tables.sql`), has been
applied to the live Neon database (same manual Neon SQL Editor process as
the existing `prisma/migrations/*` files), and is written to by
`order-management::db`.

## 1. Today

One Neon PostgreSQL instance, accessed exclusively through Prisma
(pinned to v6.19.3). Pooled `DATABASE_URL` for app traffic, unpooled
`DIRECT_URL` for migrations — standard Neon/Prisma setup. Current models:
`Broker`, `AdminUser`, `Account`, `KycRecord`, `Transaction`, `Symbol`,
`LivePrice`, `Candle`, `BrokerSymbol`, `Order`, `Position`,
`IbRelationship`, `AuditLog`. Every money/price/volume field is `Decimal`
— this rule is already enforced and carries forward unchanged into the
Rust core (`rust_decimal`, per ADR-004).

Migrations are hand-written SQL files under `prisma/migrations/`, applied
manually via Neon's SQL Editor in this engagement (no live DB connection
from the working environment) rather than `prisma migrate deploy` — worth
noting here since it means migration discipline has been "write correct
SQL by hand," not "trust the Prisma-generated diff blindly."

## 2. Target: ownership split (per ADR-002)

**One Postgres instance, not two.** Table ownership splits by writer, not
by database:

| Table family | Owner | Notes |
|---|---|---|
| `Broker`, `AdminUser`, `Account`, `KycRecord`, `Symbol`, `BrokerSymbol`, `IbRelationship`, `AuditLog` | Prisma / Next.js (unchanged) | Config/CRM-shaped, not latency-critical — matches spec §1's guidance to keep this in TypeScript |
| `LivePrice`, `Candle` | Rust Market Data Core | Already the sole writer today; no ownership change, just a process migration (see `market-data.md`) |
| `orders`, `positions`, `ledger_entries` (new Rust-owned tables) | Rust Trading Core (OMS) | New tables, not a rename of the existing `Order`/`Position` — see §3 |
| `Transaction` (existing) | Prisma, until superseded | Stays as-is for brokers not yet cut over; `ledger_entries` is its Rust-owned replacement once a broker migrates |

This directly matches spec §16 ("PostgreSQL is the authoritative
source... Never make Redis the authoritative financial database") without
deviation — one authoritative instance, per-table ownership.

## 3. New vs. renamed: why `orders`/`positions` aren't just `Order`/`Position` again

The existing Prisma `Order`/`Position` tables keep serving brokers still
on the current Next.js trading path (per ADR-003 — that path stays live,
unmodified, during the Rust core's build-out). The Rust OMS gets its own
new tables rather than taking over the existing ones in place, because a
broker is either fully on the old path or fully on the new one — never
split mid-flight — and that's only possible if both schemas can exist
side by side without colliding. Naming convention: Rust-owned tables use
`snake_case` table names (`orders`, `positions`, `ledger_entries`) vs.
Prisma's `PascalCase` (`Order`, `Position`) specifically so the two are
never visually confusable in a `\dt` listing or a migration diff.

## 4. Demo-data migration

Existing seeded data (`AcmeFX`/`Nova Markets` demo brokers, their demo
accounts, any positions opened during this engagement's testing) is
pre-production and low-value to migrate faithfully. Per `architecture.md`
Decision 2: **re-seed rather than migrate** when a broker actually cuts
over to the Rust tables — a one-time seed script creates fresh
`orders`/`positions`/`ledger_entries` rows for that broker's demo
accounts rather than transforming the old rows. Real broker/account data
(anything a broker admin created, KYC records, actual balances) is
untouched either way since it lives in the Prisma-owned tables that don't
move.

## 5. Open questions for Phase 1

- Exact `ledger_entries` schema (double-entry vs single-row-per-transaction)
  — the current `Transaction` model is single-row; a real ledger for the
  Rust core should probably be double-entry for audit correctness, but
  that's a new design decision, not a migration of the existing shape.
- Whether Rust connects via `sqlx` or `diesel` — implementation detail,
  not architectural; left to Phase 1.

## 6. `DateTime` columns weren't timezone-aware — fixed

Every `DateTime` field in `schema.prisma` (`LivePrice.updatedAt`,
`Order`/`Position`/`Account` timestamps, etc.) maps to Postgres
`timestamp without time zone` by default — none have `@db.Timestamptz`.
Found while building the Manager positions dashboard
(`app/manage/positions/page.tsx`): comparing `LivePrice.updatedAt`
against `Date.now()` in JavaScript (via `prisma.livePrice.findMany` +
a client-side comparison) silently produced a multi-hour-wrong
staleness result — a value written seconds earlier showed as hours
stale. Root cause: a `timestamp without time zone` value round-tripped
through a Node driver gets interpreted in whatever timezone the
*client machine* is set to, not UTC, so the same stored value reads
differently depending on where the reading process runs.

This doesn't affect any comparison done entirely inside Postgres (the
Rust engine's own staleness checks — `market_data::db::get_live_price`,
`order_management::db::get_open_positions_with_market` — compare
`updatedAt` against Postgres's own `now()` in the same query, which
stays internally consistent regardless of the column's tz-naive
storage) — only cross-language/client-side comparisons of these columns
are at risk. Worked around locally in the positions dashboard by moving
the comparison into a raw SQL query (`prisma.$queryRaw`, mirroring the
Rust engine's approach) rather than fixing the schema.

**Fixed, as its own follow-up change** (the user explicitly asked for
this after the dashboard work flagged it — not silently expanded into
an unrelated change). Every `DateTime` field across all 13 Prisma models
(25 columns total — full list in
`prisma/migrations/20260817040000_timestamptz/migration.sql`) now
carries `@db.Timestamptz(3)`. Migration:
`ALTER TABLE ... ALTER COLUMN "col" TYPE TIMESTAMPTZ(3) USING "col" AT
TIME ZONE 'UTC'` — safe specifically because every existing row was
written with the Postgres session timezone at GMT (confirmed via `SHOW
timezone`), so the naive stored digits already *are* the correct UTC
instant; `AT TIME ZONE 'UTC'` just promotes them to a properly-tagged
timestamptz without shifting anything. Applied atomically (one
transaction, all 26 `ALTER COLUMN` statements — `Candle.bucketStart` is
part of that table's composite primary key, changing its type in place
preserves the underlying instant and therefore uniqueness).

Verified live: captured `Broker.createdAt`, `AdminUser.lastLoginAt`, and
`LivePrice.updatedAt` as raw text before and after — wall-clock digits
identical, only the offset suffix (`+00`) was added, confirming no data
shift. Re-ran the exact repro that first surfaced this (write a fresh
`LivePrice` row, read it back via a plain Node `pg` client, compute
`Date.now() - updatedAt.getTime()` client-side) — now correctly reports
an age in the hundreds of milliseconds instead of hours. Both Manager
screens (`/manage/symbols`, `/manage/positions`) re-verified working
against the migrated schema with no regressions.

The Rust-owned tables (`orders`/`positions`/`ledger_entries`,
`engine/migrations`) were never affected by this — they already declared
`TIMESTAMPTZ` from the start.
