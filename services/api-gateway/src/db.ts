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

// Sum of required margin across the account's open Rust-owned positions
// (engine/migrations' `positions` table, lowercase/snake_case — a
// separate table family from Prisma's PascalCase `Position`, per
// docs/database.md §3). Joins to "Symbol" for each position's contract
// size since positions can span multiple symbols; leverage is
// account-level so it's applied once, outside the SQL sum.
export async function getUsedMargin(accountId: string, leverage: number): Promise<Decimal> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(p.volume * s."contractSize" * p.open_price), 0) AS notional
     FROM positions p
     JOIN "Symbol" s ON s.name = p.symbol
     WHERE p.account_id = $1 AND p.status = 'OPEN'`,
    [accountId]
  );
  const notional = new Decimal(rows[0].notional ?? 0);
  return notional.div(leverage);
}
