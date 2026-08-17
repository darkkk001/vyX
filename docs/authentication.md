# Authentication

## 1. Today

Two entirely separate JWT session systems, both stateless (no server-side
session store) and both httpOnly-cookie-only — no client-held token ever
exists in JS-reachable storage:

- **Trader sessions** (`lib/account-auth.ts`): `jose`-signed JWT, cookie
  name `vyx_trade_session`, `httpOnly: true`. Payload carries the
  account's broker ID, and every downstream read re-checks the session's
  broker ID against the request's resolved broker (via `middleware.ts`'s
  `x-broker-id` header) so a valid token for Broker A can never be reused
  against Broker B's data even if somehow presented there.
- **Admin sessions** (`lib/auth.ts`): separate JWT, separate cookie,
  separate signing key — deliberately not the same token shape as trader
  sessions so the two can't be confused or cross-used.
- **Password storage**: bcrypt, both for trader accounts and admin users.
- **Login flows**: JSON POST (`trade/login`, `admin/login`) for
  same-origin login; a second form-POST flow (`trade/login-redirect`) for
  the cross-site root-domain launcher (`app/launch`), since a browser
  allows a cross-origin top-level form navigation to carry a
  to-be-set cookie but a `fetch`/XHR call cannot land a cookie scoped to a
  different subdomain the way a real top-level navigation can.

No revocation mechanism exists (a JWT is valid until it expires — there
is no server-side "sign out everywhere" or blocklist), and no rate
limiting on login attempts. Both are real gaps, not stopgaps-by-design.

## 2. Redis-backed sessions — implemented

Trader sessions (`lib/account-auth.ts`) are now Redis-backed opaque
tokens, not self-contained JWTs:

- `createAccountSession` generates a random 32-byte token
  (`crypto.randomBytes(32).toString("hex")`), stores
  `trader_session:{token} -> JSON.stringify({accountId, brokerId})` in
  Redis with a 7-day TTL, and that token is what goes in the
  `vyx_trade_session` cookie — the cookie itself is meaningless without
  the matching Redis record.
- `verifyAccountSessionToken` looks up that Redis key instead of checking
  a JWT signature. `revokeAccountSession` (called from
  `app/api/trade/logout`) deletes it — this is what makes logout **real**
  now: before this change, logout only cleared the cookie client-side,
  and a captured JWT stayed valid until its own 7-day expiry regardless.
- Cookie model is otherwise identical (httpOnly, same-scoping-per-broker
  discipline via the `x-broker-id` cross-check in `getAccountSession`) —
  this was a backing-store change, not a client-visible behavior change.
- Login-attempt rate limiting (`lib/rate-limit.ts`, fixed-window counter):
  5 attempts per minute per `(broker, accountNumber)`, checked in both
  `trade/login` and `trade/login-redirect` before the bcrypt compare, so
  a locked-out account doesn't even cost that. Scoped to account number,
  not IP — an IP-based layer is a possible future addition, not built.
- `services/api-gateway`'s own session check (`src/auth.ts`) reads the
  same Redis key directly — no shared code between the two (separate npm
  packages, same constraint noted in `api.md`/`database.md` for Prisma),
  but same convention, so a session revoked anywhere is invalid
  everywhere immediately.
- Admin sessions (`lib/auth.ts`) are **unchanged** — still JWT-based. Only
  trader sessions were in scope for this; admin-session hardening would
  be separate work, not silently bundled in here.
- **Redis is never authoritative** — a Redis outage means sessions can't
  be validated (users get logged out / can't log in), not that trading
  data becomes wrong or unavailable. Matches spec §16 and the ADRs'
  framing of Postgres as sole source of truth for anything financial.
- Local dev/test Redis: Memurai (Windows-native, Redis-protocol-compatible,
  installed via `winget install Memurai.MemuraiDeveloper`) running as a
  Windows service on the default port. Production should use a managed
  Redis (Upstash was the original recommendation in `deployment.md` §2) —
  Memurai is a local-only substitute, not what should be pointed at from
  a deployed environment.

Verified locally against Memurai: session create/verify/revoke round-trip,
TTL correctness, unknown-token rejection, and the rate limiter's
5-allowed/6th-blocked boundary all pass. The full Gateway auth path was
also exercised end to end: no cookie → 401, valid session with a
mismatched `x-broker-id` → 403, valid session with the correct broker →
auth passes through (failed downstream only because the test used a
placeholder `DATABASE_URL`, not because of anything auth-related). The
root Next.js app type-checks clean after these changes (`npx tsc
--noEmit`, 0 errors).

The two-session-system split (trader vs. admin) carries forward
unchanged — Manager and Back Office (new, per `architecture.md` §3) get
their own RBAC roles under the admin-session system rather than a third
parallel system, since they're closer in shape to "admin" than to
"trader."

## 3. RBAC for new surfaces

Today's admin system has no roles beyond "is an admin for this broker" —
binary. Manager (dealing desk, risk, ops) and Back Office (CRM/KYC/
finance) need actual role granularity (e.g. a dealing-desk user shouldn't
be able to approve KYC). New `AdminUser.role` enum (or a join table if a
user needs more than one role) — not designed further here since it's an
implementation detail of `authentication.md`'s scope, not an
architectural one; flagged as Phase 1 work.

**First slice implemented.** `MANAGER` added to `AdminRole` (`BROKER_ADMIN`
can use the same screens — it's a strict superset). Manager lives on the
**broker's own subdomain** at `/manage/*` (`app/manage/`), not a new
`manager.<ROOT_DOMAIN>` subdomain as `architecture.md`/`deployment.md`'s
target framing implied — confirmed with the user: no monorepo
restructuring exists yet to justify a separate app/deployment for one
screen, and the broker-subdomain approach is actually simpler since
`middleware.ts` already resolves `x-broker-id` there for free (a
`manager.<ROOT_DOMAIN>` approach would have needed a new middleware
branch, mirroring `SUPER_ADMIN_SUBDOMAIN`, and Manager would've had no
`x-broker-id` header to cross-check against at all).

`getAdminSession()` (`lib/auth.ts`) now cross-checks a broker-scoped
session's `brokerId` against the request's resolved `x-broker-id`,
exactly the rule `lib/account-auth.ts`'s `getAccountSession()` already
applies to trader sessions (§2 above) — closes the same class of gap for
every broker-scoped admin role, not just `MANAGER` (`BROKER_ADMIN`/
`SUPPORT` had no UI to exploit this before, so no behavior change for
them today). Super Admin (`brokerId: null`) is unaffected. New
`app/api/manage/login/route.ts` (not the existing `/api/admin/login`)
additionally requires the login's resolved `x-broker-id` match the
account's `brokerId` — otherwise an admin from Broker A's team could log
in on Broker B's subdomain with correct credentials, since Super Admin's
shared login route never needed that check (it never runs where
`x-broker-id` is set).

Verified live end to end (dev server, curl with a spoofed `Host` header
resolving to a real seeded broker subdomain): manager login succeeds and
sets the session cookie; the same cookie against a *different* broker's
subdomain gets rejected (307 redirect on the page, 403 on the API); no
session at all gets the same rejection; Super Admin credentials are
correctly refused on `/manage/login`; an admin's own correct credentials
against the *wrong* broker's subdomain are correctly refused too.

## 4. Open questions for Phase 1

- Exact Redis session record shape (TTL, sliding-expiry vs fixed) — not
  architecturally significant, left to implementation.
- Whether the API Gateway validates sessions itself against Redis, or
  Next.js keeps doing so and forwards a signed short-lived internal token
  to the Gateway — depends on how much of `trade/login`/`trade/me` moves
  per `api.md` §4; the two docs should resolve together in Phase 1, not
  independently guessed at now.
