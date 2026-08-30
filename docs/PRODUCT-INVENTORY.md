# VyXTrader — Product Inventory

Generated from the code as of 2026-08-30 (branch `fix/realtime-sync`, commit `293c62d`).
Every claim below cites a file path. Where something could not be confirmed from code,
it is marked **UNVERIFIED** rather than assumed. This document describes what exists
today, not what is planned — no marketing language, nothing "planned" is listed unless
explicitly marked STUB.

Status legend: **DONE** (fully wired, real data, real handlers) · **PARTIAL** (real but
with a named gap) · **STUB** (UI exists, no real handler or a no-op) · **MOCK-DATA**
(hardcoded/fake data standing in for real data).

---

## 1. Surfaces

### 1.1 WebTrader (trader terminal)

Route: `/trade` → `app/(broker)/trade/page.tsx` (Server Component: session-gates via
`getAccountSession()`, redirects to `/trade/login` if none, fetches broker
name/support email, renders `<WebTrader>`). All real logic lives in
`components/webtrader/WebTrader.tsx` — at ~3,600 lines, the single largest component
in the repo.

| Feature | File(s) | Status |
|---|---|---|
| Live price ticks + feed status (connecting/live/stale/no-feed) | `WebTrader.tsx`, `lib/market-simulator.ts` | DONE |
| Order ticket: MARKET/LIMIT/STOP, SL/TP validation, risk-% lot sizing, one-click toggle | `WebTrader.tsx`, `lib/trading.ts`, `app/api/trade/orders/route.ts` | DONE |
| Positions: open list, close (full/partial), bulk close-all/profitable/losing | `WebTrader.tsx`, `app/api/trade/positions/**` | DONE |
| Inline SL/TP edit | `WebTrader.tsx`, `app/api/trade/positions/[id]/route.ts` | DONE |
| Quick order (double-click watchlist / chart right-click) | `WebTrader.tsx` | DONE |
| Price alerts | `WebTrader.tsx` (`Alert` type, `alerts`/`alertHistory` state) | **MOCK-DATA** — client `useState` only, zero calls to `lib/trade-api.ts` for alerts; a full modal + bell badge + "+ New alert" UI exists but nothing persists server-side. Lost on refresh/logout. |
| Watchlist (drag-reorder, context menu, configurable columns) | `WebTrader.tsx` | DONE, persisted to `localStorage` |
| Chart: single view + 2×2 grid, drawing tools, 1 indicator (MA) | `KLineChartPanel.tsx`, `ChartCell.tsx` | DONE, with named gaps below |
| Smart Trade Manager (hotkeys, smart execution, break-even, partial close) | `components/webtrader/SmartTradeManager.tsx` | DONE |
| Account switcher / linked accounts | `WebTrader.tsx` | DONE |
| Funds (deposit/withdrawal requests) | `WebTrader.tsx`, `app/api/trade/funds-requests/route.ts` | DONE as a request/approval workflow — no PSP behind it (§5) |
| KYC ("Verify identity") | `WebTrader.tsx`, `app/api/trade/kyc/route.ts` | DONE as manual-review KYC — no identity-verification provider (§5) |
| Security (2FA setup/disable, session list/revoke) | `WebTrader.tsx`, `lib/totp.ts`, `app/api/trade/two-factor/**`, `app/api/trade/sessions*` | DONE |
| Reports (account statement) | `WebTrader.tsx` | DONE — exact export format not traced, mark **UNVERIFIED** |
| Change password / forgot password | `WebTrader.tsx`, `app/api/trade/change-password`, `app/api/trade/forgot-password` | DONE, but forgot-password only creates an in-app Notification for a Manager to act on — no email/SMS is ever sent (§5) |
| News / economic calendar | `app/api/trade/news/route.ts` | DONE — real Finnhub proxy, degrades to 503 if `FINNHUB_API_KEY` unset. Whether the key is set in production is **UNVERIFIED**. |
| Themes | `WebTrader.tsx` | DONE — 2 themes, `localStorage`-persisted. **No i18n anywhere** (grep for `next-intl`/`react-i18next`/`i18n`: zero matches) — English only. |
| Mobile responsiveness | `WebTrader.tsx` | DONE — dedicated mobile tab layout (chart/trade/positions/watchlist) |
| F5/Ctrl+R intercept | `WebTrader.tsx` (this session) | DONE for the keyboard shortcut; a literal click on the browser's own reload button can't be intercepted by any web page (browser limitation) |
| Panel resize | `WebTrader.tsx`, `app/(broker)/trade/webtrader.css` | DONE — CSS Grid, `ResizeObserver`, `localStorage`-persisted |
| Menu dismiss (outside click/Escape/blur) | `WebTrader.tsx` (this session) | DONE |

**Chart specifics:** library is **klinecharts** (`package.json`: `"klinecharts": "^9.8.10"`),
not lightweight-charts or TradingView's Charting Library. 9 timeframes in single view
(M1/M5/M30/H1/H4/D1/W1/MN1/Y1 — **no M15 exists anywhere in this codebase**, confirmed
again in this fork independently), but only 6 in the multi-chart grid (`ChartCell.tsx`'s
`CELL_TF_LABELS` omits W1/MN1/Y1 — a real, minor inconsistency). Drawing tools: trend
line, horizontal line, Fibonacci retracement, rectangle, text annotation, clear-all.
Indicators: **Moving Average only** — no RSI/MACD/Bollinger/etc.

**Screenshot-worthy components:**

| Component | File | Renders |
|---|---|---|
| WebTrader | `components/webtrader/WebTrader.tsx` | The entire terminal shell |
| KLineChartPanel | `components/webtrader/KLineChartPanel.tsx` | The candlestick chart + overlays + MA |
| ChartCell | `components/webtrader/ChartCell.tsx` | One cell of the 2×2 multi-chart grid |
| SmartTradeManager | `components/webtrader/SmartTradeManager.tsx` | STM hotkey/bulk-action panel |
| DesktopTitleBar | `components/webtrader/DesktopTitleBar.tsx` | Custom frameless-window title bar (desktop only) |
| NewsPanel | `components/webtrader/NewsPanel.tsx` | Economic calendar list |
| SessionClock | `components/webtrader/SessionClock.tsx` | Live wall-clock/session-time display |

### 1.2 Desktop (Tauri)

Three separate Tauri apps, each bundling its own **locally-built** Vite frontend
(`frontendDist: "../dist"` in all three `tauri.conf.json` files) — the UI ships in the
binary; only live data crosses the network.

| App | Native commands | Session persistence | Tray/notifications/window-state | Frameless window | Bundled frontend |
|---|---|---|---|---|---|
| `desktop-tauri` (Trader) | 11: `remember_session`, `forget_session`, `win_minimize/toggle_maximize/close`, `remember_broker`, `forget_broker`, `api_request`, `api_request_multipart`, `start_live_streams`, `stop_live_streams` | Yes — `app_data_dir()/session.json` (plain file, pre-seeds the `reqwest` cookie jar on launch) | Yes, all three (`Cargo.toml`) | Yes (`.decorations(false)`) | `desktop-tauri/webtrader-shell/src/App.tsx` |
| `manager-tauri` | 4: `remember_broker`, `forget_broker`, `api_request`, `api_request_multipart` | **None** | **None** | **No** (default OS chrome) | `manager-tauri/manager-shell/src/App.tsx` |
| `admin-tauri` | 2: `api_request`, `api_request_multipart` | **None** | **None** | **No** | `admin-tauri/admin-shell/src/App.tsx` (independently re-implements its own login+2FA flow rather than reusing the website's page, since that page imports `next/navigation`) |

**Verdict:** Trader Terminal is feature-complete for a desktop app. Manager and Super
Admin desktop apps are **PARTIAL** — every real backoffice screen works, but neither
survives an app restart logged in, has a tray icon, native notifications, or a
frameless window. Already flagged as deferred in those files' own comments; confirmed
still true.

### 1.3 Login / Auth surfaces

| App | Page | File(s) | 2FA |
|---|---|---|---|
| Trader (website) | `/trade/login` | `app/(broker)/trade/login/page.tsx` → `NextTradeLoginForm.tsx` → `TradeLoginForm.tsx` | Yes (TOTP) |
| Trader (desktop) | Bundled | `desktop-tauri/webtrader-shell/src/App.tsx` mounts the same `TradeLoginForm.tsx` | Same |
| Cross-broker launcher | `/launch` | `app/launch/page.tsx` → cross-site form POST → `app/api/trade/login-redirect/route.ts` | **UNVERIFIED** whether this path supports 2FA |
| SSO handoff | — | `app/(broker)/trade/sso/route.ts`, `app/api/trade/sso/token/route.ts` | No — broker's own portal already authenticated the user |
| Manager/Broker-Admin (website) | `/manage/login` | `app/manage/login/page.tsx` → `NextManagerLoginForm.tsx` → `ManagerLoginForm.tsx` | **No 2FA at all** (confirmed: zero `two-factor`/`2fa` matches under `app/api/manage/`) |
| Manager (desktop) | Bundled | `manager-tauri/manager-shell/src/App.tsx` | Same — none |
| Super Admin (website) | `/login` | `app/(super-admin)/login/page.tsx` | Yes (TOTP) |
| Super Admin (desktop) | Bundled | `admin-tauri/admin-shell/src/App.tsx` (own re-implementation) | Same, yes |

**Real, confirmed gap:** `MANAGER`/`BROKER_ADMIN`/`SUPPORT` accounts have **no 2FA
option anywhere**. Only the trader (`Account`) and Super Admin (`AdminUser` with
`brokerId: null`) roles have 2FA. This is asymmetric: `BROKER_ADMIN` — the role with
the broadest financial authority within one tenant — has weaker login security than an
individual trader.

### 1.4 Backoffice (Manager)

All 24 pages live under `app/manage/(shell)/`, self-fetch from `app/api/manage/**`,
and share `app/manage/(shell)/layout.tsx`'s admin-session gate.

| Page | File → API | Feature list | Status |
|---|---|---|---|
| `/manage/dashboard` | `dashboard/DashboardManager.tsx` → `api/manage/dashboard` | 5 KPI cards + activity feed | DONE |
| `/manage/accounts` | `accounts/AccountsManager.tsx` → `api/manage/accounts/**` | Search, create, inline group/status/leverage/max-daily-loss edit, audited balance credit/debit, one-time password reveal | DONE |
| `/manage/accounts/[id]` | `accounts/[id]/ClientActivityView.tsx` → `api/manage/accounts/[id]/activity` | Client activity/position/order drill-in | DONE |
| `/manage/kyc` | `kyc/KycRequestsManager.tsx` → `api/manage/kyc-requests/**` | View docs, approve, reject with reason | DONE — manual review only (§5) |
| `/manage/funds` | `funds/FundsRequestsManager.tsx` → `api/manage/funds-requests/**` | Deposit single-approval; withdrawal real maker-checker | DONE — ledger only, no PSP (§5) |
| `/manage/wallets` | `wallets/WalletsManager.tsx` | Read-only balance/credit list | DONE |
| `/manage/transfers` | `transfers/TransfersManager.tsx` → `api/manage/transfers` | Account-to-account internal transfer + history | DONE — live-tested this session |
| `/manage/groups` | `groups/GroupsManager.tsx` → `api/manage/groups/**` | Full group CRUD, per-group symbol allowlist, per-group-per-symbol spread/commission/swap override | DONE — pricing overrides real, applied at fill time (`lib/group-pricing.ts`) |
| `/manage/symbols` | `symbols/SymbolConfigTable.tsx` → `api/manage/symbols/**` | Spread markup, lot limits, swap, commission, exposure cap, trading mode, sessions | DONE |
| `/manage/ib` | `ib/IbRelationshipsManager.tsx` → `api/manage/ib-relationships/**` | Link client↔IB, commission config, hierarchy view, payout | DONE — pending commission computed on read, never accrued |
| `/manage/leads` | `leads/LeadsManager.tsx` → `api/manage/leads/**` | Lead pipeline, convert to account | DONE — no email/marketing automation |
| `/manage/margin` | `margin/MarginManager.tsx` → `api/manage/margin` | Read-only exposure/floating-P&L/margin-level table | DONE (fetch-once, not push-driven) |
| `/manage/risk` | `risk/RiskSettingsManager.tsx` → `api/manage/risk` | Legacy broker-wide manual-dealing toggle, exposure/position limits, Smart Dealer accept/reject % | DONE — this is the pre-existing broker-wide toggle, **distinct from the per-account `DealingMode`/`AccountDealingOverride` feature blocked as §9** |
| `/manage/emergency` | `emergency/EmergencyControls.tsx` → `api/manage/risk` | Broker-wide trading-halt kill switch | DONE — real, gates order placement |
| `/manage/dealing` | `dealing/DealingQueueManager.tsx` → `api/manage/dealing-queue/**` | Accept/reject/requote queued orders | DONE, event-driven (converted this session) |
| `/manage/positions` | `positions/PositionsManager.tsx` → `api/manage/positions/**` | Filter/sort, modify SL/TP, close/reverse/void, exposure aggregate | DONE, event-driven + a deliberately-kept 5s poll for live floating-P&L |
| `/manage/deals` | `deals/DealsManager.tsx` → `api/manage/deals` | Closed-trade history | DONE |
| `/manage/liquidity` | `liquidity/LiquidityManager.tsx` → `api/manage/liquidity-providers/**` | LP roster, A/B-book volume exposure | PARTIAL — record-keeping only (§5) |
| `/manage/liquidity-routing` | `liquidity-routing/LpRoutingManager.tsx` → `api/manage/lp-routing/**` | Routing rules (LP × symbol × priority) | PARTIAL — config-only, no order ever routes through these rules (§5) |
| `/manage/reports` | `reports/ReportsView.tsx` → `api/manage/reports/**` | 4 KPI cards + 6 real CSV exports | DONE — verified real Prisma-backed CSV generation |
| `/manage/settings` | `settings/SettingsManager.tsx` → `api/manage/settings` | Edit default currency/leverage; read-only broker identity | PARTIAL — branding not editable here (only in Super Admin) |
| `/manage/team` | `team/TeamManager.tsx` → `api/manage/admins/**` | Staff CRUD, role, delegated permissions | DONE |
| `/manage/notifications` | `notifications/NotificationsManager.tsx` → `api/manage/notifications/**` | List, mark read (team-wide shared state) | DONE |
| `/manage/audit` | `audit/AuditLogTable.tsx` → `api/manage/audit` | Audit log, humanized action labels | DONE |
| `/manage/feed-health` | `feed-health/FeedHealthManager.tsx` → `api/manage/feed-health` | Engine latency percentiles + gateway WS stats | **PARTIAL/BROKEN** — see §6, a regression from this session's own §1–4 field renames |

### 1.5 Super Admin

All 8 pages live under `app/(super-admin)/(shell)/`.

| Page | File → API | Feature list | Status |
|---|---|---|---|
| `/admins` | `admins/AdminsManager.tsx` + `CreateAdminForm.tsx` → `api/admin/admins/**` | Cross-tenant admin list, create, reset password | DONE |
| `/audit` | `audit/AuditLogTable.tsx` → `api/admin/audit` | Platform-wide audit log | DONE |
| `/billing` | `billing/BillingManager.tsx` → `api/admin/brokers` | Per-tenant plan label + MRR estimate | STUB — `lib/billing.ts`'s own comment: "Config-only plan pricing — not wired to any real payment processor." No invoices, no charges. |
| `/brokers` | `brokers/BrokersManager.tsx` + `EngineSwitch.tsx` → `api/admin/brokers/**` | Tenant CRUD, branding upload, SSO secret, suspend/disable, Legacy/Rust engine toggle, stat grid | DONE for CRUD. The `executionEngine` toggle is a real DB write but **read by nothing** in the live order path (§6) — 100% decorative today. |
| `/health` | `health/HealthManager.tsx` → `api/admin/health` | 4-row service status table | PARTIAL — only Postgres is a real probe; API Gateway/WS Gateway/Execution Engine rows are hardcoded `"unmonitored"` despite real probes existing elsewhere (Manager's Feed Health page) |
| `/notifications` | `notifications/NotificationsManager.tsx` → `api/admin/notifications/**` | Cross-tenant notifications | DONE |
| `/security` | `security/SecurityManager.tsx` → `api/admin/two-factor/**` | Own-account 2FA setup/disable | DONE |
| `/trials` | `trials/TrialsManager.tsx` → `api/admin/brokers` | List trials, one-click activate | DONE |

### 1.6 Marketing

**There is no marketing/landing site.** `app/page.tsx` does not exist — the bare root
domain serves no public content. What exists instead:
- `app/launch/page.tsx` — a functional broker-picker/login launcher, not marketing.
- `app/manage-launch/page.tsx` — the Manager-app equivalent launcher (**UNVERIFIED** beyond location/line count).
- `app/broker-not-found/page.tsx` — an 8-line error page for an unresolved subdomain.

Consistent with a pure B2B model: brokers are onboarded directly by Super Admin, no
self-serve signup funnel; end-clients only ever land on a broker's own branded
subdomain.

---

## 2. Feature Matrix

### Trader-facing

| Feature | Surface | Status | Backed by | Notes |
|---|---|---|---|---|
| Symbols & watchlist | WebTrader | DONE | `lib/market-simulator.ts`, `WebTrader.tsx` | Drag-reorder, context menu, configurable columns |
| Charting — library | WebTrader | DONE | `klinecharts` v9.8.10 | Not lightweight-charts/TradingView |
| Charting — timeframes | WebTrader | DONE (grid PARTIAL) | `market-simulator.ts` `TIMEFRAMES` | 9 in single view, only 6 in grid cells |
| Charting — indicators | WebTrader | PARTIAL | `KLineChartPanel.tsx` | MA only — no RSI/MACD/Bollinger |
| Charting — drawing tools | WebTrader | DONE | `KLineChartPanel.tsx` | Trend line, horizontal, Fib, rectangle, text |
| Charting — saving layouts | WebTrader | DONE | `localStorage` (`vyx-webtrader-layout`) | Panel sizes, watchlist order/columns |
| Order ticket — types | WebTrader | DONE | `app/api/trade/orders/route.ts` | MARKET/LIMIT/STOP |
| Order ticket — SL/TP | WebTrader | DONE | `lib/trading.ts` | Validated both sides |
| Order ticket — risk % | WebTrader | DONE | `WebTrader.tsx` `updateRiskVolume` | Risk-% → lot-size calculator |
| Order ticket — one-click | WebTrader | DONE | `WebTrader.tsx` | Toggleable |
| Positions/pending/history | WebTrader | DONE | `app/api/trade/positions/**`, `orders/**` | Full/partial close, bulk actions |
| Account summary | WebTrader | DONE | `app/api/trade/me` | Balance, credit, leverage, margin level |
| Alerts | WebTrader | **MOCK-DATA** | none | Client-only state, no persistence |
| Notifications | WebTrader | DONE | in-app only | No push/email delivery (§5) |
| Economic calendar / news | WebTrader | DONE | `app/api/trade/news`, Finnhub | Env-key-contingent |
| Multi-chart | WebTrader | DONE | `ChartCell.tsx`, 2×2 grid | |
| Keyboard shortcuts | WebTrader | DONE | `SmartTradeManager.tsx`, `lib/hotkeys.ts` | Configurable Buy/Sell hotkeys |
| Themes | WebTrader | DONE | 2 themes, `localStorage` | |
| i18n | WebTrader | **ABSENT** | — | No i18n library anywhere; English only |
| Mobile responsiveness | WebTrader | DONE | `WebTrader.tsx` mobile tabs | |

### Backoffice

| Feature | Surface | Status | Backed by | Notes |
|---|---|---|---|---|
| Dashboard KPIs | Manager | DONE | `api/manage/dashboard` | 5 cards + activity feed, no trend charts |
| Clients / CRM / leads | Manager | DONE | `api/manage/leads`, `Lead` model | Pipeline + convert; no email automation |
| Accounts | Manager | DONE | `api/manage/accounts/**` | Full CRUD, finance-role-gated |
| KYC | Manager | DONE (manual) | `api/manage/kyc-requests/**`, `KycRecord` | No 3rd-party KYC API |
| Deposits/withdrawals | Manager | DONE (ledger only) | `api/manage/funds-requests/**` | No PSP |
| Ledger | Manager | DONE | `Transaction` model | Append-only |
| PSPs | Manager | **ABSENT** | — | Zero PSP integration repo-wide |
| Dealing desk — queue/requote | Manager | DONE | `api/manage/dealing-queue/**` | Event-driven (this session) |
| Dealing desk — A/B routing, hedge | Manager | **STUB** | `BookType` field | Classification only, no real hedge execution |
| Exposure/risk | Manager | DONE | `api/manage/risk`, `api/manage/margin` | |
| Groups & symbols & spreads/swaps | Manager | DONE | `api/manage/groups/**`, `symbols/**` | Real, applied at fill time |
| IB/partners | Manager | DONE | `api/manage/ib-relationships/**` | Payout real; commission computed on read |
| Bonuses | Manager | **STUB** | `Account.credit` field | Schema calls it "non-withdrawable bonus" but no UI path ever writes it — field is unreachable |
| Staff & roles | Manager | DONE | `api/manage/admins`, `lib/permissions.ts` | |
| Audit | Manager | DONE | `api/manage/audit` | |
| Settings | Manager | PARTIAL | `api/manage/settings` | Currency/leverage only |
| Branding | Manager (view) / Super Admin (edit) | Split | `Broker.logoUrl/primaryColor` | Broker Admin can't self-serve branding |

### Super Admin

| Feature | Surface | Status | Backed by | Notes |
|---|---|---|---|---|
| Tenant CRUD | Super Admin | DONE | `api/admin/brokers/**` | |
| Plans/billing | Super Admin | **STUB** | `lib/billing.ts` | No payment processor |
| Health | Super Admin | PARTIAL | `api/admin/health` | 1 of 4 rows real |

---

## 3. Data & Flows

### Prisma models (21, `prisma/schema.prisma`)

| Model | Purpose | Owner |
|---|---|---|
| `Broker` | Tenant: branding, execution-engine selection (decorative — see §6), trading-halt/dealing-mode flags, billing fields, SSO secret | web |
| `AdminUser` | Backoffice login (SUPER_ADMIN/BROKER_ADMIN/SUPPORT/MANAGER), 2FA, delegated permissions | web |
| `Account` | Trader login, balance/credit/leverage, KYC/2FA fields | web (reads: engine) |
| `Lead` | Pre-Account CRM prospect | web |
| `Group` | Per-broker account tier: leverage, margin levels, book-routing type, trading restrictions | web |
| `GroupSymbolConfig` | Per-group per-symbol pricing override — actually applied to live fills | web |
| `GroupSymbol` | Per-group symbol allowlist | web |
| `KycRecord` | One per Account: status, doc URLs, reviewer | web |
| `Transaction` | The ledger — every balance-changing event, append-only | web |
| `Symbol` | Tradable instrument master list | web |
| `LivePrice` | Latest bid/ask per symbol, fed by the MT5 EA | engine (writer), web (reader) |
| `Candle` | OHLC history per symbol/timeframe | engine (writer), web (reader) |
| `BrokerSymbol` | Per-broker symbol config | web |
| `TradingSession` | Allowed trading windows per BrokerSymbol | web |
| `Order` | Order state machine | web (legacy path, live); engine (Rust path, not cut over) |
| `Position` | Open/closed/voided positions | web (live), engine (not cut over) |
| `IbRelationship` | IB link + commission rate; payout computed on read, never accrued | web |
| `AuditLog` | Generic actor/action/entity/old-new trail | web |
| `Notification` | In-app-only broker-scoped notifications | web |
| `LiquidityProvider` | LP contact/status record-keeping — **no real FIX/API connection** (own schema comment: "not a credentials vault... no API-key/secret field") | web |
| `LpRoutingRule` | Intended LP routing priority — own comment: **"not live routing — no execution path reads this yet"** | web |

23 enums, notably: `ExecutionEngine{LEGACY,RUST}` — schema comment: setting RUST **"does
NOT currently change any trading behavior — no `app/api/trade/*` route reads this field
yet, deliberately"**; `GroupType{LP,DEALING,DEMO}` actually is read (`lib/dealing.ts`'s
`resolveBookType`); `OrderStatus` includes `REQUOTED`.

### NATS subjects

| Subject | Publisher | Subscriber |
|---|---|---|
| `price.tick.{symbol}` | `engine/market-data/src/ingest.rs` | `services/api-gateway/src/ws.ts` `attachPriceStream` |
| `order.accepted/rejected/filled/cancelled/requoted` | `lib/nats.ts` (legacy path, live) **and** `engine/order-management/src/events.rs` (Rust path, not cut over) | `attachTradingEventStream`, `attachAdminEventStream` |
| `dealing.queued` | `lib/nats.ts` only | `attachAdminEventStream` |
| `position.closed/modified` | both `lib/nats.ts` and `events.rs` | `attachTradingEventStream`, `attachAdminEventStream` |
| `order.partially_filled`, `order.expired`, `margin.call`, `margin.stop_out`, `position.stop_loss_hit/take_profit_hit` | **Rust-only** — no TS-side publisher | `attachTradingEventStream` subscribes `margin.>` but nothing on the live path publishes to it |
| `account.>` | **nobody publishes** | `attachAdminEventStream` subscribes it as forward-compatible plumbing only |

### Gateway endpoints (`services/api-gateway/src`)

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | none | liveness |
| `/internal/gateway-stats` | GET | `x-internal-secret` | ws/tick counters |
| `/v1/orders/market`, `/pending`, `/:id/cancel` | POST | trader session cookie | forwards to Rust engine (not the live path for any broker) |
| `/v1/positions/:id/modify` | POST | trader session cookie | same |
| **no `/v1/positions/:id/close` route** | — | — | gap — the Rust engine has this endpoint internally but the gateway never forwards to it |
| `/v1/prices/stream` | WS | trader session cookie | price-tick fan-out |
| `/v1/trading/stream` | WS | trader session, account-scoped | order/position event fan-out |
| `/v1/events/stream` | WS | admin session JWT, broker-scoped | admin backoffice event stream (this session) |

### Engine crates (`engine/*/src`)

- **protocol** — shared `Tick`/`TradingEvent` wire types.
- **market-data** — `TickCache` (in-memory hot path), Postgres persistence with dirty-tracking + gap-fill, `/internal/price-feed` and `/internal/history` ingest.
- **order-management** — order state machine, pending-order triggers, swap rollover, NATS publishing — Rust path, not live for any broker (ADR-003).
- **position** — types shared with order-management; minimal own logic.
- **risk** — margin/lot-size/exposure/SL-TP validation.
- **margin** — margin-call/stop-out threshold math.
- **execution** — fill-price computation (buy@ask/sell@bid).
- **ledger** — module exists, minimal own coverage.
- **server** — the `trading-core-server` axum binary wiring everything above.
- **loadtest**, **parallel-run** — internal tooling, not part of the product surface.

### Flows

**(a) tick → browser:** MT5 EA (`mt5-ea/VyXTraderPriceFeed.mq5`) → `POST
/internal/price-feed` on `engine/server` → `market_data::ingest::ingest_ticks` writes
`TickCache` + publishes `price.tick.{symbol}` → `services/api-gateway/src/ws.ts`
relays over `/v1/prices/stream` → `WebTrader.tsx`'s WS effect → `acceptCoalescedTick` →
`tickMarket()` (`lib/market-simulator.ts`) → chart/watchlist/ticket re-render.
Fallback: `tradeApi.prices()` 30s poll reading `LivePrice` via Postgres.

**(b) place market order → fill → UI:** `POST /api/trade/orders`
(`app/api/trade/orders/route.ts`) — risk checks (`lib/risk.ts`) →
`openPositionFromOrder` (`lib/dealing.ts`) creates `Position` + `Order(FILLED)` in one
transaction → `publishTradingEvent("OrderFilled", ...)` (`lib/nats.ts`) → gateway's
`/v1/trading/stream` (account-scoped) → `WebTrader.tsx`'s trading-stream effect calls
`refreshOrders/refreshPositions/refreshAccount`.

**(c) deposit request → approval → balance:** `POST /api/trade/funds-requests` creates
a `Transaction(PENDING)` (balance untouched) → Manager sees it via
`/api/manage/funds-requests` → `PATCH /api/manage/funds-requests/[id]`
(`forbidUnlessBrokerAdminOrPermission(FUNDS_APPROVAL)`) — deposit completes on a single
approval; withdrawal is real maker-checker (first APPROVE marks it, a second APPROVE by
a *different* admin completes it and updates `Account.balance`).

**(d) KYC submission → decision:** `POST /api/trade/kyc` uploads to Vercel Blob,
creates/updates `KycRecord(PENDING)`, creates a Notification → Manager's `/manage/kyc`
reviews via `app/api/manage/kyc/[id]/route.ts` → sets APPROVED/REJECTED +
`reviewedByAdminId`. **No third-party KYC/identity-verification API** — manual document
review only.

**(e) login → session:** `POST /api/trade/login` → `authenticateAccount` (bcrypt) → if
2FA, returns `pendingToken` (→ `POST /api/trade/login/verify-2fa`) →
`completeAccountLogin` → `createAccountSession` (`lib/account-auth.ts`) writes an
opaque token to Redis (`trader_session:{token}`, TTL 7d or 30d by "remember") →
`Set-Cookie: vyx_trade_session` (httpOnly). Every request: `getAccountSession()` reads
the cookie, looks up Redis.

---

## 4. Auth & RBAC

| Consumer | Cookie | File | Storage | TTL |
|---|---|---|---|---|
| Trader session (Next.js) | `vyx_trade_session` | `lib/account-auth.ts` | Redis-backed opaque token, revocable | 7d default / 30d "remember" / session-only if not remembered |
| Trader session (Gateway WS) | `vyx_trade_session` | `services/api-gateway/src/auth.ts` | Reads the same Redis key | Same |
| Admin session (Manager+Super Admin) | `vyx_admin_session` | `lib/auth.ts` | Self-contained JWT (`jose`, HS256) — **no server-side revocation store** | 7d default / 30d "remember" |
| Admin session (Gateway WS) | `vyx_admin_session` | `services/api-gateway/src/admin-auth.ts` | Verifies the same JWT (needs `ADMIN_SESSION_SECRET` mirrored to the gateway) | Same JWT |

**Real consequence:** revoking a Manager/Super Admin's access requires disabling their
`AdminUser` row (checked fresh on every permission call) — the JWT itself has no early
invalidation. Trader sessions are immediately revocable (delete the Redis key).

**Roles** (`prisma/schema.prisma`, `enum AdminRole`): `SUPER_ADMIN` (brokerId null),
`BROKER_ADMIN`, `SUPPORT`, `MANAGER`. Separately, `enum AccountType` (`DEMO`/`LIVE`) is
the trader-side classification.

**Real permission-check functions** (`lib/permissions.ts`):
- `hasPermission(session, permission)` — `BROKER_ADMIN` always passes; `MANAGER` passes
  only if `extraPermissions` contains it AND `status === "ACTIVE"` (fresh DB read every call).
- `forbidUnlessBrokerAdminOrPermission(session, permission)` — the actual route-level gate.
- `getPermissionContext(session)` — batches checks into one DB read per request.
- 7 named permissions (`lib/permission-labels.ts`): `KYC_REVIEW`, `RISK_SETTINGS`,
  `EMERGENCY_CONTROLS`, `INTERNAL_TRANSFERS`, `FUNDS_APPROVAL`, `IB_PAYOUTS`, `ACCOUNT_FINANCE`.
- Called from 64 files under `app/api/manage/` and `app/api/admin/` — broadly applied, not vestigial.

---

## 5. Integrations

| Integration | Real or stub | Evidence |
|---|---|---|
| MT5 EA price feed | **Real**, single-broker-terminal source | `mt5-ea/VyXTraderPriceFeed.mq5` (v1.33) — pushes live bid/ask via `WebRequest` to a Next.js proxy or directly to the Rust engine. Own header comment: "Temporary bridge — Phase 5 replaces this with a real LP feed." One broker's own MT5 account, not an aggregated multi-LP feed. |
| PSP / payment processor | **None** | Zero matches for stripe/paypal/braintree/adyen/checkout.com anywhere. Deposits/withdrawals are request-and-manual-approval only. |
| Email / SMS | **None** | Zero real matches for sendgrid/twilio/nodemailer/mailgun. Forgot-password and dealer-review requests create in-app Notifications only — nothing is ever emailed or texted. |
| KYC provider | **None** — manual only | Zero matches for onfido/jumio/sumsub/veriff/persona. Document upload to Vercel Blob, human admin review only. |
| LP / liquidity bridge | **None** — record-keeping only | `LiquidityProvider` has no credentials field by design; `LpRoutingRule`'s own comment confirms no execution path reads it. |
| Economic news/calendar | **Real** | `app/api/trade/news/route.ts` proxies Finnhub server-side. Whether `FINNHUB_API_KEY` is set in production is **UNVERIFIED**. |

---

## 6. Tech Debt & Known Gaps

- **A regression from this session's own §1–4 work:** `app/manage/(shell)/feed-health/FeedHealthManager.tsx`
  and `app/api/manage/feed-health/route.ts` still use the pre-rename `FeedStatsSnapshot`
  field names (`current_ms`, `p50_ms`, `p95_ms`, `ticks_ingested_total`). The live engine
  (`engine/market-data/src/stats.rs`) now returns `ea_to_engine_ms_last/p50/p95` and
  `ticks_in`. Those 4 fields render blank/`—` on the Feed Health page today. `p99_ms`/
  `max_ms` still match and work. **This should be fixed as a fast follow, not left in
  this state.**
- **TODO/FIXME comments: 0** repo-wide (`.ts`/`.tsx`/`.rs`/`.mq5`, excluding
  node_modules/target/.next). Gaps are instead documented as prose comments explaining
  *why* something is deferred, not left as inline TODOs.
- **Zero automated tests on the TypeScript/Next.js side.** No `test` script in either
  `package.json` or `services/api-gateway/package.json`. Correctness is enforced only by
  `tsc --noEmit`, `eslint`, and `next build` — no test suite exercises actual behavior.
  This is a real, stateable gap for a broker demo.
- **Rust engine: 91 tests, all passing** (`cargo test --workspace`): market-data 33,
  order-management 28, risk 21, margin 7, execution 2. **Zero** tests in `position`,
  `ledger`, `server`, `protocol`, `loadtest`, `parallel-run`.
- **`TopbarSearch` is a real, self-acknowledged STUB** (`components/admin/TopbarSearch.tsx`)
  — a `disabled` search input in every Manager/Super-Admin topbar, own comment:
  "Visual-only... Deliberately disabled — there is no real cross-entity search behind
  it yet." Would visibly not work if a demo-giver tried to use it.
- **Gateway has no `/v1/positions/:id/close` route** — the Rust path can't close a
  position end-to-end even if a broker were cut over to it.
- **`Broker.executionEngine` toggle is 100% decorative** — a real DB write from Super
  Admin's Brokers page, read by nothing in the live order path.
- **`Account.credit` ("non-withdrawable bonus") field is unreachable from any UI** — no
  bonus campaign/rule/expiry system exists despite the schema modeling for one.
- **Price alerts are entirely client-side mock state** — see §1.1/§2.
- **No empty/silent catch blocks found** (`catch {}`: 0 hits) — every swallowed error
  sampled carries an explanatory comment (NATS best-effort publishes, notification
  best-effort writes). A genuine strength, stated plainly rather than assumed.
- **Manager/Broker-Admin/Support roles have no 2FA option** — see §1.3.
- **Manager and Super Admin desktop apps lack session persistence, tray, notifications,
  and a native window** — see §1.2.

---

## 7. Numbers

| Surface | LOC |
|---|---|
| `app/(broker)` (WebTrader routes) | 1,791 |
| `components/webtrader` | 4,854 |
| `app/manage` (Backoffice) | 6,727 |
| `app/(super-admin)` | 1,948 |
| `components/admin` | 435 |
| `engine/` (Rust, all crates) | 6,478 |
| `mt5-ea/VyXTraderPriceFeed.mq5` | 654 |
| `services/api-gateway` (.ts) | 1,169 |

- `.tsx` components under `app/` + `components/`: **115**
- `route.ts` API endpoints under `app/api`: **105**
- Prisma models: **21** (23 enums)
- Tests: **91** Rust (`cargo test --workspace`, all passing); **0** TypeScript/JS

---

*Compiled by reading routes, components, API handlers, engine modules, and
`prisma/schema.prisma` directly — not from prior documentation or memory. Findings
that contradict earlier docs (e.g. `docs/decisions.md`'s ADR-003 framing) were
verified against current code before being stated here.*
