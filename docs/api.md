# API

**Implementation status:** `services/api-gateway` exists as a skeleton —
session auth (reusing the existing trader JWT, see `authentication.md`)
and one route, `POST /v1/orders/market`, forwarding to
`engine/server`'s `trading-core-server`. It does not yet read
Account/Symbol/LivePrice from Postgres itself (see §4's resolution below)
— those fields are trusted from the caller for now. Standalone service,
own `package.json`, doesn't touch the root Next.js app or its build.

## 1. Today

Every route lives directly under `app/api/` as a Next.js route handler —
there is no separate Gateway process, the Next.js API route *is* the
Gateway today. Current surface:

- **Public**: `public/brokers` (unauthenticated broker list for the
  root-domain launcher)
- **Trader-session** (`lib/account-auth.ts` JWT cookie): `trade/login`,
  `trade/login-redirect` (form POST, cross-site launcher flow),
  `trade/logout`, `trade/me`, `trade/change-password`, `trade/orders`
  (+`[id]`, `[id]/fill`), `trade/positions` (+`[id]`, `[id]/close`),
  `trade/history`, `trade/prices`, `trade/candles`, `trade/news`
- **Admin-session** (`lib/auth.ts` JWT cookie): `admin/login`,
  `admin/logout`, `admin/brokers`
- **Internal** (shared-secret, not a user session): `internal/price-feed`
  (+ the base64url-path `[payload]` variant the EA actually uses),
  `internal/resolve-broker`

Auth is enforced per-route today (each handler reads and validates its
own cookie) rather than at a single gateway chokepoint. `middleware.ts`
resolves `x-broker-*` headers from the Host header for every request
before it reaches a route handler — this part already behaves like
gateway-level cross-cutting concern, just implemented as Next.js
middleware rather than a standalone service.

## 2. Target: TypeScript API Gateway (extracted service)

Per `architecture.md` §3/§4, the API Gateway becomes its own
`/services/api-gateway` process rather than living inside the Next.js
app. What moves and what doesn't:

| | Stays in Next.js (`apps/web`) | Moves to API Gateway |
|---|---|---|
| Page rendering, static assets | Yes | No |
| `public/brokers`, `admin/*` (broker/admin management — CRM-shaped, not trading) | Yes | No |
| `trade/orders`, `trade/positions`, `trade/history` (trading data) | No | Yes — becomes the REST surface in front of the Rust OMS |
| `trade/prices`, `trade/candles` | No | Yes — becomes REST + the new WebSocket push surface in front of Market Data Core |
| `trade/login`, `trade/login-redirect`, `trade/logout`, `trade/me`, `trade/change-password` | Ambiguous — see §4 | — |
| `internal/price-feed` | No | Yes — Market Data Core's real ingest endpoint (see `market-data.md`); Next.js keeps a thin route only if the EA's base64-path workaround needs to stay pointed at the existing domain |

Broker/account/KYC management (today's `admin/*` and any future
Manager/Back Office surfaces) stays config/CRM-shaped and doesn't need
Rust-core-speed access — it can keep talking to Postgres directly via
Prisma, matching spec §1's "TypeScript for non-latency-critical business
logic."

### 2.1 Protocol

REST for request/response (place order, fetch history, login) — same
shape as today's routes, just re-hosted. WebSocket for anything
server-push (live price ticks, order fill notifications, margin-call
warnings) — new; today's client polls `trade/prices` and `trade/candles`
on an interval instead.

### 2.2 RBAC enforcement point

Becomes the Gateway's job once extracted, replacing today's
per-route cookie check. See `authentication.md` for the session model
this depends on.

## 3. Versioning

No versioning exists today (routes are unversioned `app/api/trade/*`).
Target: Gateway REST routes prefixed `/v1/...` from day one of the
extraction, so a future breaking change (Manager/Back Office consuming
the same Gateway) doesn't force a lockstep client/server deploy the way
today's unversioned routes would.

## 4. Auth resolution (was: open question for Phase 1)

**Resolved for now:** trader auth issuance (`trade/login`,
`trade/login-redirect`) stays in Next.js unchanged; the Gateway
independently verifies the same JWT (same secret, same cookie name) on
each request rather than trusting a forwarded header. This is what's
actually implemented in `services/api-gateway/src/auth.ts` today. It's an
interim answer, not the final one — once `authentication.md` §2's
Redis-backed opaque session lands, the Gateway's verification swaps from
"check the JWT signature" to "look up the session in Redis," and Next.js
stops minting self-contained JWTs. Both docs should update together when
that happens, not independently.
