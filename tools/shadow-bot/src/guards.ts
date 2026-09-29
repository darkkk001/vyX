// Shadow-bot hard guards (owner-approved plan, 2026-09-29). The config can only NARROW these, never widen them: the
// hosts, tenant, account range and symbol prefix below are constants, and every order / tick / login is checked
// against them at the moment it is sent, not only at start-up.
import { SYNTH_PREFIX, isSyntheticSymbol } from "../../../lib/synthetic-symbols";

export const TENANT = "zzshadowbot";
export const TRADE_HOST = "https://zzshadowbot.vyxtrader.com";
export const FEED_URL = "https://feed.vyxtrader.com/internal/synth-feed";
/** The five synthetic symbols seeded on zzshadowbot (scripts/seed-zzshadowbot-synth.ts). */
export const SYMBOLS = ["vGOLD", "vEUR", "vGBP", "vJPY", "vIDX"] as const;
/** The trader accounts the bot may sign into. 49990099 (the broker hedge account) is NOT here: owner decision, the
 *  bot never signs into a system account. */
export const TRADE_ACCOUNTS = Array.from({ length: 13 }, (_, i) => String(49990001 + i));

export class GuardRefused extends Error {}

export function assertSymbol(symbol: string): void {
  if (!isSyntheticSymbol(symbol) || !(SYMBOLS as readonly string[]).includes(symbol)) {
    throw new GuardRefused(`symbol ${JSON.stringify(symbol)} refused: only ${SYMBOLS.join(", ")} (prefix "${SYNTH_PREFIX}")`);
  }
}
export function assertAccount(accountNumber: string): void {
  if (!TRADE_ACCOUNTS.includes(accountNumber)) throw new GuardRefused(`account ${accountNumber} refused: only ${TRADE_ACCOUNTS[0]}..${TRADE_ACCOUNTS.at(-1)}`);
}
export function assertTradeUrl(url: string): void {
  const u = new URL(url);
  if (u.origin !== TRADE_HOST || !u.pathname.startsWith("/api/trade/")) throw new GuardRefused(`trade request to ${u.origin}${u.pathname} refused`);
}
export function assertFeedUrl(url: string): void {
  if (url !== FEED_URL) throw new GuardRefused(`feed request to ${url} refused`);
}
/** The config may list fewer symbols / accounts and other hosts are refused outright. */
export function assertConfig(cfg: { tradeHost: string; feedUrl: string; tenant: string; symbols: string[]; accounts: Record<string, unknown> }): void {
  if (cfg.tradeHost !== TRADE_HOST) throw new GuardRefused(`config tradeHost ${cfg.tradeHost} refused (only ${TRADE_HOST})`);
  if (cfg.feedUrl !== FEED_URL) throw new GuardRefused(`config feedUrl ${cfg.feedUrl} refused (only ${FEED_URL})`);
  if (cfg.tenant !== TENANT) throw new GuardRefused(`config tenant ${cfg.tenant} refused (only ${TENANT})`);
  for (const s of cfg.symbols) assertSymbol(s);
  for (const a of Object.keys(cfg.accounts)) assertAccount(a);
}

/** The broker's coverage (auto-hedge) account: never a trade account; the read-only observer may read its positions. */
export const COVERAGE_ACCOUNT = "49990099";
/** Every request the read-only staff observer may send (src/observer.ts): sign-in, the 2FA step, one read. */
export const OBSERVER_REQUESTS = ["POST /api/manage/login", "POST /api/manage/login/verify-2fa", `GET /api/manage/accounts/${COVERAGE_ACCOUNT}/positions`] as const;
export function assertObserverRequest(method: string, url: string): void {
  const u = new URL(url);
  const key = `${method.toUpperCase()} ${u.pathname}`;
  if (u.origin !== TRADE_HOST || u.search || !(OBSERVER_REQUESTS as readonly string[]).includes(key)) throw new GuardRefused(`observer request ${key} to ${u.origin} refused`);
}
