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
//
// Neon compute (coordinator 2026-10-01; the 2026-09-26 quota outage, the 2026-09-27 idle-gate fix): the stream must
// not keep the live database awake, so the rules are never read per tick and never on a short timer.
//   - A broker whose "clientAskServerSideAt" is NULL costs nothing here: its sockets get the raw tick and no rule is
//     ever read for them. The flag itself rides on the enabled-symbol read the stream already does
//     (getBrokerStreamConfig in db.ts: at the broker's first socket, on a ConfigChanged, and every 10 minutes).
//   - A switched-on broker: one read when a trader's socket opens (or one for all its connected traders when the
//     switch is seen turning on), one read for the broker's connected traders on a ConfigChanged, one for an account
//     on its own AccountUpdated, and a 10-minute safety reload. A failed read is retried at most every 30 s.
// Ticks for an account whose rules are not loaded yet are held, never sent raw.

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const D = (v: unknown): Decimal | null => (v == null ? null : new Decimal(String(v)));

/** Every given account's ask rule per enabled symbol, in ONE query. An account with no enabled symbol gets an empty map. */
export async function loadAskRules(query: Query, accountIds: string[], brokerId: string): Promise<Map<string, Map<string, AskRule>>> {
  const out = new Map<string, Map<string, AskRule>>(accountIds.map((id) => [id, new Map<string, AskRule>()]));
  if (accountIds.length === 0) return out;
  const { rows } = await query(
    `SELECT a.id AS account_id, s.name, s.digits,
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
     WHERE a.id = ANY($1::text[]) AND a."brokerId" = $2`,
    [accountIds, brokerId]
  );
  for (const r of rows) {
    out.get(String(r.account_id))?.set(String(r.name), resolveRule({
      engine: r.engine === true,
      coverage: r.coverage === true,
      digits: Number(r.digits),
      broker: D(r.broker_m),
      group: { markup: D(r.g_m), target: D(r.g_t) },
      account: { markup: D(r.a_m), target: D(r.a_t) },
    }));
  }
  return out;
}

export const ASK_SAFETY_RELOAD_MS = 600_000;
export const ASK_RETRY_MS = 30_000;

export class ClientAskRegistry {
  /** Rule reads issued (gateway-stats askRuleQueriesTotal): stays 0 while every broker is switched off. */
  queries = 0;
  private brokerOn = new Map<string, boolean>();
  private accounts = new Map<string, { brokerId: string; sockets: number }>();
  private rules = new Map<string, Map<string, AskRule>>();
  private retryAt = new Map<string, number>();
  private brokerLoadedAt = new Map<string, number>();
  private inFlight = new Set<string>();

  constructor(
    private query: Query,
    private now: () => number = Date.now,
    private onError: (err: unknown) => void = (err) => console.error("price stream: ask rules load failed", err)
  ) {}

  /** The broker's switch, from the stream's enabled-symbol read. Turning on loads every connected trader of that broker
   *  in one read and returns true; turning off drops their rules (no read). */
  setBrokerFlag(brokerId: string, on: boolean): boolean {
    const was = this.brokerOn.get(brokerId);
    this.brokerOn.set(brokerId, on);
    if (!on) {
      for (const [id, a] of this.accounts) if (a.brokerId === brokerId) this.rules.delete(id);
      this.brokerLoadedAt.delete(brokerId);
      return false;
    }
    if (was === true) return false;
    void this.reloadBroker(brokerId);
    return true;
  }

  addSocket(accountId: string, brokerId: string): void {
    const a = this.accounts.get(accountId);
    if (a) a.sockets += 1;
    else this.accounts.set(accountId, { brokerId, sockets: 1 });
    if (this.brokerOn.get(brokerId) === true && !this.rules.has(accountId)) void this.load([accountId], brokerId);
  }

  removeSocket(accountId: string): void {
    const a = this.accounts.get(accountId);
    if (!a) return;
    a.sockets -= 1;
    if (a.sockets <= 0) {
      this.accounts.delete(accountId);
      this.rules.delete(accountId);
      this.retryAt.delete(accountId);
    }
  }

  /** ConfigChanged for the broker (pricing / group / symbol edits publish it): reload its connected traders' rules. */
  onConfigChanged(brokerId: string): void {
    if (this.brokerOn.get(brokerId) === true) void this.reloadBroker(brokerId);
  }

  /** AccountUpdated (group change, account / group pricing): reload that account only. */
  onAccountUpdated(accountId: string): void {
    const a = this.accounts.get(accountId);
    if (a && this.brokerOn.get(a.brokerId) === true) void this.load([accountId], a.brokerId);
  }

  /** Hot path, never awaits: the frame this trader socket gets for this tick, or null = hold it. */
  frameFor(accountId: string, brokerId: string, symbol: string, tick: Record<string, unknown>, rawText: string): string | null {
    const on = this.brokerOn.get(brokerId);
    if (on === undefined) return null;
    if (!on) return rawText;
    const t = this.now();
    if (t - (this.brokerLoadedAt.get(brokerId) ?? t) >= ASK_SAFETY_RELOAD_MS) void this.reloadBroker(brokerId);
    const rules = this.rules.get(accountId);
    if (!rules) {
      if (t >= (this.retryAt.get(accountId) ?? 0)) void this.load([accountId], brokerId);
      return null;
    }
    const rule = rules.get(symbol);
    if (!rule) return null;
    try {
      return rewriteTick(tick, rule);
    } catch {
      return null;
    }
  }

  stats(): { askRuleQueriesTotal: number; askBrokersSwitchedOn: number; askAccountsLoaded: number } {
    return { askRuleQueriesTotal: this.queries, askBrokersSwitchedOn: [...this.brokerOn.values()].filter(Boolean).length, askAccountsLoaded: this.rules.size };
  }

  private reloadBroker(brokerId: string): Promise<void> {
    this.brokerLoadedAt.set(brokerId, this.now());
    const ids = [...this.accounts].filter(([, a]) => a.brokerId === brokerId).map(([id]) => id);
    return this.load(ids, brokerId, true);
  }

  private async load(accountIds: string[], brokerId: string, force = false): Promise<void> {
    const ids = force ? accountIds : accountIds.filter((id) => !this.inFlight.has(id));
    if (ids.length === 0) return;
    for (const id of ids) this.inFlight.add(id);
    this.queries += 1;
    try {
      const loaded = await loadAskRules(this.query, ids, brokerId);
      if (this.brokerOn.get(brokerId) !== true) return; // switched off meanwhile: keep nothing
      for (const [id, r] of loaded) {
        if (!this.accounts.has(id)) continue;
        this.rules.set(id, r);
        this.retryAt.delete(id);
      }
    } catch (err) {
      for (const id of ids) this.retryAt.set(id, this.now() + ASK_RETRY_MS);
      this.onError(err);
    } finally {
      for (const id of ids) this.inFlight.delete(id);
    }
  }
}
