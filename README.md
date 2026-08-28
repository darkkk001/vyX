# VyXTrader

B2B white-label broker trading platform (VyXTechnologies LLC). Brokers license this platform, white-label it, and offer it to their retail traders.

## Status: Phase 1 (Foundation)

- `prisma/schema.prisma` — data model (Broker, Account, KycRecord, Transaction, Symbol, BrokerSymbol, AdminUser, IbRelationship, Order, Position, AuditLog). Money fields use `Decimal`, never `Float`.
- `middleware.ts` — resolves the requesting Broker from subdomain (`brokername.<ROOT_DOMAIN>`) or custom domain, attaches `x-broker-*` request headers.
- `vyx-webtrader.html` — static HTML/CSS/JS prototype of the full WebTrader UI (source of truth for the React port in Phase 2). Runs entirely client-side on simulated prices, no backend required — just open it in a browser.
- Minimal Super Admin: login (`/login`) + create-broker form (`/brokers`), cookie-based session (httpOnly JWT via `jose`).

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, ADMIN_SESSION_SECRET, ROOT_DOMAIN
npx prisma migrate dev --name init
npx prisma db seed      # creates 2 demo brokers + a super admin (super@vyxtrader.com / ChangeMe123!)
npm run dev
```

Broker tenant resolution is host-based, so in local dev you need to hit the app with a `Host` header (or `/etc/hosts` entries) matching a seeded broker's subdomain, e.g. `acmefx.localhost:3000`, rather than plain `localhost:3000` (which is treated as the Super Admin root domain).

## Stack

Next.js 15 + TypeScript (backoffice/CRM/WebTrader) · PostgreSQL via Prisma (pinned to v6 — v7 requires driver-adapter config not yet worth the complexity at this stage) · Node.js + Redis execution engine (later phase, dedicated VPS) · TimescaleDB for tick history (later phase) · Tauri (Rust + React/TypeScript) app for desktop.

See the project's build-order documentation for the full phased plan.
