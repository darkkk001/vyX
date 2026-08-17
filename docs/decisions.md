# Architecture Decision Record

Format: one entry per decision. Status is one of `Proposed`, `Accepted`,
`Rejected`, `Superseded`. Proposed entries are open questions — see
`architecture.md` §6 for full context on ADR-001 through ADR-003.

---

## ADR-001 — Desktop shell: Electron vs Tauri

**Status:** Accepted — **Tauri**, per explicit direction.

**Context:** A working Electron desktop app exists from earlier in this
engagement (frameless title bar, tray, notifications, auto-update,
per-broker rebrand tooling). It stays in place and keeps working as-is —
nothing about it breaks today — but the target desktop app for the
Trading Core ecosystem (Phase 4) is built in Tauri, not evolved from the
Electron shell.

**Decision:** Tauri for the new desktop workstation (Phase 4). The
existing Electron app (`desktop/`) is not deleted; it continues to serve
the current Next.js-only web app until Phase 4 replaces it. Migration
notes captured in `deployment.md`.

---

## ADR-002 — Trading Core data ownership boundary

**Status:** Accepted (2026-08-17 — formalizing what the code already does)

**Context:** The Rust Trading Core needs authoritative tables for orders,
positions, and ledger entries. Today those are Prisma-owned
(`Order`, `Position`, `Transaction`) in the same Neon Postgres instance
that also holds `Broker`/`AdminUser`/`Account`/`KycRecord`/`Symbol`/etc.

**Options:**
- (a) Same Postgres instance, new Rust-owned tables for trading data;
  Prisma keeps owning config/CRM-shaped data only
- (b) Fully separate Postgres instance for the Trading Core, synced to
  the web app's database via events

**Recommendation:** (a) — one authoritative Postgres instance, clear
per-table ownership, no cross-database consistency problem to solve.

**Decision:** (a). Found sitting as "pending" during the cancel/modify
order-support work despite `engine/migrations/20260813000000_trading_core_tables.sql`
already implementing exactly this — snake_case `orders`/`positions`/
`ledger_entries` tables in the same Postgres instance, deliberately not
foreign-keyed to Prisma's tables. A real doc/reality gap, closed the same
way other stale-doc findings were fixed this session, not a new decision.

---

## ADR-003 — Cutover strategy while the Rust core is being built

**Status:** Accepted (2026-08-17 — formalizing what the code already does)

**Context:** Spec Phase 1-2 implies a build-out period where the Rust core
exists but isn't finished. The current Next.js/Prisma order-placement path
(`app/api/trade/orders`, `lib/trading.ts`) is live today.

**Options:**
- Keep the current Next.js trading path running unmodified during Rust
  core development, cut over broker-by-broker once the Rust core passes
  its test/benchmark gates
- Freeze/disable live trading now until the Rust core is ready

**Recommendation:** Keep the current path running — matches the project
rule against destroying working functionality mid-rewrite.

**Decision:** Keep the current path running. Same as ADR-002, found
still "pending" while every relevant piece of code (the Next.js path
untouched, `services/api-gateway` a new parallel surface nothing routes
through yet) already acts on this recommendation. Formalized here rather
than left inconsistent. **Not yet satisfied**: no broker-selection
mechanism exists anywhere (no `Broker` field, no code flag) to actually
route a given broker to one path or the other when cutover is eventually
triggered, and the parallel-run comparison infrastructure `testing.md`
§4 calls for is explicitly not built. Accepting the *strategy* here
doesn't mean cutover is ready — see `trading-engine.md`'s
implementation-status note for what's actually done so far (cancel/modify
order support, as of this same date) versus what cutover itself still
needs.

---

## ADR-004 — Money representation

**Status:** Accepted (no conflict — already the existing practice)

**Context:** Spec §3 requires fixed-point/decimal money, never floating
point.

**Decision:** Continue using `Decimal` (Prisma) / fixed-point equivalents
in Rust (e.g. `rust_decimal`) for every price, quantity, commission, swap,
and balance field. This is already how the current schema works — no
change needed, just carries forward as a hard constraint into the Rust
core.

---

## ADR-005 — Messaging: NATS over Kafka

**Status:** Accepted (spec default, no current system to conflict with)

**Context:** Spec §1 prefers NATS "unless a documented requirement
justifies Kafka." No internal event bus exists today.

**Decision:** NATS. Nothing in the current system's scale or delivery
guarantees needs Kafka's log-retention/replay model; NATS's simplicity
and lower operational overhead fit a system this size better. Revisit
only if a specific requirement (e.g. long-term event replay for
compliance) surfaces that NATS JetStream can't satisfy either.

---

## ADR-006 — Order state machine superset

**Status:** Accepted

**Context:** Current `OrderStatus` enum is
`PENDING → ACCEPTED → FILLED/REJECTED/CANCELLED`. Spec's target state
machine adds `NEW`, `VALIDATING`, `ROUTING`, `PARTIALLY_FILLED`.

**Decision:** Adopt the spec's fuller state machine in the Rust core (see
`architecture.md` §5). The current simplified enum was an explicit,
documented stopgap ("MARKET orders trust the client-supplied execution
price until Phase 5's real matching engine exists") — this is exactly
that Phase 5 arriving.
