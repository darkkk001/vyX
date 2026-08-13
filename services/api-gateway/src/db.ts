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

export interface LivePriceRow {
  bid: Decimal;
  ask: Decimal;
}

export async function getLivePrice(symbol: string): Promise<LivePriceRow | null> {
  const { rows } = await pool.query(`SELECT bid, ask FROM "LivePrice" WHERE symbol = $1`, [symbol]);
  if (rows.length === 0) return null;
  return { bid: new Decimal(rows[0].bid), ask: new Decimal(rows[0].ask) };
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
export async function getOpenPositionsSummary(
  accountId: string,
  leverage: number
): Promise<OpenPositionsSummary> {
  const { rows } = await pool.query(
    `SELECT p.side::text AS side, p.volume, p.open_price, s."contractSize" AS contract_size,
            lp.bid, lp.ask
     FROM positions p
     JOIN "Symbol" s ON s.name = p.symbol
     LEFT JOIN "LivePrice" lp ON lp.symbol = p.symbol
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
export async function getLedgerSum(accountId: string): Promise<Decimal> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries WHERE account_id = $1`,
    [accountId]
  );
  return new Decimal(rows[0].total ?? 0);
}
