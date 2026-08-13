# api-gateway

TypeScript API Gateway — see `../../docs/api.md`. Standalone service, own
`package.json`; does not touch the root Next.js app.

## Status

Skeleton: session auth (reuses the existing trader JWT — same secret,
same cookie, see `src/auth.ts`) and one route, `POST /v1/orders/market`,
which forwards to the Rust Trading Core server (`../../engine/server`).

**Known gap:** the Gateway does not yet look up the caller's account/
symbol/price data in Postgres — those fields are trusted from the request
body as-is. Wiring that (Account.leverage/balance/credit, Symbol
.contractSize, LivePrice, all Prisma-owned per ADR-002) is the next real
piece of work, not done here.

## Running

```
cd services/api-gateway
npm install
cp .env.example .env   # fill in ADMIN_SESSION_SECRET to match the root app
npm run dev
```

Requires `engine/server`'s `trading-core-server` binary running (or
`TRADING_CORE_URL` pointed at wherever it's running) for the orders route
to do anything beyond auth.
