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

## 2. Target: Redis-backed sessions

Per `architecture.md` §4, Redis is introduced specifically to close the
two gaps above:

- Session tokens become **opaque references** to a Redis-held session
  record, not self-contained JWTs — this is what makes revocation
  possible (delete the Redis key, the session is dead immediately,
  vs. a JWT that stays valid until its own expiry no matter what the
  server does).
- Cookie model stays identical (httpOnly, same-scoping-per-broker
  discipline) — this is a backing-store change, not a client-visible
  behavior change.
- Redis also backs login-attempt rate limiting (per account, per IP) —
  new, doesn't exist today.
- **Redis is never authoritative** — a Redis outage means sessions can't
  be validated (users get logged out / can't log in), not that trading
  data becomes wrong or unavailable. This matches spec §16 exactly and is
  consistent with ADR's framing of Postgres as sole source of truth for
  anything financial.

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

## 4. Open questions for Phase 1

- Exact Redis session record shape (TTL, sliding-expiry vs fixed) — not
  architecturally significant, left to implementation.
- Whether the API Gateway validates sessions itself against Redis, or
  Next.js keeps doing so and forwards a signed short-lived internal token
  to the Gateway — depends on how much of `trade/login`/`trade/me` moves
  per `api.md` §4; the two docs should resolve together in Phase 1, not
  independently guessed at now.
