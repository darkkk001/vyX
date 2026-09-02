// Read-only Postgres access for data the Gateway itself doesn't own —
// Account/Symbol/LivePrice are Prisma-owned (ADR-002), positions are
// Rust-owned (engine/migrations). Plain `pg`, not Prisma Client: sharing
// a generated Prisma client across two independently-installed npm
// packages needs real monorepo/workspace tooling this project doesn't
// have yet, and setting that up would mean touching the root
// package.json — out of scope for closing this specific gap. Raw
// parameterized SQL against the same DATABASE_URL is the simpler,
// equally-safe alternative for a read-only consumer.
//
// This is what closes the gap noted in docs/api.md/architecture.md:
// the Gateway no longer trusts a client-supplied equity/margin/
// contract_size/price — it fetches all of them itself.

import { Pool } from "pg";
import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface AccountRow {
  balance: Decimal;
  credit: Decimal;
  leverage: number;
  status: string;
}

// Prisma's default (no @@map in schema.prisma) table/column names are
// exact-case model/field names — "Account", "brokerId", etc. — hence the
// double-quoting throughout this file.
export async function getAccount(accountId: string, brokerId: string): Promise<AccountRow | null> {
  const { rows } = await pool.query(
    `SELECT balance, credit, leverage, status FROM "Account" WHERE id = $1 AND "brokerId" = $2`,
    [accountId, brokerId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    balance: new Decimal(row.balance),
    credit: new Decimal(row.credit),
    leverage: row.leverage,
    status: row.status,
  };
}

export async function getSymbolContractSize(symbol: string): Promise<Decimal | null> {
  const { rows } = await pool.query(`SELECT "contractSize" FROM "Symbol" WHERE name = $1`, [symbol]);
  if (rows.length === 0) return null;
  return new Decimal(rows[0].contractSize);
}

export interface OpenPositionsSummary {
  usedMargin: Decimal;
  floatingPnl: Decimal;
}

// Used margin AND floating P&L across the account's open Rust-owned
// positions (engine/migrations' `positions` table, lowercase/snake_case
// — a separate table family from Prisma's PascalCase `Position`, per
// docs/database.md §3), in one query since both need the same
// per-position join to "Symbol" (contract size) and "LivePrice" (current
// bid/ask). LEFT JOIN on LivePrice rather than INNER: a position whose
// symbol currently has no live tick (shouldn't normally happen, per
// docs/market-data.md, but isn't impossible) still counts toward used
// margin at its own open price — silently dropping it would understate
// risk, which is the wrong direction to be wrong in — but contributes 0
// floating P&L rather than a guess.
//
// Floating P&L formula matches lib/trading.ts's computeRealizedPnl
// exactly (BUY: (closePrice - openPrice), SELL: (openPrice - closePrice),
// times contractSize times volume) — "close" here is bid for an open BUY
// (what closing it now would fill at) and ask for an open SELL, mirroring
// engine/execution's fill-side convention.
//
// The join also requires the tick be fresh (updated in the last 15s,
// same threshold as market_data::db::get_live_price and WebTrader.tsx's
// chart) -- without this, a dead price feed (MT5 EA today, any future
// paid/FIX feed later -- this check is source-agnostic since it's keyed
// off LivePrice.tickAt, not who wrote it) leaves bid/ask frozen at
// their last real value forever, and equity computed from a frozen price
// would keep permitting trades that a real price would have blocked.
// Treating a stale tick as "no tick" (bid/ask: null) reuses the same
// skip-this-one-for-P&L handling already below, no new case to add.
//
// Filters on "tickAt", not "updatedAt" -- "updatedAt" bumps on every row
// write regardless of whether the underlying price changed (the MT5 EA's
// heartbeat resends an unchanged price every 5s), which left this blind
// to a genuinely frozen feed as long as it kept heartbeating. "tickAt" is
// the real last-tick time and only advances when the market's own last
// tick actually does -- see that column's own schema comment.
export async function getOpenPositionsSummary(
  accountId: string,
  leverage: number
): Promise<OpenPositionsSummary> {
  const { rows } = await pool.query(
    `SELECT p.side::text AS side, p.volume, p.open_price, s."contractSize" AS contract_size,
            lp.bid, lp.ask
     FROM positions p
     JOIN "Symbol" s ON s.name = p.symbol
     LEFT JOIN "LivePrice" lp ON lp.symbol = p.symbol AND lp."tickAt" > now() - interval '15 seconds'
     WHERE p.account_id = $1 AND p.status = 'OPEN'`,
    [accountId]
  );

  let usedMargin = new Decimal(0);
  let floatingPnl = new Decimal(0);

  for (const row of rows) {
    const volume = new Decimal(row.volume);
    const openPrice = new Decimal(row.open_price);
    const contractSize = new Decimal(row.contract_size);

    usedMargin = usedMargin.plus(volume.times(contractSize).times(openPrice).div(leverage));

    if (row.bid == null || row.ask == null) continue;
    const closePrice = row.side === "BUY" ? new Decimal(row.bid) : new Decimal(row.ask);
    const diff = row.side === "BUY" ? closePrice.minus(openPrice) : openPrice.minus(closePrice);
    floatingPnl = floatingPnl.plus(diff.times(contractSize).times(volume));
  }

  return { usedMargin, floatingPnl };
}

// Account.balance is Prisma-owned and this service never writes it. When
// engine/order-management::monitor force-closes a position (stop-out), it
// records the realized P&L as a ledger_entries row instead of writing
// Account.balance directly (a cross-boundary write ADR-002 doesn't allow)
// — see engine/order-management/src/db.rs's get_ledger_sum doc comment.
// So the account's true current balance is Account.balance PLUS every
// ledger entry recorded since — both this Gateway and the Rust monitor
// compute "effective balance" the same way, from the same two sources.
// Writes into the same "AuditLog" table every other mutation in this app
// uses (lib/audit-labels.ts's LABELS map on the Next.js side) -- rather
// than build a second, Rust-side audit path, the Gateway (which already
// holds this Postgres connection) writes the row itself after a
// successful forward to engine/server. `actorAdminId` is always null
// here (these are trader-initiated actions, not admin ones). `id` is a
// random UUID rather than Prisma's own cuid() -- this table's `id`
// column has no format constraint, just uniqueness, and generating a
// real cuid here would mean pulling in a cuid library for one column.
export async function writeAuditLog(entry: {
  brokerId: string;
  action: string;
  entityType: string;
  entityId: string;
  newValue: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO "AuditLog" (id, "brokerId", "actorAdminId", action, "entityType", "entityId", "newValue", "createdAt")
     VALUES ($1, $2, NULL, $3, $4, $5, $6, now())`,
    [randomUUID(), entry.brokerId, entry.action, entry.entityType, entry.entityId, JSON.stringify(entry.newValue)]
  );
}

// Second Contabo-audit follow-up: the price stream used to broadcast
// every tick to every connected client regardless of broker -- the EA
// side no longer enforces a fixed symbol list either (MARKET_WATCH mode
// can push anything selected in a terminal's Market Watch), so nothing
// upstream of the Gateway narrows this anymore. This is what a tenant's
// "enabled symbol list" actually means: BrokerSymbol.enabled, the same
// table/flag every REST route already checks (app/api/trade/orders,
// group pricing, etc.) -- not a new concept, just the first place it's
// read outside the Next.js app. src/ws.ts caches this per broker for 30s
// (see WsSymbolFilterCacheEntry there) rather than querying on every tick.
export async function getEnabledSymbolNames(brokerId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT s.name FROM "BrokerSymbol" bs
     JOIN "Symbol" s ON s.id = bs."symbolId"
     WHERE bs."brokerId" = $1 AND bs.enabled = true`,
    [brokerId]
  );
  return rows.map((r) => r.name as string);
}

export async function getLedgerSum(accountId: string): Promise<Decimal> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries WHERE account_id = $1`,
    [accountId]
  );
  return new Decimal(rows[0].total ?? 0);
}
