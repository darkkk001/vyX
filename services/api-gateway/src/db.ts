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

// L2 Step 5 (latency): every option but the URL used to be a node-postgres default, and two of those
// defaults were costing an order more than everything else this file does.
//
// idleTimeoutMillis defaults to 10_000: a connection unused for ten seconds is closed. Orders are
// sparse, so in production almost every order opened a NEW connection to Neon -- TCP, TLS, startup --
// before it could read anything. That is the same mistake the engine's pool had (min_connections 0),
// and it measured the same way: a p50 that sat far above the work being done.
//
// min keeps a floor open so the handshake is paid once, at boot, instead of per order; keepAlive stops
// an idle-but-wanted connection being dropped by anything in between.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min: 2,
  idleTimeoutMillis: 0, // never reap: these connections are wanted for the life of the process
  keepAlive: true,
});

/** Read-only parameterized query on the main database (client-ask.ts loads ask rules with it). */
export async function query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
  const r = await pool.query(sql, params as unknown[]);
  return { rows: r.rows as Record<string, unknown>[] };
}

// Neon -> VPS market-data migration (docs/market-data.md §8, S4): LivePrice
// lives on the VPS Postgres once MARKET_DATA_DATABASE_URL is set (the same
// value the engine's start-engine.cmd carries -- this service runs on the
// same box). Unset = read LivePrice from DATABASE_URL (Neon) exactly as
// before. Only the price lookup moves; positions / accounts stay on Neon.
const marketDataPool = process.env.MARKET_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.MARKET_DATA_DATABASE_URL })
  : pool;

export interface AccountRow {
  balance: Decimal;
  credit: Decimal;
  leverage: number;
  status: string;
  // L2 Step 3 ingress scoping: the engine order path serves DEMO accounts only for now, and this is
  // the column that decides it -- read here so the check is on the DATABASE's answer, never on a list
  // someone maintains by hand.
  accountMode: string;
}

// Prisma's default (no @@map in schema.prisma) table/column names are
// exact-case model/field names — "Account", "brokerId", etc. — hence the
// double-quoting throughout this file.
export async function getAccount(accountId: string, brokerId: string): Promise<AccountRow | null> {
  const { rows } = await pool.query(
    `SELECT balance, credit, leverage, status, "accountMode" FROM "Account" WHERE id = $1 AND "brokerId" = $2`,
    [accountId, brokerId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    balance: new Decimal(row.balance),
    credit: new Decimal(row.credit),
    leverage: row.leverage,
    status: row.status,
    accountMode: row.accountMode,
  };
}

/**
 * The account AND the traded symbol's contract size, in ONE round trip (L2 optimization pass).
 *
 * These were two sequential awaits -- `getAccount` then `getSymbolContractSize` -- which measured 6 ms
 * + 6 ms to Neon in front of every order. Same two answers, same meaning, one trip: a missing account
 * is still no row (404), and a missing symbol is still a null contract size (400).
 */
export async function getAccountAndContractSize(
  accountId: string,
  brokerId: string,
  symbol: string
): Promise<{ account: AccountRow; contractSize: Decimal | null } | null> {
  const { rows } = await pool.query(
    `SELECT a.balance, a.credit, a.leverage, a.status, a."accountMode",
            (SELECT s."contractSize" FROM "Symbol" s WHERE s.name = $3) AS contract_size
       FROM "Account" a WHERE a.id = $1 AND a."brokerId" = $2`,
    [accountId, brokerId, symbol]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    account: {
      balance: new Decimal(row.balance),
      credit: new Decimal(row.credit),
      leverage: row.leverage,
      status: row.status,
      accountMode: row.accountMode,
    },
    contractSize: row.contract_size == null ? null : new Decimal(row.contract_size),
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
  // Two queries instead of the former LEFT JOIN: positions come from Neon,
  // the fresh prices from marketDataPool (the VPS store after S4) -- the
  // two tables no longer have to share a database.
  const { rows: positions } = await pool.query(
    `SELECT p.side::text AS side, p.volume, p.open_price, s."contractSize" AS contract_size, p.symbol
     FROM positions p
     JOIN "Symbol" s ON s.name = p.symbol
     WHERE p.account_id = $1 AND p.status = 'OPEN'`,
    [accountId]
  );
  const symbols = [...new Set(positions.map((r) => r.symbol as string))];
  const priceBySymbol = new Map<string, { bid: string; ask: string }>();
  if (symbols.length > 0) {
    const { rows: prices } = await marketDataPool.query(
      `SELECT symbol, bid, ask FROM "LivePrice"
       WHERE symbol = ANY($1) AND "tickAt" > now() - interval '15 seconds'`,
      [symbols]
    );
    for (const pr of prices) priceBySymbol.set(pr.symbol, { bid: pr.bid, ask: pr.ask });
  }
  const rows = positions.map((r) => ({ ...r, bid: priceBySymbol.get(r.symbol)?.bid ?? null, ask: priceBySymbol.get(r.symbol)?.ask ?? null }));

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
/** markup-leak fix: the broker's enabled symbols AND its server-side-ask switch in ONE read -- the price stream's
 *  existing per-broker refresh (first socket, ConfigChanged, every 10 min), so the switch costs no extra query. */
export async function getBrokerStreamConfig(brokerId: string): Promise<{ symbols: string[]; clientAskServerSide: boolean }> {
  let rows: Record<string, unknown>[];
  try {
    rows = (
      await pool.query(
        `SELECT (b."clientAskServerSideAt" IS NOT NULL) AS server_side, s.name
         FROM "Broker" b
         LEFT JOIN "BrokerSymbol" bs ON bs."brokerId" = b.id AND bs.enabled = true
         LEFT JOIN "Symbol" s ON s.id = bs."symbolId"
         WHERE b.id = $1`,
        [brokerId]
      )
    ).rows;
  } catch (err) {
    // the switch's column not migrated yet (42703 undefined_column): keep the feed alive with the switch off, exactly
    // the pre-markup-leak behaviour, instead of leaving every socket of the broker without ticks
    if ((err as { code?: string }).code !== "42703") throw err;
    console.error("price stream: Broker.clientAskServerSideAt missing (migration not applied?), server-side asks stay off");
    rows = (await pool.query(
      `SELECT false AS server_side, s.name FROM "BrokerSymbol" bs JOIN "Symbol" s ON s.id = bs."symbolId"
       WHERE bs."brokerId" = $1 AND bs.enabled = true`,
      [brokerId]
    )).rows;
  }
  return {
    symbols: rows.filter((r) => r.name != null).map((r) => r.name as string),
    clientAskServerSide: rows.length > 0 && rows[0].server_side === true,
  };
}

export async function getLedgerSum(accountId: string): Promise<Decimal> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries WHERE account_id = $1`,
    [accountId]
  );
  return new Decimal(rows[0].total ?? 0);
}

// Phase 2 batch 3/4 (mandatory staff 2FA, 2026-09-26): the admin event stream admits a broker staff session only while
// that admin is ACTIVE and has 2FA enrolled -- the same gate the web API's getAdminSession applies (lib/auth.ts). A
// disabled admin, or one still in enrolment-only state, gets no broker-wide event stream.
export async function adminMayStream(adminId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT status::text AS status, "twoFactorEnabled" AS tfa FROM "AdminUser" WHERE id = $1`, [adminId]);
  const row = rows[0] as { status: string; tfa: boolean } | undefined;
  return !!row && row.status === "ACTIVE" && row.tfa === true;
}

// ---- close-position support (gateway close route, 2026-11-04) ----------------------------------------
//
// These read Prisma's "Position" / "Symbol" / "Broker" / "BrokerSymbol", NOT the legacy lowercase
// `positions` that getOpenPositionsSummary above still reads. The close route writes through the
// engine, which is on the Prisma book; reading the legacy table here would answer about a book nothing
// fills any more.

export interface PositionForClose {
  id: string;
  accountId: string;
  brokerId: string;
  side: "BUY" | "SELL";
  volume: Decimal;
  openPrice: Decimal;
  status: string;
  ticket: string | null;
  closePendingOrderId: string | null;
  symbolName: string;
  digits: number;
  symbolCapPoints: Decimal | null;
  brokerCapXauPoints: Decimal | null;
  brokerCapRefPrice: Decimal | null;
  defaultMaxSlippagePoints: Decimal | null;
  defaultMaxSlippagePips: Decimal | null;
}

/** The position, scoped to this session's account AND broker, with everything the slippage cap needs.
 *  Returns null when it does not exist or is not this account's -- the caller answers 404 either way, so
 *  a position id cannot be used to probe another account. Status is returned rather than filtered, so
 *  the caller can tell "already closed" (409) from "not yours" (404). */
export async function getPositionForClose(
  positionId: string,
  accountId: string,
  brokerId: string
): Promise<PositionForClose | null> {
  const { rows } = await pool.query(
    `SELECT p.id, p."accountId", p."brokerId", p.side::text AS side, p.volume, p."openPrice",
            p.status::text AS status, p.ticket, p."closePendingOrderId",
            s.name AS symbol_name, s.digits,
            bs."maxSlippagePoints" AS symbol_cap,
            b."slippageCapXauPoints", b."slippageCapRefPrice",
            b."defaultMaxSlippagePoints", b."defaultMaxSlippagePips"
       FROM "Position" p
       JOIN "Symbol" s ON s.id = p."symbolId"
       JOIN "Broker" b ON b.id = p."brokerId"
       LEFT JOIN "BrokerSymbol" bs ON bs."brokerId" = p."brokerId" AND bs."symbolId" = p."symbolId"
      WHERE p.id = $1 AND p."accountId" = $2 AND p."brokerId" = $3 AND p."deletedAt" IS NULL`,
    [positionId, accountId, brokerId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const dec = (v: unknown): Decimal | null => (v == null ? null : new Decimal(String(v)));
  return {
    id: r.id as string,
    accountId: r.accountId as string,
    brokerId: r.brokerId as string,
    side: r.side as "BUY" | "SELL",
    volume: new Decimal(String(r.volume)),
    openPrice: new Decimal(String(r.openPrice)),
    status: r.status as string,
    ticket: r.ticket == null ? null : String(r.ticket),
    closePendingOrderId: (r.closePendingOrderId as string | null) ?? null,
    symbolName: r.symbol_name as string,
    digits: Number(r.digits),
    symbolCapPoints: dec(r.symbol_cap),
    brokerCapXauPoints: dec(r.slippageCapXauPoints),
    brokerCapRefPrice: dec(r.slippageCapRefPrice),
    defaultMaxSlippagePoints: dec(r.defaultMaxSlippagePoints),
    defaultMaxSlippagePips: dec(r.defaultMaxSlippagePips),
  };
}

/** One symbol's live bid/ask, only if the tick is fresh. Same 15 s window and same `tickAt` (not
 *  `updatedAt`) column as getOpenPositionsSummary -- a frozen feed that keeps heartbeating must read as
 *  NO price, not as a stale one, or a close prices off a dead market. */
export async function getFreshPrice(symbol: string): Promise<{ bid: Decimal; ask: Decimal } | null> {
  const { rows } = await marketDataPool.query(
    `SELECT bid, ask FROM "LivePrice" WHERE symbol = $1 AND "tickAt" > now() - interval '15 seconds'`,
    [symbol]
  );
  if (rows.length === 0) return null;
  return { bid: new Decimal(String(rows[0].bid)), ask: new Decimal(String(rows[0].ask)) };
}

export interface OpenPositionForBulk {
  id: string;
  side: "BUY" | "SELL";
  volume: Decimal;
  openPrice: Decimal;
  closePendingOrderId: string | null;
  symbolName: string;
  digits: number;
  contractSize: Decimal;
  openedAt: Date;
}

/** Every OPEN position on this account, for a bulk close.
 *
 *  Reads Prisma's "Position" -- NOT the legacy lowercase `positions` that getOpenPositionsSummary above
 *  still reads -- for the same reason getPositionForClose does: the engine writes the Prisma book, and a
 *  basket selected off the legacy table would be empty in production.
 *
 *  ORDER IS PART OF THE ANSWER, not an incidental detail. A bulk close settles in the order given: each
 *  close's balanceBefore is the previous one's balanceAfter, and the "is this the last open position"
 *  test that drives negative-balance protection is re-evaluated per position. The web's own bulk path
 *  takes whatever order Prisma's findMany returns, which is unordered; here it is pinned to oldest-first
 *  so the same basket produces the same ledger twice. ("openedAt", id) because openedAt ties on
 *  positions opened in the same millisecond and a tie would put the order back in the planner's hands. */
export async function getOpenPositionsForBulk(
  accountId: string,
  brokerId: string
): Promise<OpenPositionForBulk[]> {
  const { rows } = await pool.query(
    `SELECT p.id, p.side::text AS side, p.volume, p."openPrice", p."closePendingOrderId", p."openedAt",
            s.name AS symbol_name, s.digits, s."contractSize"
       FROM "Position" p
       JOIN "Symbol" s ON s.id = p."symbolId"
      WHERE p."accountId" = $1 AND p."brokerId" = $2 AND p.status = 'OPEN' AND p."deletedAt" IS NULL
      ORDER BY p."openedAt" ASC, p.id ASC`,
    [accountId, brokerId]
  );
  return rows.map((r) => ({
    id: r.id as string,
    side: r.side as "BUY" | "SELL",
    volume: new Decimal(String(r.volume)),
    openPrice: new Decimal(String(r.openPrice)),
    closePendingOrderId: (r.closePendingOrderId as string | null) ?? null,
    symbolName: r.symbol_name as string,
    digits: Number(r.digits),
    contractSize: new Decimal(String(r.contractSize)),
    openedAt: r.openedAt as Date,
  }));
}

/** getFreshPrice for a whole basket: one round trip for every distinct symbol in it, same 15 s window
 *  and same `tickAt` column. A symbol missing from the returned map has NO fresh tick and its positions
 *  must not be closed -- the caller reports them, it does not fall back to a stale row. */
export async function getFreshPrices(symbols: string[]): Promise<Map<string, { bid: Decimal; ask: Decimal }>> {
  const out = new Map<string, { bid: Decimal; ask: Decimal }>();
  if (symbols.length === 0) return out;
  const { rows } = await marketDataPool.query(
    `SELECT symbol, bid, ask FROM "LivePrice"
      WHERE symbol = ANY($1::text[]) AND "tickAt" > now() - interval '15 seconds'`,
    [symbols]
  );
  for (const r of rows) {
    out.set(String(r.symbol), { bid: new Decimal(String(r.bid)), ask: new Decimal(String(r.ask)) });
  }
  return out;
}

/** What the client gets back after a close: the closed Position, its TRADE_PNL ledger row and the new
 *  balance. Field lists are the web's own client allow-lists (lib/client-execution.ts POSITION_FIELDS /
 *  TRANSACTION_FIELDS) so the shape the UI receives is the shape it already handles. The reference keys
 *  are the ones a real close writes: type TRADE_PNL, referenceType 'Position', referenceId = position. */
export async function getCloseResultView(
  positionId: string,
  accountId: string
): Promise<{ position: Record<string, unknown>; transaction: Record<string, unknown> | null; balance: string } | null> {
  const { rows: prows } = await pool.query(
    `SELECT p.id, p.ticket, p."symbolId", p."originOrderId", p.side::text AS side, p.volume, p."openPrice",
            p."slPrice", p."tpPrice", p.status::text AS status, p."closePrice", p."realizedPnl", p.swap,
            p.commission, p."closedVolume", p."closedSwap", p."initialVolume", p."openedAt", p."closedAt",
            p."closePendingOrderId",
            json_build_object('id', s.id, 'name', s.name, 'digits', s.digits, 'contractSize', s."contractSize") AS symbol
       FROM "Position" p JOIN "Symbol" s ON s.id = p."symbolId"
      WHERE p.id = $1`,
    [positionId]
  );
  if (prows.length === 0) return null;
  const { rows: trows } = await pool.query(
    `SELECT id, type::text AS type, status::text AS status, amount, "balanceBefore", "balanceAfter", note,
            "createdAt", "referenceType", "referenceId", "closeVolume", "closePrice", "closeSwap", "closeByPositionId"
       FROM "Transaction"
      WHERE "referenceType" = 'Position' AND "referenceId" = $1 AND type = 'TRADE_PNL'
      ORDER BY "createdAt" DESC LIMIT 1`,
    [positionId]
  );
  const { rows: arows } = await pool.query(`SELECT balance FROM "Account" WHERE id = $1`, [accountId]);
  return {
    position: prows[0],
    transaction: trows[0] ?? null,
    balance: arows.length > 0 ? String(arows[0].balance) : "0",
  };
}

/** Everything the slippage cap needs for an OPEN on one symbol: the symbol's digits and its own cap
 *  override, plus the broker's XAU base, reference price and action. Same columns the web's market route
 *  reads (broker + BrokerSymbol), so the cap is computed off the same configuration, not a copy of it. */
export interface OpenSlippageInputs {
  digits: number;
  symbolCapPoints: Decimal | null;
  brokerCapXauPoints: Decimal | null;
  brokerCapRefPrice: Decimal | null;
  slippageAction: string | null;
}

export async function getOpenSlippageInputs(
  brokerId: string,
  symbol: string
): Promise<OpenSlippageInputs | null> {
  const { rows } = await pool.query(
    `SELECT s.digits,
            bs."maxSlippagePoints" AS symbol_cap,
            b."slippageCapXauPoints", b."slippageCapRefPrice", b."slippageAction"::text AS slippage_action
       FROM "Symbol" s
       JOIN "Broker" b ON b.id = $1
       LEFT JOIN "BrokerSymbol" bs ON bs."brokerId" = $1 AND bs."symbolId" = s.id
      WHERE s.name = $2`,
    [brokerId, symbol]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const dec = (v: unknown): Decimal | null => (v == null ? null : new Decimal(String(v)));
  return {
    digits: Number(r.digits),
    symbolCapPoints: dec(r.symbol_cap),
    brokerCapXauPoints: dec(r.slippageCapXauPoints),
    brokerCapRefPrice: dec(r.slippageCapRefPrice),
    slippageAction: (r.slippage_action as string | null) ?? null,
  };
}
