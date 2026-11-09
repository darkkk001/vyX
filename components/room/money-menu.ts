// Pure rules of the top-bar money menu (owner 2026-11-10), shared by the menu and the tests. No React, no money math:
// every figure is the server's (GET /api/room/money).

export type MoneyLine = { id: string | null; accountNumber: string | null; balance: string; currency: string; usd: string | null };
export type RoomMoney = { currency: "USD"; overall: string; partial: boolean; accounts: MoneyLine[]; wallet: MoneyLine; partner: MoneyLine | null };

/** What a row is: "overall", "wallet", "partner" or a trading account's id. */
export type MoneyKey = string;
export const OVERALL = "overall", WALLET = "wallet", PARTNER = "partner";

export type MoneyRow = { key: MoneyKey; label: string; amount: string; currency: string; number: string | null; href: string };

/** The menu's rows in order: Overall, each live trading account, Funding wallet, Partner wallet (an IB only). */
export function moneyRows(m: RoomMoney): MoneyRow[] {
  return [
    { key: OVERALL, label: "Overall", amount: m.overall, currency: m.currency, number: null, href: "/room/accounts" },
    ...m.accounts.map((a) => ({ key: a.id ?? a.accountNumber ?? "", label: "Trading account", amount: a.balance, currency: a.currency, number: a.accountNumber, href: `/room/accounts#acct-${a.accountNumber}` })),
    { key: WALLET, label: "Funding wallet", amount: m.wallet.balance, currency: m.wallet.currency, number: m.wallet.accountNumber, href: "/room/wallet" },
    ...(m.partner ? [{ key: PARTNER, label: "Partner wallet", amount: m.partner.balance, currency: m.partner.currency, number: m.partner.accountNumber, href: "/room/partner" }] : []),
  ];
}

/** The row the top bar shows: the client's pick while it still exists, else Overall. */
export function pickedRow(m: RoomMoney, pick: MoneyKey | null): MoneyRow {
  const rows = moneyRows(m);
  return rows.find((r) => r.key === pick) ?? rows[0];
}

/** "1,234.56", or **** while the balance is hidden. */
export function shown(amount: string, hidden: boolean, format: (s: string) => string): string {
  return hidden ? "****" : format(amount);
}

/** Per-client keys of what the menu remembers in this browser. */
export const storeKey = (what: "hide" | "pick" | "walletInfo", clientId: string) => `room_money_${what}:${clientId}`;
export function readStore(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writeStore(key: string, value: string | null) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage blocked: kept for this visit only */ }
}
