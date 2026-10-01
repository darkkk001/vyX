// markup-leak fix (owner 2026-10-01: "traders must never see the broker's markup, only Spread / Client spread").
//
// Before: every trader socket got the RAW tick (source bid / ask) and the client added the account's markup itself,
// read from /api/trade/prices (askMarkup / targetSpread) -- so any trader could read the markup off the wire.
// Now, for a broker whose Broker."clientAskServerSideAt" is set, each trader socket gets its OWN account's ask (the
// price a BUY opens at / a SELL closes at) and never the raw ask; /api/trade/prices then reports askMarkup "0", so an
// installed terminal / WebTrader that still adds the markup adds nothing. The bid is never marked up, so it is sent
// as is. Staff (backoffice) sockets keep the raw tick.
//
// The rule is lib/ask-markup.ts's (web) and engine/market-data ask_markup.rs's, D4 order: coverage account raw;
// pricing engine on: AccountSymbolConfig > GroupSymbolConfig > BrokerSymbol, a level with a target spread wins as a
// target; engine off: GroupSymbolConfig.spreadMarkup else BrokerSymbol.spreadMarkup. Kept here as plain SQL + decimal
// math (this service cannot import the web's Prisma code), pinned by client-ask.test.ts against the shared vectors.
import { Decimal } from "decimal.js";

export type AskRule = { mode: "markup"; markupPips: Decimal; digits: number } | { mode: "target"; targetPips: Decimal; fallbackPips: Decimal | null; digits: number };

export type Levels = {
  engine: boolean;
  coverage: boolean;
  digits: number;
  broker: Decimal | null;
  group: { markup: Decimal | null; target: Decimal | null };
  account: { markup: Decimal | null; target: Decimal | null };
};

export function pipSize(digits: number): Decimal {
  return new Decimal(1).div(new Decimal(10).pow(Math.max(digits - 1, 0)));
}

function levelRule(l: { markup: Decimal | null; target: Decimal | null }, digits: number): AskRule | null {
  if (l.target != null) return { mode: "target", targetPips: l.target, fallbackPips: l.markup, digits };
  if (l.markup != null) return { mode: "markup", markupPips: l.markup, digits };
  return null;
}

export function resolveRule(l: Levels): AskRule {
  const raw: AskRule = { mode: "markup", markupPips: new Decimal(0), digits: l.digits };
  if (l.coverage) return raw;
  if (!l.engine) return { mode: "markup", markupPips: l.group.markup ?? l.broker ?? new Decimal(0), digits: l.digits };
  return levelRule(l.account, l.digits) ?? levelRule(l.group, l.digits) ?? { mode: "markup", markupPips: l.broker ?? new Decimal(0), digits: l.digits };
}

/** The account's ask at this tick: raw ask + markup x pip; target mode lifts the live spread to the target (never below
 *  the raw ask), with the level's fallback markup when the live spread is unknown. */
export function clientAsk(rule: AskRule, bid: Decimal.Value, ask: Decimal.Value): Decimal {
  const a = new Decimal(ask);
  const pip = pipSize(rule.digits);
  if (rule.mode === "markup") return rule.markupPips.isZero() ? a : a.add(rule.markupPips.mul(pip));
  const b = new Decimal(bid);
  if (!a.isFinite() || !b.isFinite()) return rule.fallbackPips ? a.add(rule.fallbackPips.mul(pip)) : a;
  const base = a.sub(b).div(pip);
  const diff = rule.targetPips.sub(base);
  return diff.isNegative() ? a : a.add(diff.mul(pip));
}

/** The tick a trader socket receives: the same JSON with `ask` replaced by the account's ask (same JSON type). */
export function rewriteTick(tick: Record<string, unknown>, rule: AskRule): string {
  const ask = tick.ask as string | number;
  const bid = tick.bid as string | number;
  const v = clientAsk(rule, bid, ask);
  return JSON.stringify({ ...tick, ask: typeof ask === "number" ? v.toNumber() : v.toString() });
}

// ---- per-account rule cache (DB) ----

export type AccountAskState = { serverSide: boolean; rules: Map<string, AskRule> };

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const D = (v: unknown): Decimal | null => (v == null ? null : new Decimal(String(v)));

export async function loadAccountAskState(query: Query, accountId: string, brokerId: string): Promise<AccountAskState | null> {
  const { rows } = await query(
    `SELECT s.name, s.digits,
            (b."clientAskServerSideAt" IS NOT NULL) AS server_side,
            COALESCE(b."pricingEngineEnabled", false) AS engine,
            (COALESCE(g.category::text = 'COVERAGE', false) OR COALESCE(b."coverageAccountId" = a.id, false)) AS coverage,
            bs."spreadMarkup" AS broker_m,
            gsc."spreadMarkup" AS g_m, gsc."targetTotalSpreadPips" AS g_t,
            asc_."spreadMarkup" AS a_m, asc_."targetTotalSpreadPips" AS a_t
     FROM "Account" a
     JOIN "Broker" b ON b.id = a."brokerId"
     JOIN "BrokerSymbol" bs ON bs."brokerId" = a."brokerId" AND bs.enabled = true
     JOIN "Symbol" s ON s.id = bs."symbolId"
     LEFT JOIN "Group" g ON g.id = a."groupId"
     LEFT JOIN "GroupSymbolConfig" gsc ON gsc."groupId" = a."groupId" AND gsc."symbolId" = s.id
     LEFT JOIN "AccountSymbolConfig" asc_ ON asc_."accountId" = a.id AND asc_."symbolId" = s.id
     WHERE a.id = $1 AND a."brokerId" = $2`,
    [accountId, brokerId]
  );
  if (rows.length === 0) {
    // an account with no enabled symbols still needs the broker's flag
    const flag = await query(`SELECT ("clientAskServerSideAt" IS NOT NULL) AS server_side FROM "Broker" WHERE id = $1`, [brokerId]);
    if (flag.rows.length === 0) return null;
    return { serverSide: flag.rows[0].server_side === true, rules: new Map() };
  }
  const rules = new Map<string, AskRule>();
  for (const r of rows) {
    rules.set(String(r.name), resolveRule({
      engine: r.engine === true,
      coverage: r.coverage === true,
      digits: Number(r.digits),
      broker: D(r.broker_m),
      group: { markup: D(r.g_m), target: D(r.g_t) },
      account: { markup: D(r.a_m), target: D(r.a_t) },
    }));
  }
  return { serverSide: rows[0].server_side === true, rules };
}
