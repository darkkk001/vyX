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

**Update (2026-08-17) — core shell built.** `desktop-tauri/` is a
frameless window pointed at a broker's deployed WebTrader, matching the
exact `window.vyxDesktop` contract the web app already consumes from the
Electron app (confirmed by reading `WebTrader.tsx`/`DesktopTitleBar.tsx`
directly — every desktop-only behavior there gates on that one global's
shape, not on anything Electron-specific), via a Tauri
`initialization_script` that wraps three custom commands
(`win_minimize`/`win_toggle_maximize`/`win_close`) plus a diffed
`maximized-changed` event. Zero web-app changes were needed. Live-
verified: real window process launches (confirmed via the OS process
list, correct title from `broker.config.json`), correctly resolves a
real broker subdomain and loads through to WebTrader's login page (
confirmed via the dev server's own request log showing the exact
navigation sequence a browser would produce). Not visually/pixel
confirmed (no screenshot capability in this sandbox) — same category of
disclosed limitation as this engagement's MT5 EA `.mq5` compile step.

**Not yet at Electron parity** — `deployment.md` §3's own cutover
precondition list is the tracking spec for what's still needed before
any broker could actually rely on this instead of Electron: system tray/
minimize-to-tray, native OS notifications, auto-update
(`tauri-plugin-updater`), the per-broker rebrand CLI equivalent to
`desktop/rebrand.js` (explicitly named in that section as a hard
blocker — "without it, Tauri isn't yet at feature parity for this
project's actual use case," still true), `rememberBroker`/
`forgetBroker` real persistence + launcher/root-domain mode (currently
no-op stubs so the web app's calls don't throw, but they don't do
anything yet), navigation lockdown, splash/offline screens, window-state
persistence across restarts.

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
than left inconsistent. Accepting the *strategy* here doesn't mean
cutover is ready — see `trading-engine.md`'s implementation-status note
for what's actually done so far (cancel/modify order support) versus
what cutover itself still needs.

**Update (2026-08-17):** the broker-selection mechanism this note
originally flagged as missing now exists — `Broker.executionEngine`
(`LEGACY`/`RUST`), settable only by `SUPER_ADMIN` via
`PATCH /api/admin/brokers/[id]` (`app/(super-admin)/brokers`'s new
"Engine" column). **Deliberately inert**: no `app/api/trade/*` route
reads this field yet, on purpose — setting a broker to `RUST` today
changes nothing about how its trades are processed, live-verified by
placing a real order for a `RUST`-flagged broker through the normal
Next.js path and confirming it still landed only in Prisma's `Order`/
`Position` tables, zero rows in the Rust-owned `orders` table. **Still
not satisfied**: the parallel-run comparison infrastructure `testing.md`
§4 calls for, and the test/benchmark gates (`testing.md` §2) themselves
— the switch existing doesn't mean cutover is ready, only that the
mechanism to eventually flip it is in place ahead of those gates
clearing, same ordering ADR-002/ADR-003's original scaffolding-ahead-of-
implementation pattern already used elsewhere (e.g. the `position`/
`ledger` crates).

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
