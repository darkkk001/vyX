// TRADE DRIVER: signs into the zzshadowbot trader accounts through the web trade API (the same routes the terminal
// uses) and places / closes positions on synthetic symbols. One login per account per run (the login route allows
// 5 per minute per account), the session cookie is reused; every request is checked against the guards.
import { randomUUID } from "node:crypto";
import { assertAccount, assertSymbol, assertTradeUrl, GuardRefused, TENANT, TRADE_HOST } from "./guards";

export type Side = "BUY" | "SELL";
export type Me = { accountNumber: string; currency: string; leverage: number; balance: number; credit: number; marginCallLevel: number; stopOutLevel: number; groupName: string | null };
export type Pos = { id: string; ticket: number | null; symbol: string; side: Side; volume: number; openPrice: number; contractSize: number };
export type Closed = { id: string; symbol: string; side: Side; volume: number; closePrice: number | null; realizedPnl: number | null; closedAt: string };
export type Txn = { id: string; type: string; amount: number; note: string | null; createdAt: string };
export type Quote = { bid: number; ask: number; tickAt: string };
export type OrderResult = { status: number; orderId: string | null; orderStatus: string | null; positionId: string | null; fillPrice: number | null; error: string | null; idempotencyKey: string };

/** What the runner needs from the trade side (the live HTTP client, or the dry-run simulator). */
export interface TradeBackend {
  me(acct: string): Promise<Me>;
  positions(acct: string): Promise<Pos[]>;
  quote(acct: string, symbol: string): Promise<Quote>;
  market(acct: string, symbol: string, side: Side, volume: number, price: number, maxSlippagePips: number | "unlimited"): Promise<OrderResult>;
  close(acct: string, positionId: string, closePrice: number): Promise<{ status: number; error: string | null }>;
  /** MT5 close-by: a hedged pair closed against each other in ONE request (both legs or neither). */
  closeBy(acct: string, positionId: string, againstPositionId: string): Promise<{ status: number; error: string | null }>;
  history(acct: string, sinceIso: string): Promise<Closed[]>;
  transactions(acct: string): Promise<Txn[]>;
}

const num = (v: unknown) => (v == null || v === "" ? NaN : Number(v));

export class HttpTradeClient implements TradeBackend {
  private readonly cookies = new Map<string, string>();
  private readonly lastLogin = new Map<string, number>();
  constructor(private readonly password: string) {}

  private async login(acct: string): Promise<void> {
    assertAccount(acct);
    const since = Date.now() - (this.lastLogin.get(acct) ?? 0);
    if (since < 15_000) throw new Error(`login for ${acct} refused by the bot: last one ${Math.round(since / 1000)} s ago (server allows 5/min)`);
    this.lastLogin.set(acct, Date.now());
    const url = `${TRADE_HOST}/api/trade/login`;
    assertTradeUrl(url);
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountNumber: acct, password: this.password }), redirect: "manual" });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200) throw new Error(`login ${acct} answered ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    if (body?.requiresTwoFactor || body?.pendingToken) throw new GuardRefused(`account ${acct} asks for two-step sign-in; the bot does not handle it`);
    const jar = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    if (!jar) throw new Error(`login ${acct}: no session cookie returned`);
    this.cookies.set(acct, jar);
    // the session must be THIS account on THIS tenant
    const me = await this.getJson(acct, "/api/trade/me");
    if (String(me.accountNumber) !== acct) throw new GuardRefused(`login ${acct} landed on account ${me.accountNumber}`);
  }

  private async req(acct: string, method: string, pathQ: string, body?: unknown, retry = true): Promise<{ status: number; json: any }> {
    assertAccount(acct);
    const url = `${TRADE_HOST}${pathQ}`;
    assertTradeUrl(url);
    if (!this.cookies.has(acct)) await this.login(acct);
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", cookie: this.cookies.get(acct)!, "x-client-platform": "API" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
    });
    if (res.status === 401 && retry) { this.cookies.delete(acct); await this.login(acct); return this.req(acct, method, pathQ, body, false); }
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }
  private async getJson(acct: string, pathQ: string): Promise<any> {
    const r = await this.req(acct, "GET", pathQ);
    if (r.status !== 200) throw new Error(`GET ${pathQ} (${acct}) answered ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    return r.json;
  }

  async me(acct: string): Promise<Me> {
    const j = await this.getJson(acct, "/api/trade/me");
    return { accountNumber: String(j.accountNumber), currency: j.currency, leverage: Number(j.leverage), balance: num(j.balance), credit: num(j.credit), marginCallLevel: num(j.marginCallLevel), stopOutLevel: num(j.stopOutLevel), groupName: j.groupName ?? null };
  }
  async positions(acct: string): Promise<Pos[]> {
    const j = (await this.getJson(acct, "/api/trade/positions")) as any[];
    return j.map((p) => ({ id: p.id, ticket: p.ticket ?? null, symbol: p.symbol?.name, side: p.side, volume: num(p.volume), openPrice: num(p.openPrice), contractSize: num(p.symbol?.contractSize) }));
  }
  async quote(acct: string, symbol: string): Promise<Quote> {
    assertSymbol(symbol);
    const j = await this.getJson(acct, "/api/trade/prices");
    const rows: any[] = Array.isArray(j) ? j : j.prices ?? [];
    const r = rows.find((x) => x.symbol === symbol);
    if (!r) throw new Error(`no server quote for ${symbol} on ${acct} (is the price driver ticking it?)`);
    return { bid: num(r.bid), ask: num(r.ask), tickAt: r.tickAt };
  }
  async market(acct: string, symbol: string, side: Side, volume: number, price: number, maxSlippagePips: number | "unlimited"): Promise<OrderResult> {
    assertSymbol(symbol);
    const idempotencyKey = `shadowbot:${randomUUID()}`;
    const r = await this.req(acct, "POST", "/api/trade/orders", { symbol, side, type: "MARKET", volume: volume.toFixed(2), price: String(price), maxSlippagePips: String(maxSlippagePips), idempotencyKey });
    const o = r.json?.order ?? r.json;
    return { status: r.status, orderId: o?.id ?? null, orderStatus: o?.status ?? null, positionId: r.json?.position?.id ?? r.json?.position_id ?? null, fillPrice: o?.filledPrice != null ? num(o.filledPrice) : null, error: r.status >= 300 ? String(r.json?.error ?? r.status) : null, idempotencyKey };
  }
  async close(acct: string, positionId: string, closePrice: number): Promise<{ status: number; error: string | null }> {
    const r = await this.req(acct, "POST", `/api/trade/positions/${encodeURIComponent(positionId)}/close`, { closePrice: String(closePrice), maxSlippagePips: "unlimited" });
    return { status: r.status, error: r.status >= 300 ? String(r.json?.error ?? r.status) : null };
  }
  async closeBy(acct: string, positionId: string, againstPositionId: string): Promise<{ status: number; error: string | null }> {
    const r = await this.req(acct, "POST", "/api/trade/positions/close-by", { positionId, againstPositionId });
    return { status: r.status, error: r.status >= 300 ? String(r.json?.error ?? r.status) : null };
  }
  async history(acct: string, sinceIso: string): Promise<Closed[]> {
    const j = (await this.getJson(acct, `/api/trade/history?from=${encodeURIComponent(sinceIso)}&limit=200`)) as any[];
    return j.map((p) => ({ id: p.id, symbol: p.symbol?.name, side: p.side, volume: num(p.volume), closePrice: p.closePrice != null ? num(p.closePrice) : null, realizedPnl: p.realizedPnl != null ? num(p.realizedPnl) : null, closedAt: p.closedAt }));
  }
  async transactions(acct: string): Promise<Txn[]> {
    const j = (await this.getJson(acct, "/api/trade/transactions")) as any[];
    return j.map((t) => ({ id: t.id, type: t.type, amount: num(t.amount), note: t.note ?? null, createdAt: t.createdAt }));
  }
}

export { TENANT };
