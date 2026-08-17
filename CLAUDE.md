# VyXTrader

B2B white-label broker trading platform, built for BigFish Technologies LLC.
Brokers sign up, get a subdomain (or custom domain) under `vyxtrader.com`,
and their traders log in to a WebTrader-style terminal to trade against
simulated/live prices.

## Stack

- Next.js 15 (App Router) + TypeScript
- Prisma ORM **pinned to v6.19.3** — do not upgrade to v7 (it requires
  driver-adapter config / `prisma.config.ts` and removes `url` from
  `schema.prisma`; v6 was chosen deliberately for less complexity on a
  solo-dev project)
- PostgreSQL via Neon (`DATABASE_URL` pooled, `DIRECT_URL` unpooled — both
  required in `.env` for Prisma Migrate to work against Neon)
- Deployed on Vercel, domain `vyxtrader.com` with wildcard subdomain
  (`*.vyxtrader.com`) delegated to Vercel's nameservers

## Non-negotiable rules (do not violate these while extending the app)

- Never use floating point for money — use Prisma `Decimal` everywhere
  (balances, prices, volumes, P&L).
- Every balance-changing event must go through a `Transaction` ledger row
  — never silently overwrite `Account.balance`.
- Never delete executed trades/transactions. Corrections are compensating
  entries, not edits or deletes.
- Orders/positions move through an explicit state machine: Order
  `PENDING → ACCEPTED → FILLED/REJECTED/CANCELLED`, Position `OPEN → CLOSED`.
- Every sensitive action (balance adjustment, KYC decision, admin
  permission change, manual position close) needs an `AuditLog` entry.
- Authorization is enforced server-side — the `x-broker-id` header from
  middleware and the session JWT's `brokerId` are cross-checked on every
  trade API route (`lib/account-auth.ts`). Never trust a frontend-only check.
- Order placement is idempotent via `Order.idempotencyKey` (unique per
  `accountId`).

## Architecture

- `middleware.ts` resolves the broker from the request's Host header
  (subdomain or custom domain) via `app/api/internal/resolve-broker`
  (Edge can't use Prisma directly), and attaches `x-broker-*` headers that
  every downstream route/page reads. **Do not narrow the middleware
  matcher to exclude `/api/*`** — it must match `/api/trade/*` too, or
  those routes silently lose broker resolution (this exact bug happened
  once — see the comment in `middleware.ts`).
- Two separate JWT session systems: `vyx_admin_session` (Super
  Admin/broker admins, `lib/auth.ts`) and `vyx_trade_session` (traders,
  `lib/account-auth.ts`). Don't conflate them.
- `components/webtrader/WebTrader.tsx` is the trading terminal, ported
  1:1 from a v0-generated design spec the user provided — layout, class
  names, and behavior should match that spec, not be redesigned. Its
  styling lives in `app/(broker)/trade/webtrader.css`.
- `lib/market-simulator.ts` provides simulated prices (random walk +
  candle aggregation) as a stopgap. `mt5-ea/VyXTraderPriceFeed.mq5` is an
  optional MT5 EA that pushes real bid/ask from a broker's own MT5
  terminal to `POST /api/internal/price-feed` (secret-authenticated),
  which the client polls (`GET /api/trade/prices`) and blends in per
  symbol — ticks older than 15s are treated as stale and it falls back to
  simulation. This is all temporary; Phase 5 replaces it with a real LP
  FIX feed without changing the consumer shape (`{symbol, bid, ask}`).
- `lib/trading.ts` has server-side SL/TP validation and P&L calculation —
  mirror any client-side validation logic here too, server is the source
  of truth.

## Working without a live DB connection

If you can't reach Postgres directly (sandboxed environment, etc.),
generate migration SQL offline instead of running `prisma migrate dev`:

```
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

works with no DB connection for a fresh migration. For incremental
changes against existing migration history, `prisma migrate diff` needs
`--shadow-database-url` (a live DB) — if that's unavailable, hand-write
the migration SQL to match Prisma's naming conventions (see existing
files under `prisma/migrations/`) and have it run manually via the Neon
SQL Editor.

## Build order status

- **Phase 1** (multi-tenancy, broker resolution, Super Admin + trader
  auth) — done, verified live.
- **Phase 2** (WebTrader UI wired to real trade API, idempotent orders,
  ledger-safe position close incl. partial close, MT5 EA live price
  bridge) — done, verified live.
- **Phase 3** (backoffice depth: KYC review flow, real deposit/withdraw
  processing, IB/commission) — done. Deposit/withdraw
  requests are live: a trader submits one from WebTrader's funds modal
  (`app/api/trade/funds-requests`), it sits `PENDING` with balance
  untouched, and a `BROKER_ADMIN` approves or rejects it from the
  Manager app (`app/manage/funds`, `app/api/manage/funds-requests`) —
  only approval moves real balance, through the `Transaction` ledger,
  matching the "no faking a balance change" rule this line used to warn
  about. No payment gateway integration (still a request/ledger tracker,
  not real money movement) and no funds-hold/reservation on a pending
  withdrawal (validated against current balance at both request and
  approval time instead — see `Transaction.reviewedByAdminId`'s schema
  comment). KYC review is also live: a trader uploads front/back ID
  photos via WebTrader's "Verify identity" modal
  (`app/api/trade/kyc`), stored **privately** in Vercel Blob (needs
  `BLOB_READ_WRITE_TOKEN` set to actually work — not configured in
  every environment), and a `BROKER_ADMIN` reviews/approves/rejects
  from `app/manage/kyc` — document images are only ever served through
  an authenticated, broker-scoped proxy route
  (`app/api/manage/kyc-requests/[id]/document`), never a raw Blob URL.
  IB/commission is now also live, closing out Phase 3: a `BROKER_ADMIN`
  links an existing account as the IB for another (`IbRelationship`,
  `app/manage/ib`), and pending commission is calculated on read from
  the client's `CLOSED` `Position`s since `IbRelationship.lastPayoutAt`
  (`PER_LOT`: rate × lots; `PERCENTAGE`: rate% of the broker's own
  trading-commission revenue on those trades — see `lib/commission.ts`).
  No live/automatic payout on every trade — an admin clicks "Pay" to
  move the calculated amount through the `Transaction` ledger onto the
  IB's own account balance (`app/api/manage/ib-relationships`).
- **Phase 4** (desktop) — a working Electron shell already exists
  (`desktop/`: thin WebTrader wrapper, per-broker rebrand tooling,
  auto-update, tray, notifications) and keeps working as-is. Per
  `docs/decisions.md` ADR-001, the actual Trading Core-era desktop app
  is planned in **Tauri**, not evolved from Electron. The Tauri **core
  shell** now exists (`desktop-tauri/`): a frameless window pointed at a
  broker's deployed WebTrader, bridging the exact same `window.vyxDesktop`
  contract (`isDesktop`/`minimize`/`toggleMaximize`/`close`/
  `onMaximizedChange`/`rememberBroker`/`forgetBroker`) `WebTrader.tsx`/
  `DesktopTitleBar.tsx` already consume from the Electron app — **zero
  web-app changes needed**, it doesn't know which shell it's in. Live-
  verified: launches as a real window, resolves a real broker subdomain,
  loads WebTrader's login page exactly as a browser would. Still not at
  Electron parity. Per-broker rebrand tooling (`desktop-tauri/rebrand.js`,
  a direct port of `desktop/rebrand.js` — `deployment.md` §3's own
  stated precondition before any broker can actually cut over to it) is
  now done too, live-verified. System tray + minimize-to-tray are also
  done: closing the window hides it instead of quitting (live-verified
  by sending the window a real `WM_CLOSE` and confirming the process
  survives), a tray icon/menu (`Show <broker>` / `Launch at startup`
  checkbox via `tauri-plugin-autostart` / `Quit`) matches
  `desktop/main.js`'s exact item order — the `Quit` item's actual click
  path is code-reviewed, not click-tested (no tray-icon-click automation
  available in this sandbox), disclosed as such. Native OS notifications
  are also done: WebTrader's `pushToast` already calls the standard
  `new Notification("VyXTrader", { body })` for important events (margin
  call, price alert, SL/TP hit, pending order trigger), and since
  WebView2 implements that browser API natively, **no polyfill was
  needed at all** — the app just requests permission proactively at
  startup via `tauri-plugin-notification`. (An earlier attempt to wrap
  `window.Notification` in a Tauri-plugin-routed polyfill was caught and
  reverted before shipping — reading the plugin's own shipped JS showed
  its API delegates back to `window.Notification`, so overwriting it
  would have been infinite recursion the moment a toast actually fired;
  see `docs/decisions.md` ADR-001.) Live-verified the app builds against
  the real plugin, launches, and stays alive/responsive after the
  startup permission request runs; an actual end-to-end OS toast was not
  manually triggered (needs a logged-in trading session hitting a real
  alert, no GUI automation in this sandbox), disclosed as such. Still
  explicitly deferred, not silently missing: auto-update,
  `rememberBroker`/`forgetBroker` real persistence + launcher/root-domain
  mode, navigation lockdown, splash/offline screens, window-state
  persistence.
- **Phase 5** (real execution engine / LP FIX feed) — partially started.
  Note: this doc's phase numbering disagrees with `docs/architecture.md`
  §7's own table (which calls Phase 5 "Mobile") — never reconciled,
  flagged rather than silently picked one. The internal Rust execution
  engine (`engine/order-management`, `engine/risk`) now has cancel +
  modify order support (`POST /v1/orders/{id}/cancel`,
  `POST /v1/positions/{id}/modify` on `engine/server`) — the concrete
  gap `docs/testing.md`'s own broker-cutover smoke test required, live-
  verified against the real Postgres. Modify targets an **open
  position's** SL/TP, not a still-pending order, matching what the live
  Next.js path already does — see `docs/trading-engine.md`'s
  implementation-status note. The broker-selection mechanism now also
  exists — `Broker.executionEngine` (`LEGACY`/`RUST`), `SUPER_ADMIN`-only
  via `PATCH /api/admin/brokers/[id]` and a new "Engine" column on
  `app/(super-admin)/brokers` — but it's **deliberately inert**: no
  `app/api/trade/*` route reads it yet, live-verified by placing a real
  order for a `RUST`-flagged broker and confirming it still landed only
  in Prisma's tables. Still not done: the parallel-run cutover test
  infrastructure (`docs/testing.md` §4, needs a staging environment that
  doesn't exist), the test/benchmark gates themselves (`docs/testing.md`
  §2), and the real LP FIX feed — zero design exists for that anywhere,
  and it needs an actual liquidity-provider business relationship the
  user doesn't have yet, not something buildable in this sandbox.

Known simplifications, flagged deliberately rather than hidden: demo/live
account switching requires logging out and back in with the other account
number (one login = one `accountNumber`, no client-side balance-bucket
faking); MARKET orders trust the client-supplied execution price until
Phase 5's real matching engine exists; position `comment` and trailing-stop
distance are client-only state (no schema field yet), lost on refresh.

## Demo credentials (seeded)

- Super Admin: `super@vyxtrader.com` / `ChangeMe123!`
- AcmeFX trader (DEMO): account `50001234` / `Demo1234!`
- Nova Markets trader (DEMO): account `50005678` / `Demo1234!`
