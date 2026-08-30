# VyXTrader — State of Project (for external architect review)

Written 2026-08-30 from the code directly (companion to `docs/PRODUCT-INVENTORY.md`,
which has the full surface-by-surface feature detail this document assumes as read).
No marketing tone. Every claim cites a file. Opinions in §3–§6 are explicitly opinions,
not measured facts — labeled as such.

---

## 1. Where We Stand

Production today: one Vercel-hosted Next.js app (website + all `/api/*` routes,
Prisma Postgres via `db.prisma.io`) is the **live, money-moving system** for every
onboarded broker (ADR-003: the "legacy" path, not the Rust engine). A Rust engine
(`trading-core-server`) runs on a Contabo VPS, fed by one MT5 EA on one broker's own
terminal (`mt5-ea/VyXTraderPriceFeed.mq5`) — it owns the live price feed (`LivePrice`,
`Candle` tables) and nothing else; order placement, fills, balances, and every
backoffice action still run through the Next.js/Prisma path. The Rust order-management
path exists, compiles, has 91 passing tests, and has never taken a real order.

Measured numbers that exist: tick-to-engine latency (`ea_to_engine_ms_p50/p95`, engine
`/internal/feed-stats`), DB write lag (`db_lag_ms`), and clock-sync offset/RTT — all
real, all currently only visible on Manager's Feed Health page
(`app/manage/(shell)/feed-health`). No production uptime number, no order-ack latency
number, and no fill-quality number exist anywhere (§5).

What a broker can actually do today: onboard, brand their own subdomain, configure
symbols/spreads/groups, run KYC and funds requests **manually** (no PSP, no ID
verification provider, no email/SMS — see `PRODUCT-INVENTORY.md` §5), staff a dealing
desk, and let clients trade a single MT5 terminal's live price feed for real money, with
Manager/Super Admin oversight. What a broker cannot do: rely on a redundant price feed
(one terminal is a single point of failure), get automated deposits, prove uptime/SLA to
an enterprise client, or trust that Manager/Broker-Admin logins are protected by 2FA
(`docs/PRODUCT-INVENTORY.md` §1.3).

---

## 2. Done vs Remaining

### WebTrader
| | Status | Notes |
|---|---|---|
| Core trading (ticket, positions, chart, STM) | DONE | See inventory §1.1 |
| Most important gap | **Price alerts are 100% client-side mock state** — a full UI (modal, bell badge, "+ New alert") backed by nothing (`WebTrader.tsx`'s `Alert` type/`alerts` state, zero `lib/trade-api.ts` calls) |

### Desktop (Tauri)
| | Status | Notes |
|---|---|---|
| Trader Terminal | DONE | Session persistence, tray, notifications, frameless window |
| Manager / Super Admin desktop | PARTIAL | No session persistence across restart, no tray/notifications |
| Most important gap | Until today, WebView2's default browser context menu and F5/Ctrl+R/F12 accelerator keys were never disabled in any of the 3 apps (`main.rs`) — a packaged native app still looked/behaved like a browser tab. Fixed this session, **not yet verified by a human click/keypress test**. |

### Backoffice (Manager)
| | Status | Notes |
|---|---|---|
| CRUD/config surfaces (accounts, groups, symbols, KYC review, transfers) | DONE | Real, Prisma-backed |
| Dealing desk queue/requote | DONE, event-driven (this session) | |
| Most important gap | **No pre-trade margin-level check anywhere on the live order path** (see §3, #1) — exposure/lot/session limits exist, a real margin/leverage gate at order-placement time does not |

### Super Admin
| | Status | Notes |
|---|---|---|
| Tenant CRUD | DONE | |
| Most important gap | **Billing is 100% decorative** (`lib/billing.ts`'s own comment: "not wired to any real payment processor") — a SaaS platform onboarding paying brokers currently has no way to actually bill them |

### Engine (Rust)
| | Status | Notes |
|---|---|---|
| Price ingest, candle aggregation, gap-fill, margin/risk/execution math | DONE, 91 tests passing | Never exercised against real trading traffic |
| Order-management path | Compiles, tested in isolation, **never live** | `ADR-003`; `engine/parallel-run` exists specifically because the two paths are known to diverge in real ways (see §3, #1) |
| Most important gap | No broker has ever been cut over to it — it is unproven under real load/real money |

### Bridge / LP
| | Status | Notes |
|---|---|---|
| Everything | **MISSING** | `LiquidityProvider`/`LpRoutingRule` are explicitly record-keeping only, by their own schema comments (verified, not assumed) — there is no bridge to be "partial" |
| Most important gap | The entire book is effectively B-book against one MT5 terminal's own feed; there is no hedge execution anywhere in the codebase |

### CRM
| | Status | Notes |
|---|---|---|
| Lead pipeline, convert-to-account | DONE | Basic |
| Most important gap | No email/marketing automation of any kind exists (no email/SMS library anywhere in the repo, confirmed by grep) |

### Client cabinet
| | Status | Notes |
|---|---|---|
| Account summary, KYC, funds requests, security, sessions | DONE | Inside WebTrader itself — there is no separate "client cabinet" surface |
| Most important gap | Funds requests have no payment rail behind them — a client's "deposit" is a form submission an admin must manually mark complete |

### Integrations
| | Status | Notes |
|---|---|---|
| MT5 EA price feed, Finnhub news | Real | |
| PSP, email/SMS, KYC provider, LP/FIX | **MISSING** | All confirmed zero matches by grep, not assumed absent (`PRODUCT-INVENTORY.md` §5) |

### Infra / Security
| | Status | Notes |
|---|---|---|
| Trader session (Redis-backed, revocable, now remember-me-aware) | DONE | This session's own fix |
| Admin session (JWT, no revocation store) | PARTIAL | See §3, #4 |
| Tenant isolation | PARTIAL, application-enforced only | See §3, #3 |
| Most important gap | Zero automated tests on the entire TypeScript/Next.js codebase — every website route, every dollar-moving code path, is only checked by `tsc`/`eslint`/`build` |

---

## 3. Wrong Decisions

Opinions below are mine, formed from reading the code this session and the sessions
before it — not measured facts. Ranked roughly by how much they'd cost to leave
unfixed, not by how expensive they are to fix.

**1. Two parallel order-execution implementations that must stay behaviorally
equivalent (ADR-003).** The legacy Next.js/Prisma path is live; the Rust engine's own
order-management path is fully built, tested, and has never taken an order. Confirmed
via `engine/parallel-run/src/main.rs`'s own doc comment: investigation for that tool
found the premise of "run the same order through both, assert equivalence" **doesn't
hold** — the legacy path does exposure/lot/session checks but has no pre-trade margin
gate and fills at whatever price the client's own browser supplies
(`app/api/trade/orders/route.ts`'s own comment: "Prices are simulated client-side... the
client supplies the price it wants to transact at, and MARKET orders fill immediately at
that price"), while the Rust engine always fetches its own server-side price and does
full margin gating. These are not two implementations of the same spec; they are two
different specs. Every day this persists is a day a bug fix or a new risk rule has to be
written twice (or, more likely, only once, silently drifting the two further apart).
**Cost to fix:** genuinely hard to estimate honestly — either finish cutting a real
broker over to Rust and delete the legacy order path, or delete the Rust order path and
stop pretending it's a migration in progress. Both are multi-week efforts, not a patch.
**Must fix before first paying tenant:** the current state (legacy, unaudited-for-margin-
gating path) is what a paying tenant already inherits — this isn't blocking, it's already
the reality; what's not acceptable is continuing to invest engineering time maintaining
a second path that's never used.

**2. No pre-trade margin/leverage check on the live order path.** Confirmed directly:
`app/api/trade/orders/route.ts` checks `checkMaxOpenPositions`, `checkSymbolExposure`,
`checkBrokerExposure`, `checkMaxDailyLoss` (`lib/risk.ts`) — all *configured caps*, none
of which compute the account's projected margin level after the order. `lib/risk-monitor.ts`
only reacts *after* a position is already open (SL/TP, margin-call/stop-out force-close).
A client can open a position that immediately drops them below margin-call level with
zero pre-trade warning or rejection — this is the single most consequential gap for
actually running a broker on this platform with real client money. **Cost to fix:**
low-to-medium — the margin math already exists (`lib/margin.ts`, `engine/margin`); this
is wiring a pre-trade check into one route, not new math. **Must fix before first paying
tenant with real leverage exposure: yes.**

**3. Multi-tenancy is enforced entirely at the application layer, not the database.**
Every query in `app/api/manage/**`/`app/api/trade/**` manually filters by
`session.brokerId` (spot-checked: `app/api/manage/accounts/route.ts:35,101,138` — this
pattern repeats across dozens of routes). There is no Postgres Row-Level Security, no
per-tenant schema, no per-tenant database. This is a common, legitimate SaaS pattern —
it is not automatically wrong — but it means **a single missed `WHERE brokerId = ...`
filter in a new route is a direct cross-tenant data leak**, and nothing in the stack
would catch it before a code reviewer does. With one broker live today this is a latent
risk; with ten it's a matter of time. **Cost to fix:** medium — RLS policies on the
highest-risk tables (`Account`, `Transaction`, `Order`, `Position`, `KycRecord`) as a
defense-in-depth layer under the existing app-level checks, not a rewrite. **Must fix
before first paying tenant:** no, but should be scheduled before broker count grows past
a handful.

**4. Admin sessions are a bare JWT with no server-side revocation store.**
(`lib/auth.ts`, `jose`/HS256) — a Manager/Broker-Admin/Super-Admin session token, once
issued, is valid until its own expiry (7–30 days) no matter what happens to the
`AdminUser` row in between; only a fresh permission check (`lib/permissions.ts`) catches
a disabled/demoted admin, and only on routes that call it. The trader session
(`lib/account-auth.ts`) already solved this correctly — Redis-backed, immediately
revocable. The admin session should have been built the same way from the start; it
wasn't. **Cost to fix:** low-to-medium — port the same Redis-backed-opaque-token
pattern from `lib/account-auth.ts` onto the admin session. **Must fix before first
paying tenant:** not blocking, but this is the kind of gap a security-conscious
enterprise broker will ask about directly.

**5. The entire live price feed is one broker's own MT5 terminal.**
(`mt5-ea/VyXTraderPriceFeed.mq5`, its own header comment: "Temporary bridge — Phase 5
replaces this with a real LP feed.") No redundancy, no failover, no second source. If
that one terminal disconnects, every broker on the platform loses live pricing
simultaneously (confirmed: the engine has no other tick producer). This was always
known and documented as temporary — flagging it here because "temporary" has now
persisted across every broker onboarded to date, not just the first. **Cost to fix:** a
real LP/FIX integration is a multi-week vendor-integration project, not something this
document can size honestly without knowing which LP. **Must fix before first paying
tenant:** arguable — depends entirely on whether that tenant is told this plainly.

**6. Zero automated tests on the TypeScript/Next.js side.** Every dollar-moving route
(`app/api/trade/orders`, `funds-requests`, `positions/[id]/close`, every `app/api/manage/**`
mutation) is checked only by `tsc --noEmit`/`eslint`/`next build` — none of which
execute the actual business logic. The Rust engine, by contrast, has 91 real tests.
This asymmetry means the side that's actually live and moving money is the side with
zero regression protection. **Cost to fix:** medium-large as an ongoing investment (this
isn't a one-time fix, it's a practice change) — start with the highest-risk paths
(order placement, fund approval, KYC decision, balance adjustment) rather than
attempting full coverage at once. **Must fix before first paying tenant:** should have
started already; not a hard blocker but the single highest-leverage investment left
unmade.

**7. Klinecharts and Tauri are fine choices — flagged only because the brief that led to
this review assumed different libraries (lightweight-charts) and a browser-like desktop
experience wasn't caught until a user reported it live.** Neither is a wrong
architectural decision. What was wrong was **shipping the Tauri apps without disabling
WebView2's default browser behaviors** (context menu, F5 reload, DevTools) — a
five-minute configuration step in any production Tauri app, missed across all three
apps until this session. Already fixed (`19b85cd`), not yet human-verified.

**8. NATS is reasonable, not over-engineered, given where this is headed** — one opinion
worth stating since "NATS vs alternatives" was explicitly asked: for a single-Postgres,
single-Contabo-box deployment serving a handful of brokers, NATS is doing real work
(price fan-out, the new admin event stream) and isn't idle infrastructure. It would be
over-engineered if this stayed single-tenant forever; it isn't, so this is a reasonable
bet already partially paying off.

**9. Money/Decimal handling is correct, not wrong** — worth stating plainly since it was
explicitly asked about: `prisma/schema.prisma`'s own top comment ("All money/price/
volume fields use Decimal — never Float") holds throughout the schema, confirmed while
reading it for `PRODUCT-INVENTORY.md`. This is not a finding, it's a clean bill of
health on a place platforms commonly get wrong.

---

## 4. Risks (ranked)

1. **No pre-trade margin check (§3 #2)** — a client can open a position that
   immediately triggers margin call/stop-out with no warning. Real money loss risk,
   and a real "why did your platform let me do this" support/legal exposure.
2. **Single MT5 terminal as the only price source (§3 #5)** — one disconnected
   terminal takes every broker's pricing down simultaneously.
3. **Legacy order path fills at a client-supplied price** (`app/api/trade/orders/route.ts`'s
   own comment) with only a freshness/deviation check (`evaluateLiveMarketPrice`) — a
   narrower version of the exploit class `lib/risk.ts`'s `checkLiveMarketPrice` was
   already built to close (per its own comment) means the mitigation is known-partial,
   not known-solved.
4. **Tenant isolation depends on every route remembering `brokerId`** (§3 #3) — one
   missed filter is a cross-tenant data leak of real client financial data.
5. **Admin sessions can't be revoked early (§3 #4)** — a compromised or fired admin's
   token remains valid for up to 30 days.
6. **No 2FA for Manager/Broker-Admin/Support** (`PRODUCT-INVENTORY.md` §1.3) — the
   role with the broadest single-tenant financial authority has weaker login security
   than an individual trader.
7. **Zero automated tests on every money-moving TS route (§3 #6)** — a regression in
   order placement, fund approval, or balance adjustment ships the moment it compiles.
8. **Price alerts UI is fully fake** — cosmetically minor, but a client-facing feature
   that visibly does nothing (survives a refresh check) is a real credibility risk in a
   live demo or a paying client's hands.
9. **Billing is entirely decorative** — onboarding a paying broker today has no system
   path to actually collect payment from them; this would be discovered the moment
   someone tried.
10. **`Broker.executionEngine` toggle is a real UI control that does nothing**
    (`PRODUCT-INVENTORY.md` §1.5) — a Super Admin flipping "Rust" believing it changes
    execution behavior is a real UI-honesty problem, not just a missing feature.

---

## 5. Measurements

**What's measured today (real, confirmed):**
- Tick-to-engine latency: `ea_to_engine_ms_last/p50/p95` (`engine/market-data/src/stats.rs`)
- DB write lag/failures: `db_lag_ms`, `db_ok`/`db_fail` (same file)
- Clock-sync offset/RTT between the EA and engine: `mono_to_utc_offset_ms`/`rtt_ms`
- Per-symbol tick freshness/rate: `per_symbol[]` (`engine/server/src/main.rs`)
- Gateway WS connection/disconnection/forward counters (`services/api-gateway/src/ws.ts`)
- Postgres health check latency: `app/api/admin/health/route.ts` (the only *real* row of
  4 on that page — the other 3 are hardcoded "unmonitored", `PRODUCT-INVENTORY.md` §1.5)

**What a broker platform must measure that this one doesn't, at all:**
- **Order ack latency** — time from order submission to a fill/reject response. No
  instrumentation anywhere in `app/api/trade/orders/route.ts` or the Rust order path.
- **Fill quality** — slippage between requested and filled price, distribution over
  time. Not tracked; `requestedPrice` and `filledPrice` both exist on `Order` but nothing
  aggregates the difference.
- **Uptime/SLA** — no uptime tracking of any kind exists; `app/api/admin/health`'s
  3-of-4-hardcoded state is the entirety of platform health visibility today.
- **Reconciliation** — no scheduled job compares Postgres balances against anything
  external (a real LP, a real bank/PSP ledger) because there is nothing external to
  reconcile against yet; `engine/parallel-run` reconciles the two *internal* order paths
  against each other for engineering purposes, not production financial reconciliation.
- **Margin-call/stop-out effectiveness** — `lib/risk-monitor.ts` runs; nothing measures
  how often it fires, how late, or whether it prevented a negative balance.

---

## 6. Recommended Order (next 12 weeks, my own view)

This is a judgment call, not a measured plan — sequenced by "what would most damage a
real paying tenant if left as-is," not by implementation convenience.

**Weeks 1–2 — stop the money risk.** Pre-trade margin/leverage check on the live order
path (§3 #2). This is the one item on this whole list that can directly cause a client
(or the broker) to lose money beyond what any risk setting intended. Ship it before
anything else on this list.

**Weeks 2–4 — close the two biggest trust gaps.** Admin session revocation (§3 #4) and
2FA for Manager/Broker-Admin/Support. Both are bounded, well-understood changes (the
trader-session pattern already exists to copy); both are the first things a
security-literate broker or auditor will ask about.

**Weeks 3–6 — start real test coverage on money paths, in parallel with the above.**
Order placement, fund approval, KYC decision, balance adjustment, position close. Not
full coverage — the four or five routes where a silent regression costs real money.

**Weeks 5–8 — tenant isolation defense-in-depth.** RLS policies on `Account`,
`Transaction`, `Order`, `Position`, `KycRecord` as a second layer under the existing
app-level `brokerId` filters. Cheap insurance relative to the cost of a real leak.

**Weeks 6–10 — decide the two-order-path question (§3 #1) and stop straddling it.**
Either commit to cutting a real (low-risk, high-trust) broker over to the Rust engine
with a real rollback plan, or formally retire the Rust order-management path and stop
carrying its maintenance cost. Both are legitimate answers; "still deciding" a year in
is not.

**Weeks 8–12 — pick one real integration and make it real: LP feed *or* PSP.** Not
both — pick whichever the actual go-to-market plan needs first. A platform that still
has zero of {redundant price feed, real payment rail} after this window is still, by
its own numbers, a demo-grade platform wearing a production skin. Billing (§4 #9) and
price alerts (§4 #8) are cheap wins that can land alongside this window without
displacing it.

Everything else in §3/§4 not listed above (klinecharts/Tauri config, `executionEngine`
toggle honesty, NATS) is real but small enough to fold into whichever week has spare
capacity — none of it should set the pace of this plan.
